import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FailureInfo } from "@/lib/alerts";
import { handleDelivery, MAX_RETRIES, type DeliveryDeps, type DeliveryRow, type LoadedRequest } from "@/lib/deliver";
import type { DeliveryOutcome } from "@/lib/forward";
import { ForwardUrlError } from "@/lib/ssrf";

const REQUEST_ID = "2f1d6a52-9d2e-4c52-8a55-1d3b6f0e9a11";
const ORG_ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const ENDPOINT_ID = "0b6f3c1e-1f2a-4d3b-9c4d-5e6f7a8b9c0d";
const ENDPOINT = { id: ENDPOINT_ID, name: "Pagamentos" };
const RAW = JSON.stringify({ requestId: REQUEST_ID });

type SendParams = Parameters<DeliveryDeps["sendForward"]>[0];

function loaded(overrides: Partial<LoadedRequest> = {}): LoadedRequest {
  return {
    id: REQUEST_ID,
    org_id: ORG_ID,
    method: "POST",
    headers: { "content-type": "application/json", host: "hookbox.test" },
    query: {},
    body: '{"a":1}',
    body_encoding: "utf8",
    endpoints: { ...ENDPOINT, forward_url: "https://destino.example/hook", forward_enabled: true, transform_template: null },
    organizations: { slug: "acme", is_demo: false },
    ...overrides,
  };
}

function setup(options: {
  signatureValid?: boolean;
  loadResult?: Awaited<ReturnType<DeliveryDeps["loadRequest"]>>;
  validate?: (url: string) => Promise<URL>;
  outcome?: DeliveryOutcome & { durationMs: number };
  notifyError?: Error;
} = {}) {
  const calls = {
    verify: 0,
    load: [] as string[],
    records: [] as DeliveryRow[],
    validated: [] as string[],
    sends: [] as SendParams[],
    alerts: [] as FailureInfo[],
  };
  const deps: DeliveryDeps = {
    async verifySignature() {
      calls.verify++;
      return options.signatureValid ?? true;
    },
    async loadRequest(requestId) {
      calls.load.push(requestId);
      return options.loadResult ?? { data: loaded(), error: null };
    },
    async recordDelivery(row) {
      calls.records.push(row);
    },
    async validateForwardUrl(url) {
      calls.validated.push(url);
      return options.validate ? options.validate(url) : new URL(url);
    },
    async sendForward(params) {
      calls.sends.push(params);
      return options.outcome ?? { kind: "success", statusCode: 200, durationMs: 12 };
    },
    async notifyFailure(info) {
      calls.alerts.push(info);
      if (options.notifyError) throw options.notifyError;
    },
  };
  return { calls, deps };
}

const input = (over: Partial<{ rawBody: string; signature: string | null; retried: string | null }> = {}) => ({
  rawBody: RAW,
  signature: "sig",
  retried: null,
  ...over,
});

