import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { generateApiKey, hashApiKey } from "@/lib/api-keys";
import {
  handleGetRequest,
  handleListEndpoints,
  handleListRequests,
  handleResend,
  type ApiDeps,
  type EndpointItem,
  type RequestDetail,
  type RequestSummary,
} from "@/lib/api/v1";

const ORG_ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const OTHER_ORG_ID = "9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d";
const KEY_ID = "11111111-1111-4111-8111-111111111111";
const ENDPOINT_ID = "0b6f3c1e-1f2a-4d3b-9c4d-5e6f7a8b9c0d";
const REQUEST_ID = "2f1d6a52-9d2e-4c52-8a55-1d3b6f0e9a11";
const APP_URL = "https://hookbox.test";

const { key: KEY } = generateApiKey();
const AUTH = `Bearer ${KEY}`;

function endpoint(overrides: Partial<EndpointItem> = {}): EndpointItem {
  return {
    id: ENDPOINT_ID,
    name: "Pagamentos",
    slug: "abcdefghijkl",
    forward_enabled: false,
    forward_url: null,
    transform_template: null,
    created_at: "2026-11-12T10:00:00+00:00",
    ...overrides,
  };
}

function summary(n: number): RequestSummary {
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    method: "POST",
    path: "/in/abcdefghijkl",
    query: {},
    content_type: "application/json",
    size_bytes: 10,
    signature_status: "not_configured",
    received_at: `2026-11-12T10:00:${String(60 - n).padStart(2, "0")}.123456+00:00`,
  };
}

function detail(): RequestDetail {
  return {
    ...summary(1),
    id: REQUEST_ID,
    endpoint_id: ENDPOINT_ID,
    headers: { "content-type": "application/json" },
    body: '{"a":1}',
    body_encoding: "utf8",
    ip: "203.0.113.7",
    deliveries: [{ attempt: 1, status_code: 200, error: null, duration_ms: 12, created_at: "2026-11-12T10:01:00+00:00" }],
  };
}

type Overrides = Partial<ApiDeps> & { knownHash?: string };

function setup(overrides: Overrides = {}) {
  const calls = {
    findKey: [] as string[],
    touch: [] as string[],
    limit: [] as string[],
    listEndpoints: [] as string[],
    listRequests: [] as { orgId: string; endpointId: string; limit: number; before: string | null }[],
    getRequest: [] as { orgId: string; requestId: string }[],
    enqueue: [] as string[],
  };
  const deps: ApiDeps = {
    async findKey(hash) {
      calls.findKey.push(hash);
      return hash === (overrides.knownHash ?? hashApiKey(KEY)) ? { id: KEY_ID, org_id: ORG_ID } : null;
    },
    async touchKey(id) {
      calls.touch.push(id);
    },
    async limit(keyId) {
      calls.limit.push(keyId);
      return { success: true, reset: Date.now() + 60_000 };
    },
    appUrl: APP_URL,
    async listEndpoints(orgId) {
      calls.listEndpoints.push(orgId);
      return [endpoint(), endpoint({ id: "x", slug: "mnopqrstuvwx", forward_enabled: true, forward_url: "https://x.test/h", transform_template: '{"a":1}' })];
    },
    async listRequests(orgId, endpointId, opts) {
      calls.listRequests.push({ orgId, endpointId, ...opts });
      if (endpointId !== ENDPOINT_ID || orgId !== ORG_ID) return null;
      return Array.from({ length: opts.limit }, (_, i) => summary(i + 1)).slice(0, 3);
    },
    async getRequest(orgId, requestId) {
      calls.getRequest.push({ orgId, requestId });
      return orgId === ORG_ID && requestId === REQUEST_ID ? detail() : null;
    },
    async getRequestForwarding(orgId, requestId) {
      if (orgId !== ORG_ID || requestId !== REQUEST_ID) return null;
      return { forward_enabled: true, forward_url: "https://destino.example/hook" };
    },
    async enqueueDelivery(requestId) {
      calls.enqueue.push(requestId);
    },
    ...overrides,
  };
  return { deps, calls };
}

const errorOf = (body: unknown) => (body as { error: { code: string; message: string } }).error;

