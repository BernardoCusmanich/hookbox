import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { handleDelivery, type DeliveryDeps, type DeliveryRow, type LoadedRequest } from "@/lib/deliver";
import type { DeliveryOutcome } from "@/lib/forward";
import { ForwardUrlError } from "@/lib/ssrf";

const REQUEST_ID = "2f1d6a52-9d2e-4c52-8a55-1d3b6f0e9a11";
const ORG_ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const RAW = JSON.stringify({ requestId: REQUEST_ID });

type SendParams = Parameters<DeliveryDeps["sendForward"]>[0];

function loaded(overrides: Partial<LoadedRequest> = {}): LoadedRequest {
  return {
    id: REQUEST_ID,
    org_id: ORG_ID,
    method: "POST",
    headers: { "content-type": "application/json", host: "hookbox.test" },
    body: '{"a":1}',
    body_encoding: "utf8",
    endpoints: { forward_url: "https://destino.example/hook", forward_enabled: true },
    organizations: { is_demo: false },
    ...overrides,
  };
}

function setup(options: {
  signatureValid?: boolean;
  loadResult?: Awaited<ReturnType<DeliveryDeps["loadRequest"]>>;
  validate?: (url: string) => Promise<URL>;
  outcome?: DeliveryOutcome & { durationMs: number };
} = {}) {
  const calls = {
    verify: 0,
    load: [] as string[],
    records: [] as DeliveryRow[],
    validated: [] as string[],
    sends: [] as SendParams[],
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
    const { calls, deps } = setup({ loadResult: { data: loaded({ organizations: { is_demo: true } }), error: null } });
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
    const { calls, deps } = setup({ loadResult: { data: loaded({ organizations: { is_demo: true } }), error: null } });
    await handleDelivery(input({ retried: "2" }), deps);
    assert.equal(calls.records[0].attempt, 3);

    const lixo = setup();
    await handleDelivery(input({ retried: "abc" }), lixo.deps);
    assert.equal(lixo.calls.records[0].attempt, 1);
  });

  it("encaminhamento desligado: 200 sem gravar nem enviar", async () => {
    const endpoints = { forward_url: "https://destino.example/hook", forward_enabled: false };
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
});