describe("handleDelivery", () => {
  it("sem assinatura: 401 e não carrega nada", async () => {
    const { calls, deps } = setup();
    const res = await handleDelivery(input({ signature: null }), deps);
    assert.deepEqual(res, { status: 401, body: { ok: false } });
    assert.equal(calls.verify, 0);
    assert.equal(calls.load.length, 0);
  });

  it("assinatura inválida: 401 e não carrega nada", async () => {
    const { calls, deps } = setup({ signatureValid: false });
    const res = await handleDelivery(input(), deps);
    assert.deepEqual(res, { status: 401, body: { ok: false } });
    assert.equal(calls.verify, 1);
    assert.equal(calls.load.length, 0);
  });

  it("payload malformado: 200 'payload inválido' sem carregar", async () => {
    for (const rawBody of ["{não é json", JSON.stringify({ requestId: "não-é-uuid" })]) {
      const { calls, deps } = setup();
      const res = await handleDelivery(input({ rawBody }), deps);
      assert.deepEqual(res, { status: 200, body: { ok: true, message: "payload inválido" } });
      assert.equal(calls.load.length, 0);
    }
  });

  it("erro ao carregar a requisição: 500", async () => {
    const { calls, deps } = setup({ loadResult: { data: null, error: { code: "XX000" } } });
    const original = console.error;
    console.error = () => {};
    try {
      const res = await handleDelivery(input(), deps);
      assert.deepEqual(res, { status: 500, body: { ok: false } });
    } finally {
      console.error = original;
    }
    assert.deepEqual(calls.load, [REQUEST_ID]);
    assert.equal(calls.records.length, 0);
    assert.equal(calls.sends.length, 0);
  });

  it("requisição inexistente: 200 sem gravar nem enviar", async () => {
    const { calls, deps } = setup({ loadResult: { data: null, error: null } });
    const res = await handleDelivery(input(), deps);
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(calls.records.length, 0);
    assert.equal(calls.sends.length, 0);
  });

  it("org demo: registra 'desativado' e não envia, mesmo com encaminhamento ligado", async () => {
    const { calls, deps } = setup({ loadResult: { data: loaded({ organizations: { slug: "demo", is_demo: true } }), error: null } });
    const res = await handleDelivery(input(), deps);
    assert.deepEqual(res, { status: 200, body: { ok: true, message: "encaminhamento desativado na demo" } });
    assert.deepEqual(calls.records, [
      {
        request_id: REQUEST_ID,
        org_id: ORG_ID,
        attempt: 1,
        status_code: null,
        error: "Encaminhamento desativado na demo.",
        duration_ms: null,
      },
    ]);
    assert.equal(calls.validated.length, 0);
    assert.equal(calls.sends.length, 0);
  });

  it("attempt vem do header upstash-retried", async () => {
    const { calls, deps } = setup({ loadResult: { data: loaded({ organizations: { slug: "demo", is_demo: true } }), error: null } });
    await handleDelivery(input({ retried: "2" }), deps);
    assert.equal(calls.records[0].attempt, 3);

    const lixo = setup();
    await handleDelivery(input({ retried: "abc" }), lixo.deps);
    assert.equal(lixo.calls.records[0].attempt, 1);
  });

  it("encaminhamento desligado: 200 sem gravar nem enviar", async () => {
    const endpoints = { ...ENDPOINT, forward_url: "https://destino.example/hook", forward_enabled: false, transform_template: null };
    const { calls, deps } = setup({ loadResult: { data: loaded({ endpoints }), error: null } });
    const res = await handleDelivery(input(), deps);
    assert.deepEqual(res, {
      status: 200,
      body: { ok: true, message: "encaminhamento desligado ou endpoint removido" },
    });
    assert.equal(calls.records.length, 0);
    assert.equal(calls.sends.length, 0);
  });

  it("URL recusada pelo SSRF: grava a mensagem e não envia", async () => {
    const { calls, deps } = setup({
      validate: async () => {
        throw new ForwardUrlError("x");
      },
    });
    const res = await handleDelivery(input(), deps);
    assert.deepEqual(res, { status: 200, body: { ok: true, message: "url recusada" } });
    assert.equal(calls.records.length, 1);
    assert.equal(calls.records[0].error, "x");
    assert.equal(calls.records[0].status_code, null);
    assert.equal(calls.sends.length, 0);
  });

  it("erro inesperado na validação usa a mensagem genérica", async () => {
    const { calls, deps } = setup({
      validate: async () => {
        throw new Error("boom");
      },
    });
    const res = await handleDelivery(input(), deps);
    assert.equal(res.body.message, "url recusada");
    assert.equal(calls.records[0].error, "URL de encaminhamento inválida.");
  });

  it("sucesso: envia sem headers sensíveis e grava 200 sem erro", async () => {
    const { calls, deps } = setup();
    const res = await handleDelivery(input(), deps);
    assert.deepEqual(res, { status: 200, body: { ok: true, message: "success" } });
    assert.equal(calls.sends.length, 1);
    assert.equal(calls.sends[0].url.href, "https://destino.example/hook");
    assert.equal(calls.sends[0].method, "POST");
    assert.equal(calls.sends[0].body, '{"a":1}');
    assert.equal(calls.sends[0].bodyEncoding, "utf8");
    assert.equal(calls.sends[0].headers["x-hookbox-request-id"], REQUEST_ID);
    assert.equal(calls.sends[0].headers.host, undefined);
    assert.deepEqual(calls.records, [
      { request_id: REQUEST_ID, org_id: ORG_ID, attempt: 1, status_code: 200, error: null, duration_ms: 12 },
    ]);
  });

  it("falha permanente: grava o erro e responde 200", async () => {
    const { calls, deps } = setup({
      outcome: { kind: "permanent", statusCode: 404, error: "Destino respondeu 404.", durationMs: 30 },
    });
    const res = await handleDelivery(input(), deps);
    assert.deepEqual(res, { status: 200, body: { ok: true, message: "permanent" } });
    assert.equal(calls.records[0].status_code, 404);
    assert.equal(calls.records[0].error, "Destino respondeu 404.");
  });

  it("retry: grava a tentativa e responde 500 para o QStash tentar de novo", async () => {
    const { calls, deps } = setup({
      outcome: { kind: "retry", statusCode: 503, error: "Destino respondeu 503.", durationMs: 40 },
    });
    const res = await handleDelivery(input({ retried: "1" }), deps);
    assert.deepEqual(res, { status: 500, body: { ok: false, retry: true } });
    assert.deepEqual(calls.records, [
      {
        request_id: REQUEST_ID,
        org_id: ORG_ID,
        attempt: 2,
        status_code: 503,
        error: "Destino respondeu 503.",
        duration_ms: 40,
      },
    ]);
  });

  it("corta o erro gravado em 500 caracteres", async () => {
    const { calls, deps } = setup({
      outcome: { kind: "retry", statusCode: null, error: "e".repeat(800), durationMs: 1 },
    });
    await handleDelivery(input(), deps);
    assert.equal(calls.records[0].error?.length, 500);
  });

  describe("alerta de falha definitiva", () => {
    const retry = { kind: "retry" as const, statusCode: 503, error: "Destino respondeu 503.", durationMs: 40 };

    it("sucesso não alerta", async () => {
      const { calls, deps } = setup();
      await handleDelivery(input(), deps);
      assert.equal(calls.alerts.length, 0);
    });

    it("retry com tentativas sobrando não alerta", async () => {
      const { calls, deps } = setup({ outcome: retry });
      const res = await handleDelivery(input({ retried: String(MAX_RETRIES - 1) }), deps);
      assert.equal(res.status, 500);
      assert.equal(calls.alerts.length, 0);
    });

    it("última tentativa com retry: responde 200 (sem mais retry) e alerta", async () => {
      const { calls, deps } = setup({ outcome: retry });
      const res = await handleDelivery(input({ retried: String(MAX_RETRIES) }), deps);
      assert.deepEqual(res, { status: 200, body: { ok: true, message: "retries esgotados" } });
      assert.equal(calls.records.length, 1);
      assert.deepEqual(calls.alerts, [
        {
          orgId: ORG_ID,
          orgSlug: "acme",
          endpointId: ENDPOINT_ID,
          endpointName: "Pagamentos",
          requestId: REQUEST_ID,
          attempt: MAX_RETRIES + 1,
          statusCode: 503,
          error: "Destino respondeu 503.",
        },
      ]);
    });

    it("falha permanente alerta já na primeira tentativa", async () => {
      const { calls, deps } = setup({
        outcome: { kind: "permanent", statusCode: 404, error: "Destino respondeu 404.", durationMs: 30 },
      });
      await handleDelivery(input(), deps);
      assert.equal(calls.alerts.length, 1);
      assert.equal(calls.alerts[0].attempt, 1);
      assert.equal(calls.alerts[0].statusCode, 404);
    });

    it("URL recusada pelo SSRF alerta", async () => {
      const { calls, deps } = setup({
        validate: async () => {
          throw new ForwardUrlError("Destino é um endereço bloqueado.");
        },
      });
      await handleDelivery(input(), deps);
      assert.equal(calls.alerts.length, 1);
      assert.equal(calls.alerts[0].statusCode, null);
      assert.equal(calls.alerts[0].error, "Destino é um endereço bloqueado.");
    });

    it("org demo e encaminhamento desligado não alertam", async () => {
      const demo = setup({ loadResult: { data: loaded({ organizations: { slug: "demo", is_demo: true } }), error: null } });
      await handleDelivery(input(), demo.deps);
      const off = setup({
        loadResult: { data: loaded({ endpoints: { ...ENDPOINT, forward_url: null, forward_enabled: false, transform_template: null } }), error: null },
      });
      await handleDelivery(input(), off.deps);
      assert.equal(demo.calls.alerts.length + off.calls.alerts.length, 0);
    });

    it("erro no alerta não muda a resposta ao QStash", async () => {
      const { calls, deps } = setup({ outcome: retry, notifyError: new Error("resend fora") });
      const res = await handleDelivery(input({ retried: String(MAX_RETRIES) }), deps);
      assert.deepEqual(res, { status: 200, body: { ok: true, message: "retries esgotados" } });
      assert.equal(calls.alerts.length, 1);
    });
  });

  describe("transformação de payload", () => {
    const withTemplate = (transform_template: string | null, over: Partial<LoadedRequest> = {}) =>
      loaded({
        endpoints: { ...ENDPOINT, forward_url: "https://destino.example/hook", forward_enabled: true, transform_template },
        headers: { "content-type": "text/plain", "content-encoding": "gzip", "x-github-event": "push", host: "hookbox.test" },
        query: { id: "42" },
        body: '{"id":7,"status":"pago"}',
        ...over,
      });

    it("aplica o template: envia o JSON gerado com content-type application/json", async () => {
      const template = '{"text":"Pedido {{ body.id }}: {{ body.status }}","evento":"{{ headers.x-github-event }}","q":"{{ query.id }}"}';
      const { calls, deps } = setup({ loadResult: { data: withTemplate(template), error: null } });
      const res = await handleDelivery(input(), deps);
      assert.deepEqual(res, { status: 200, body: { ok: true, message: "success" } });
      assert.equal(calls.sends.length, 1);
      assert.equal(calls.sends[0].body, '{"text":"Pedido 7: pago","evento":"push","q":"42"}');
      assert.equal(calls.sends[0].bodyEncoding, "utf8");
      assert.equal(calls.sends[0].headers["content-type"], "application/json");
      assert.equal(calls.sends[0].headers["content-encoding"], undefined);
      assert.equal(calls.sends[0].headers["x-github-event"], "push");
      assert.equal(calls.sends[0].headers["x-hookbox-request-id"], REQUEST_ID);
      assert.equal(calls.records[0].status_code, 200);
      assert.equal(calls.alerts.length, 0);
    });

    it("corpo base64 vira utf8 com o resultado do template", async () => {
      const { calls, deps } = setup({
        loadResult: { data: withTemplate('{"b":"{{ body }}","m":"{{ method }}"}', { body: "AAEC", body_encoding: "base64" }), error: null },
      });
      await handleDelivery(input(), deps);
      assert.equal(calls.sends[0].body, '{"b":null,"m":"POST"}');
      assert.equal(calls.sends[0].bodyEncoding, "utf8");
    });

    it("template com erro: grava, alerta e não envia", async () => {
      // Resultado acima de 256 KB: só falha na hora de aplicar (o template em si é válido).
      const big = JSON.stringify({ big: "x".repeat(200 * 1024) });
      const { calls, deps } = setup({
        loadResult: {
          data: withTemplate('{"a":"{{ body.big }}","b":"{{ body.big }}"}', { body: big, body_encoding: "utf8" }),
          error: null,
        },
      });
      const res = await handleDelivery(input(), deps);
      assert.deepEqual(res, { status: 200, body: { ok: true, message: "transformação falhou" } });
      assert.equal(calls.sends.length, 0);
      assert.deepEqual(calls.records, [
        {
          request_id: REQUEST_ID,
          org_id: ORG_ID,
          attempt: 1,
          status_code: null,
          error: "Transformação: O resultado da transformação passa de 256 KB.",
          duration_ms: null,
        },
      ]);
      assert.equal(calls.alerts.length, 1);
      assert.equal(calls.alerts[0].statusCode, null);
      assert.equal(calls.alerts[0].error, "Transformação: O resultado da transformação passa de 256 KB.");
    });

    it("template inválido salvo no banco também falha sem enviar", async () => {
      const { calls, deps } = setup({ loadResult: { data: withTemplate("{ quebrado"), error: null } });
      const res = await handleDelivery(input({ retried: "1" }), deps);
      assert.equal(res.body.message, "transformação falhou");
      assert.equal(calls.sends.length, 0);
      assert.equal(calls.records[0].error, "Transformação: O template não é um JSON válido.");
      assert.equal(calls.records[0].attempt, 2);
      assert.equal(calls.alerts.length, 1);
    });

    it("sem template (null ou vazio) mantém o corpo e os headers originais", async () => {
      for (const template of [null, ""]) {
        const { calls, deps } = setup({ loadResult: { data: withTemplate(template), error: null } });
        await handleDelivery(input(), deps);
        assert.equal(calls.sends[0].body, '{"id":7,"status":"pago"}');
        assert.equal(calls.sends[0].headers["content-type"], "text/plain");
        assert.equal(calls.sends[0].headers["content-encoding"], "gzip");
      }
    });

    it("org demo não transforma nem envia", async () => {
      const data = withTemplate('{"a":1}', { organizations: { slug: "demo", is_demo: true } });
      const { calls, deps } = setup({ loadResult: { data, error: null } });
      await handleDelivery(input(), deps);
      assert.equal(calls.sends.length, 0);
    });
  });
});