describe("autenticação", () => {
  it("401 sem header, com WWW-Authenticate", async () => {
    const { deps, calls } = setup();
    const res = await handleListEndpoints({ authorization: null }, deps);
    assert.equal(res.status, 401);
    assert.equal(errorOf(res.body).code, "unauthorized");
    assert.equal(errorOf(res.body).message, "Chave de API ausente ou inválida.");
    assert.equal(res.headers?.["WWW-Authenticate"], "Bearer");
    assert.equal(calls.findKey.length, 0);
  });

  it("401 com header malformado sem consultar o banco", async () => {
    const { deps, calls } = setup();
    const res = await handleListEndpoints({ authorization: "Bearer abc" }, deps);
    assert.equal(res.status, 401);
    assert.equal(calls.findKey.length, 0);
  });

  it("401 com chave desconhecida", async () => {
    const { deps, calls } = setup();
    const other = generateApiKey().key;
    const res = await handleListEndpoints({ authorization: `Bearer ${other}` }, deps);
    assert.equal(res.status, 401);
    assert.equal(res.headers?.["WWW-Authenticate"], "Bearer");
    assert.deepEqual(calls.findKey, [hashApiKey(other)]);
    assert.equal(calls.touch.length, 0);
    assert.equal(calls.listEndpoints.length, 0);
  });

  it("procura a chave pelo hash, nunca pelo texto", async () => {
    const { deps, calls } = setup();
    await handleListEndpoints({ authorization: AUTH }, deps);
    assert.deepEqual(calls.findKey, [hashApiKey(KEY)]);
  });

  it("429 com Retry-After quando o limite estoura", async () => {
    const { deps, calls } = setup({ limit: async () => ({ success: false, reset: Date.now() + 30_000 }) });
    const res = await handleListEndpoints({ authorization: AUTH }, deps);
    assert.equal(res.status, 429);
    assert.equal(errorOf(res.body).code, "rate_limited");
    const retry = Number(res.headers?.["Retry-After"]);
    assert.ok(retry >= 29 && retry <= 31, `Retry-After inesperado: ${retry}`);
    assert.equal(calls.listEndpoints.length, 0);
  });

  it("Retry-After tem no mínimo 1 segundo", async () => {
    const { deps } = setup({ limit: async () => ({ success: false, reset: Date.now() - 5_000 }) });
    const res = await handleListEndpoints({ authorization: AUTH }, deps);
    assert.equal(res.headers?.["Retry-After"], "1");
  });

  it("limit é por chave", async () => {
    const { deps, calls } = setup();
    await handleListEndpoints({ authorization: AUTH }, deps);
    assert.deepEqual(calls.limit, [KEY_ID]);
  });

  it("limit que lança: segue (fail-open)", async () => {
    const { deps, calls } = setup({
      limit: async () => {
        throw new Error("redis fora");
      },
    });
    const res = await handleListEndpoints({ authorization: AUTH }, deps);
    assert.equal(res.status, 200);
    assert.equal(calls.listEndpoints.length, 1);
  });

  it("touchKey é chamado com o id da chave", async () => {
    const { deps, calls } = setup();
    await handleListEndpoints({ authorization: AUTH }, deps);
    assert.deepEqual(calls.touch, [KEY_ID]);
  });

  it("touchKey que falha (rejeita ou lança) não afeta a resposta", async () => {
    for (const touchKey of [
      async () => {
        throw new Error("db fora");
      },
      () => {
        throw new Error("síncrono");
      },
    ]) {
      const { deps } = setup({ touchKey });
      const res = await handleListEndpoints({ authorization: AUTH }, deps);
      assert.equal(res.status, 200);
    }
  });

  it("falha do banco vira 500 sem vazar detalhes", async () => {
    const { deps } = setup({
      listEndpoints: async () => {
        throw new Error("senha do banco: segredo");
      },
    });
    const res = await handleListEndpoints({ authorization: AUTH }, deps);
    assert.equal(res.status, 500);
    assert.equal(errorOf(res.body).code, "internal_error");
    assert.ok(!JSON.stringify(res.body).includes("segredo"));
  });
});

describe("GET /endpoints", () => {
  it("lista com ingest_url e transform_enabled, sem vazar o template", async () => {
    const { deps, calls } = setup();
    const res = await handleListEndpoints({ authorization: AUTH }, deps);
    assert.equal(res.status, 200);
    assert.deepEqual(calls.listEndpoints, [ORG_ID]);
    const { data } = res.body as { data: Record<string, unknown>[] };
    assert.equal(data.length, 2);
    assert.deepEqual(data[0], {
      id: ENDPOINT_ID,
      name: "Pagamentos",
      slug: "abcdefghijkl",
      ingest_url: "https://hookbox.test/in/abcdefghijkl",
      forward_enabled: false,
      forward_url: null,
      transform_enabled: false,
      created_at: "2026-11-12T10:00:00+00:00",
    });
    assert.equal(data[1].transform_enabled, true);
    assert.equal(data[1].forward_url, "https://x.test/h");
    assert.ok(!JSON.stringify(res.body).includes("transform_template"));
  });
});

