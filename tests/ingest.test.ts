import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { MAX_BODY_BYTES, REDACTED } from "@/lib/ingest";
import { handleIngest, type IngestDeps, type IngestEndpoint, type IngestRow } from "@/lib/ingest-handler";
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, computeSignature } from "@/lib/signature";

const SLUG = "abcdefghij12";
const ENDPOINT_ID = "2f1d6a52-9d2e-4c52-8a55-1d3b6f0e9a11";
const ORG_ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const REQUEST_ID = "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d";
const SECRET = "segredo-de-teste";
const enc = new TextEncoder();

function endpoint(overrides: Partial<IngestEndpoint> = {}): IngestEndpoint {
  return { id: ENDPOINT_ID, org_id: ORG_ID, secret_ciphertext: null, forward_enabled: false, ...overrides };
}

function setup(options: {
  limit?: IngestDeps["limit"];
  findResult?: Awaited<ReturnType<IngestDeps["findEndpoint"]>>;
  decrypt?: (ciphertext: string) => string;
  insertResult?: Awaited<ReturnType<IngestDeps["insertRequest"]>>;
  enqueue?: (requestId: string) => Promise<void>;
} = {}) {
  const calls = {
    limits: [] as { slug: string; ip: string | null }[],
    finds: [] as string[],
    decrypts: [] as string[],
    inserts: [] as IngestRow[],
    enqueues: [] as string[],
    bodyReads: 0,
  };
  const deps: IngestDeps = {
    async limit(slug, ip) {
      calls.limits.push({ slug, ip });
      return options.limit ? options.limit(slug, ip) : [{ success: true, reset: 0 }];
    },
    async findEndpoint(slug) {
      calls.finds.push(slug);
      return options.findResult ?? { data: endpoint(), error: null };
    },
    decryptSecret(ciphertext) {
      calls.decrypts.push(ciphertext);
      return options.decrypt ? options.decrypt(ciphertext) : SECRET;
    },
    async insertRequest(row) {
      calls.inserts.push(row);
      return options.insertResult ?? { data: { id: REQUEST_ID }, error: null };
    },
    async enqueueDelivery(requestId) {
      calls.enqueues.push(requestId);
      if (options.enqueue) await options.enqueue(requestId);
    },
  };
  return { deps, calls };
}

function run(
  deps: IngestDeps,
  calls: { bodyReads: number },
  overrides: { slug?: string; method?: string; url?: string; headers?: Record<string, string>; body?: Uint8Array } = {},
) {
  const slug = overrides.slug ?? SLUG;
  return handleIngest(
    {
      method: overrides.method ?? "POST",
      slug,
      url: overrides.url ?? `https://hookbox.test/in/${slug}`,
      headers: new Headers(overrides.headers ?? {}),
      async readBody() {
        calls.bodyReads++;
        return overrides.body ?? enc.encode('{"a":1}');
      },
    },
    deps,
  );
}

