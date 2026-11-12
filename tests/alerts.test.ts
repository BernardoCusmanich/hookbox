import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ALERT_THROTTLE_SECONDS,
  buildFailureEmail,
  sendFailureAlert,
  type AlertDeps,
  type Email,
  type FailureInfo,
} from "@/lib/alerts";

const INFO: FailureInfo = {
  orgId: "org-1",
  orgSlug: "acme",
  endpointId: "ep-1",
  endpointName: "Pagamentos <prod>",
  requestId: "req-1",
  attempt: 6,
  statusCode: 503,
  error: "Destino respondeu 503.",
};

function setup(over: Partial<AlertDeps> & { owners?: string[]; throttleFree?: boolean } = {}) {
  const calls = { owners: [] as string[], throttle: [] as [string, number][], sent: [] as Email[] };
  const deps: AlertDeps = {
    appUrl: "https://hookbox.test",
    enabled: true,
    async ownerEmails(orgId) {
      calls.owners.push(orgId);
      return over.owners ?? ["dono@acme.test"];
    },
    async acquireThrottle(endpointId, seconds) {
      calls.throttle.push([endpointId, seconds]);
      return over.throttleFree ?? true;
    },
    async sendEmail(email) {
      calls.sent.push(email);
    },
    ...over,
  };
  return { calls, deps };
}

describe("sendFailureAlert", () => {
  it("sem SMTP configurado: não consulta nada nem envia", async () => {
    const { calls, deps } = setup({ enabled: false });
    assert.equal(await sendFailureAlert(INFO, deps), "disabled");
    assert.equal(calls.owners.length + calls.throttle.length + calls.sent.length, 0);
  });

  it("sem owners com e-mail: não gasta a trava", async () => {
    const { calls, deps } = setup({ owners: [] });
    assert.equal(await sendFailureAlert(INFO, deps), "no-recipients");
    assert.equal(calls.throttle.length, 0);
    assert.equal(calls.sent.length, 0);
  });

  it("trava ocupada: não envia", async () => {
    const { calls, deps } = setup({ throttleFree: false });
    assert.equal(await sendFailureAlert(INFO, deps), "throttled");
    assert.deepEqual(calls.throttle, [["ep-1", ALERT_THROTTLE_SECONDS]]);
    assert.equal(calls.sent.length, 0);
  });

  it("envia um e-mail para os owners da org, sem duplicar endereços", async () => {
    const { calls, deps } = setup({ owners: ["a@acme.test", "b@acme.test", "a@acme.test"] });
    assert.equal(await sendFailureAlert(INFO, deps), "sent");
    assert.deepEqual(calls.owners, ["org-1"]);
    assert.equal(calls.sent.length, 1);
    assert.deepEqual(calls.sent[0].to, ["a@acme.test", "b@acme.test"]);
  });

  it("a trava é de uma hora por endpoint", () => {
    assert.equal(ALERT_THROTTLE_SECONDS, 3600);
  });
});

describe("buildFailureEmail", () => {
  const email = buildFailureEmail(INFO, "https://hookbox.test", ["dono@acme.test"]);

  it("assunto com o nome do endpoint", () => {
    assert.equal(email.subject, "Falha no encaminhamento: Pagamentos <prod>");
  });

  it("link para a página do endpoint", () => {
    assert.ok(email.text.includes("https://hookbox.test/app/acme/endpoints/ep-1"));
    assert.ok(email.html.includes('href="https://hookbox.test/app/acme/endpoints/ep-1"'));
  });

  it("escapa HTML vindo do usuário", () => {
    assert.ok(email.html.includes("Pagamentos &lt;prod&gt;"));
    assert.ok(!email.html.includes("<prod>"));
  });

  it("status, erro, requisição e número de tentativas", () => {
    assert.ok(email.text.includes("depois de 6 tentativas"));
    assert.ok(email.text.includes("Status do destino: 503"));
    assert.ok(email.text.includes("Erro: Destino respondeu 503."));
    assert.ok(email.text.includes("Requisição: req-1"));
  });

  it("sem resposta do destino e uma tentativa só", () => {
    const e = buildFailureEmail({ ...INFO, statusCode: null, attempt: 1 }, "https://hookbox.test", []);
    assert.ok(e.text.includes("Status do destino: sem resposta"));
    assert.ok(e.text.includes("depois de 1 tentativa."));
  });
});