describe("GET /endpoints/{id}/requests", () => {
  const list = (query: string, endpointId = ENDPOINT_ID, deps?: ApiDeps) =>
    handleListRequests(
      { authorization: AUTH, endpointId, searchParams: new URLSearchParams(query) },
      deps ?? setup().deps,
    );

  it("usa limit 20 por padrão e o orgId da chave", async () => {
    const { deps, calls } = setup();
    const res = await list("", ENDPOINT_ID, deps);
    assert.equal(res.status, 200);
    assert.deepEqual(calls.listRequests, [{ orgId: ORG_ID, endpointId: ENDPOINT_ID, limit: 20, before: null }]);
  });

  it("limit inválido → 400 invalid_parameter", async () => {
    for (const bad of ["0", "101", "-1", "abc", "1.5", "", "10x", "1e2", "99999"]) {
      const res = await list(`limit=${bad}`);
      assert.equal(res.status, 400, `limit=${bad}`);
      assert.equal(errorOf(res.body).code, "invalid_parameter");
    }
  });

  it("limit nas bordas 1 e 100 é aceito", async () => {
    for (const ok of ["1", "100"]) {
      const { deps, calls } = setup();
      const res = await list(`limit=${ok}`, ENDPOINT_ID, deps);
      assert.equal(res.status, 200);
      assert.equal(calls.listRequests[0].limit, Number(ok));
    }
  });

  it("before inválido → 400", async () => {
    for (const bad of ["ontem", "2026-11-12", "2026-13-01T00:00:00Z", "1731405600", "2026-11-12T10:00:00", ""]) {
      const res = await list(`before=${encodeURIComponent(bad)}`);
      assert.equal(res.status, 400, `before=${bad}`);
      assert.equal(errorOf(res.body).code, "invalid_parameter");
    }
  });

  it("before válido é repassado sem perder a precisão", async () => {
    const { deps, calls } = setup();
    const res = await list("before=2026-11-12T10:00:00.123456Z", ENDPOINT_ID, deps);
    assert.equal(res.status, 200);
    assert.equal(calls.listRequests[0].before, "2026-11-12T10:00:00.123456Z");
  });

  it("aceita offset com + que chegou como espaço na URL", async () => {
    const { deps, calls } = setup();
    const res = await list("before=2026-11-12T10:00:00.5+03:00", ENDPOINT_ID, deps);
    assert.equal(res.status, 200);
    assert.equal(calls.listRequests[0].before, "2026-11-12T10:00:00.5+03:00");
  });

  it("id que não é uuid → 404 sem consultar o banco", async () => {
    const { deps, calls } = setup();
    const res = await list("", "nao-e-uuid", deps);
    assert.equal(res.status, 404);
    assert.equal(errorOf(res.body).code, "not_found");
    assert.equal(calls.listRequests.length, 0);
  });

  it("endpoint de outra organização → 404", async () => {
    const { deps } = setup();
    const res = await list("", "5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b", deps);
    assert.equal(res.status, 404);
    assert.equal(errorOf(res.body).code, "not_found");
  });

  it("outra organização na chave não enxerga o endpoint", async () => {
    const { deps } = setup({ findKey: async () => ({ id: KEY_ID, org_id: OTHER_ORG_ID }) });
    const res = await handleListRequests(
      { authorization: AUTH, endpointId: ENDPOINT_ID, searchParams: new URLSearchParams() },
      deps,
    );
    assert.equal(res.status, 404);
  });

  it("página cheia → next_cursor é o received_at do último item (em Z)", async () => {
    const { deps } = setup();
    const res = await list("limit=3", ENDPOINT_ID, deps);
    const body = res.body as { data: RequestSummary[]; next_cursor: string | null };
    assert.equal(body.data.length, 3);
    assert.equal(body.next_cursor, "2026-11-12T10:00:57.123456Z");
  });

  it("página incompleta → next_cursor null", async () => {
    const { deps } = setup();
    const res = await list("limit=10", ENDPOINT_ID, deps); // o fake devolve só 3
    const body = res.body as { data: RequestSummary[]; next_cursor: string | null };
    assert.equal(body.data.length, 3);
    assert.equal(body.next_cursor, null);
  });

  it("lista vazia → next_cursor null", async () => {
    const { deps } = setup({ listRequests: async () => [] });
    const res = await list("", ENDPOINT_ID, deps);
    assert.deepEqual(res.body, { data: [], next_cursor: null });
  });

  it("o cursor devolvido é aceito como before", async () => {
    const { deps, calls } = setup();
    const first = await list("limit=3", ENDPOINT_ID, deps);
    const cursor = (first.body as { next_cursor: string }).next_cursor;
    const second = await list(`before=${cursor}`, ENDPOINT_ID, deps);
    assert.equal(second.status, 200);
    assert.equal(calls.listRequests[1].before, cursor);
  });
});