describe("handleIngest", () => {
  let errorMock: ReturnType<typeof mock.method>;
  beforeEach(() => {
    errorMock = mock.method(console, "error", () => {});
  });
  afterEach(() => {
    errorMock.mock.restore();
  });

  describe("rate limit", () => {
    it("responde 429 com Retry-After quando um limite falha", async () => {
      const reset = Date.now() + 30_000;
      const { deps, calls } = setup({
        limit: async () => [
          { success: true, reset: 0 },
          { success: false, reset },
        ],
      });
      const res = await run(deps, calls);
      assert.equal(res.status, 429);
      assert.deepEqual(res.body, { ok: false, error: "rate_limited" });
      const retryAfter = Number(res.headers?.["Retry-After"]);
      assert.ok(retryAfter >= 29 && retryAfter <= 30, `Retry-After inesperado: ${retryAfter}`);
      assert.equal(calls.finds.length, 0);
      assert.equal(calls.inserts.length, 0);
    });

    it("Retry-After é no mínimo 1 segundo", async () => {
      const { deps, calls } = setup({ limit: async () => [{ success: false, reset: 0 }] });
      const res = await run(deps, calls);
      assert.equal(res.status, 429);
      assert.equal(res.headers?.["Retry-After"], "1");
    });

    it("passa slug e IP para o limitador", async () => {
      const { deps, calls } = setup();
      await run(deps, calls, { headers: { "x-forwarded-for": "203.0.113.9" } });
      assert.deepEqual(calls.limits, [{ slug: SLUG, ip: "203.0.113.9" }]);
    });

    it("segue e grava quando o limitador lança (fail-open)", async () => {
      const { deps, calls } = setup({
        limit: async () => {
          throw new Error("redis fora do ar");
        },
      });
      const res = await run(deps, calls);
      assert.equal(res.status, 200);
      assert.equal(calls.inserts.length, 1);
    });
  });

  describe("endpoint", () => {
    it("slug fora do formato → 404 sem consultar o endpoint", async () => {
      const { deps, calls } = setup();
      const res = await run(deps, calls, { slug: "ABC" });
      assert.equal(res.status, 404);
      assert.deepEqual(res.body, { ok: false, error: "not_found" });
      assert.equal(calls.finds.length, 0);
      assert.equal(calls.bodyReads, 0);
    });

    it("endpoint inexistente → 404", async () => {
      const { deps, calls } = setup({ findResult: { data: null, error: null } });
      const res = await run(deps, calls);
      assert.equal(res.status, 404);
      assert.deepEqual(res.body, { ok: false, error: "not_found" });
      assert.deepEqual(calls.finds, [SLUG]);
      assert.equal(calls.inserts.length, 0);
    });

    it("erro ao buscar o endpoint → 500", async () => {
      const { deps, calls } = setup({ findResult: { data: null, error: { code: "XX000" } } });
      const res = await run(deps, calls);
      assert.equal(res.status, 500);
      assert.deepEqual(res.body, { ok: false, error: "internal_error" });
      assert.equal(calls.inserts.length, 0);
    });
  });

  describe("corpo", () => {
    it("content-length declarado acima do limite → 413 sem ler o corpo", async () => {
      const { deps, calls } = setup();
      const res = await run(deps, calls, { headers: { "content-length": String(MAX_BODY_BYTES + 1) } });
      assert.equal(res.status, 413);
      assert.deepEqual(res.body, { ok: false, error: "payload_too_large" });
      assert.equal(calls.bodyReads, 0);
      assert.equal(calls.inserts.length, 0);
    });

    it("corpo real acima do limite sem content-length → 413 sem gravar", async () => {
      const { deps, calls } = setup();
      const res = await run(deps, calls, { body: new Uint8Array(MAX_BODY_BYTES + 1).fill(97) });
      assert.equal(res.status, 413);
      assert.equal(calls.bodyReads, 1);
      assert.equal(calls.inserts.length, 0);
    });

    it("corpo exatamente no limite é aceito", async () => {
      const { deps, calls } = setup();
      const res = await run(deps, calls, {
        headers: { "content-length": String(MAX_BODY_BYTES) },
        body: new Uint8Array(MAX_BODY_BYTES).fill(97),
      });
      assert.equal(res.status, 200);
      assert.equal(calls.inserts[0].size_bytes, MAX_BODY_BYTES);
    });

    it("corpo UTF-8 é gravado como texto", async () => {
      const { deps, calls } = setup();
      await run(deps, calls, { body: enc.encode('{"a":"ç"}'), headers: { "content-type": "application/json" } });
      const row = calls.inserts[0];
      assert.equal(row.body, '{"a":"ç"}');
      assert.equal(row.body_encoding, "utf8");
      assert.equal(row.content_type, "application/json");
      assert.equal(row.size_bytes, enc.encode('{"a":"ç"}').byteLength);
    });

    it("corpo que não é UTF-8 é gravado em base64", async () => {
      const { deps, calls } = setup();
      const bytes = new Uint8Array([0xff, 0xfe, 0x00, 0x80]);
      await run(deps, calls, { body: bytes });
      const row = calls.inserts[0];
      assert.equal(row.body_encoding, "base64");
      assert.equal(row.body, Buffer.from(bytes).toString("base64"));
      assert.equal(row.size_bytes, bytes.byteLength);
    });
  });

  describe("assinatura", () => {
    const body = enc.encode('{"evento":"x"}');
    const now = () => String(Math.floor(Date.now() / 1000));
    const withSecret = { findResult: { data: endpoint({ secret_ciphertext: "cifrado" }), error: null } };

    it("sem segredo → not_configured", async () => {
      const { deps, calls } = setup();
      await run(deps, calls, { body });
      assert.equal(calls.inserts[0].signature_status, "not_configured");
      assert.equal(calls.decrypts.length, 0);
    });

    it("assinatura válida → valid", async () => {
      const { deps, calls } = setup(withSecret);
      const timestamp = now();
      await run(deps, calls, {
        body,
        headers: {
          [TIMESTAMP_HEADER]: timestamp,
          [SIGNATURE_HEADER]: computeSignature(SECRET, timestamp, body),
        },
      });
      assert.deepEqual(calls.decrypts, ["cifrado"]);
      assert.equal(calls.inserts[0].signature_status, "valid");
    });

    it("assinatura errada → invalid", async () => {
      const { deps, calls } = setup(withSecret);
      const timestamp = now();
      await run(deps, calls, {
        body,
        headers: {
          [TIMESTAMP_HEADER]: timestamp,
          [SIGNATURE_HEADER]: computeSignature("outro-segredo", timestamp, body),
        },
      });
      assert.equal(calls.inserts[0].signature_status, "invalid");
    });

    it("sem headers de assinatura → missing", async () => {
      const { deps, calls } = setup(withSecret);
      await run(deps, calls, { body });
      assert.equal(calls.inserts[0].signature_status, "missing");
    });

    it("decrypt que lança → invalid (e grava mesmo assim)", async () => {
      const { deps, calls } = setup({
        ...withSecret,
        decrypt: () => {
          throw new Error("chave errada");
        },
      });
      const timestamp = now();
      const res = await run(deps, calls, {
        body,
        headers: {
          [TIMESTAMP_HEADER]: timestamp,
          [SIGNATURE_HEADER]: computeSignature(SECRET, timestamp, body),
        },
      });
      assert.equal(res.status, 200);
      assert.equal(calls.inserts[0].signature_status, "invalid");
    });
  });

  describe("gravação", () => {
    it("grava os campos do endpoint, método, path e IP", async () => {
      const { deps, calls } = setup();
      await run(deps, calls, {
        method: "PUT",
        headers: { "x-forwarded-for": "203.0.113.9, 10.0.0.1" },
      });
      const row = calls.inserts[0];
      assert.equal(row.endpoint_id, ENDPOINT_ID);
      assert.equal(row.org_id, ORG_ID);
      assert.equal(row.method, "PUT");
      assert.equal(row.path, `/in/${SLUG}`);
      assert.equal(row.ip, "203.0.113.9");
    });

    it("ip é null sem cabeçalho de IP", async () => {
      const { deps, calls } = setup();
      await run(deps, calls);
      assert.equal(calls.inserts[0].ip, null);
    });

    it("redige headers sensíveis e descarta x-vercel-* (headers e query)", async () => {
      const { deps, calls } = setup();
      await run(deps, calls, {
        url: `https://hookbox.test/in/${SLUG}?x-vercel-protection-bypass=s&id=1`,
        headers: {
          Authorization: "Bearer abc",
          Cookie: "sid=1",
          "X-Api-Key": "k",
          "Proxy-Authorization": "p",
          "x-vercel-oidc-token": "token",
          "x-vercel-id": "gru1::abc",
          "X-Custom": "ok",
        },
      });
      const row = calls.inserts[0];
      assert.deepEqual(row.headers, {
        authorization: REDACTED,
        cookie: REDACTED,
        "x-api-key": REDACTED,
        "proxy-authorization": REDACTED,
        "x-custom": "ok",
      });
      assert.deepEqual(row.query, { id: "1" });
    });

    it("erro no insert → 500 e não enfileira", async () => {
      const { deps, calls } = setup({
        findResult: { data: endpoint({ forward_enabled: true }), error: null },
        insertResult: { data: null, error: { code: "23503" } },
      });
      const res = await run(deps, calls);
      assert.equal(res.status, 500);
      assert.deepEqual(res.body, { ok: false, error: "internal_error" });
      assert.equal(calls.enqueues.length, 0);
    });

    it("insert sem erro mas sem dado → 500", async () => {
      const { deps, calls } = setup({ insertResult: { data: null, error: null } });
      const res = await run(deps, calls);
      assert.equal(res.status, 500);
    });

    it("sucesso → 200 {ok:true,id}", async () => {
      const { deps, calls } = setup();
      const res = await run(deps, calls);
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { ok: true, id: REQUEST_ID });
      assert.equal(res.headers, undefined);
    });
  });

  describe("encaminhamento", () => {
    const forwarding = { findResult: { data: endpoint({ forward_enabled: true }), error: null } };

    it("forward desligado → não enfileira", async () => {
      const { deps, calls } = setup();
      await run(deps, calls);
      assert.equal(calls.enqueues.length, 0);
    });

    it("forward_enabled → enfileira com o id gravado", async () => {
      const { deps, calls } = setup(forwarding);
      const res = await run(deps, calls);
      assert.equal(res.status, 200);
      assert.deepEqual(calls.enqueues, [REQUEST_ID]);
    });

    it("x-hookbox-request-id → grava mas não enfileira", async () => {
      const { deps, calls } = setup(forwarding);
      const res = await run(deps, calls, { headers: { "x-hookbox-request-id": REQUEST_ID } });
      assert.equal(res.status, 200);
      assert.equal(calls.inserts.length, 1);
      assert.equal(calls.enqueues.length, 0);
    });

    it("enqueue que lança → ainda 200", async () => {
      const { deps, calls } = setup({
        ...forwarding,
        enqueue: async () => {
          throw new Error("qstash fora do ar");
        },
      });
      const res = await run(deps, calls);
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { ok: true, id: REQUEST_ID });
      assert.deepEqual(calls.enqueues, [REQUEST_ID]);
    });
  });
});