describe("GET /requests/{id}", () => {
  it("200 com a requisição e as entregas", async () => {
    const { deps, calls } = setup();
    const res = await handleGetRequest({ authorization: AUTH, requestId: REQUEST_ID }, deps);
    assert.equal(res.status, 200);
    assert.deepEqual(calls.getRequest, [{ orgId: ORG_ID, requestId: REQUEST_ID }]);
    const { data } = res.body as { data: Record<string, unknown> };
    assert.equal(data.id, REQUEST_ID);
    assert.equal(data.endpoint_id, ENDPOINT_ID);
    assert.equal(data.body, '{"a":1}');
    assert.equal(data.ip, "203.0.113.7");
    assert.deepEqual(data.deliveries, [
      { attempt: 1, status_code: 200, error: null, duration_ms: 12, created_at: "2026-11-12T10:01:00+00:00" },
    ]);
    assert.ok(!("org_id" in data));
  });

  it("404 se não existe ou é de outra organização", async () => {
    const { deps } = setup();
    const res = await handleGetRequest({ authorization: AUTH, requestId: "5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b" }, deps);
    assert.equal(res.status, 404);
    assert.equal(errorOf(res.body).code, "not_found");
  });

  it("404 se o id não é uuid", async () => {
    const { deps, calls } = setup();
    const res = await handleGetRequest({ authorization: AUTH, requestId: "123" }, deps);
    assert.equal(res.status, 404);
    assert.equal(calls.getRequest.length, 0);
  });

  it("401 sem chave", async () => {
    const { deps } = setup();
    const res = await handleGetRequest({ authorization: null, requestId: REQUEST_ID }, deps);
    assert.equal(res.status, 401);
  });
});

describe("POST /requests/{id}/resend", () => {
  it("404 se a requisição não é da organização", async () => {
    const { deps, calls } = setup();
    const res = await handleResend({ authorization: AUTH, requestId: "5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b" }, deps);
    assert.equal(res.status, 404);
    assert.equal(errorOf(res.body).code, "not_found");
    assert.equal(calls.enqueue.length, 0);
  });

  it("404 se o id não é uuid", async () => {
    const { deps, calls } = setup();
    const res = await handleResend({ authorization: AUTH, requestId: "x" }, deps);
    assert.equal(res.status, 404);
    assert.equal(calls.enqueue.length, 0);
  });

  it("409 se o encaminhamento está desligado ou sem URL", async () => {
    for (const forwarding of [
      { forward_enabled: false, forward_url: "https://destino.example/hook" },
      { forward_enabled: true, forward_url: null },
      { forward_enabled: false, forward_url: null },
    ]) {
      const { deps, calls } = setup({ getRequestForwarding: async () => forwarding });
      const res = await handleResend({ authorization: AUTH, requestId: REQUEST_ID }, deps);
      assert.equal(res.status, 409);
      assert.equal(errorOf(res.body).code, "forwarding_disabled");
      assert.equal(errorOf(res.body).message, "Ative o encaminhamento do endpoint para reenviar.");
      assert.equal(calls.enqueue.length, 0);
    }
  });

  it("502 se a fila falha", async () => {
    const { deps } = setup({
      enqueueDelivery: async () => {
        throw new Error("qstash fora");
      },
    });
    const res = await handleResend({ authorization: AUTH, requestId: REQUEST_ID }, deps);
    assert.equal(res.status, 502);
    assert.equal(errorOf(res.body).code, "queue_error");
  });

  it("202 e enfileira o id da requisição", async () => {
    const { deps, calls } = setup();
    const res = await handleResend({ authorization: AUTH, requestId: REQUEST_ID }, deps);
    assert.equal(res.status, 202);
    assert.deepEqual(res.body, { data: { queued: true } });
    assert.deepEqual(calls.enqueue, [REQUEST_ID]);
  });

  it("401 sem chave, sem enfileirar", async () => {
    const { deps, calls } = setup();
    const res = await handleResend({ authorization: null, requestId: REQUEST_ID }, deps);
    assert.equal(res.status, 401);
    assert.equal(calls.enqueue.length, 0);
  });
});
