import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { describe, it } from "node:test";
import {
  decryptSecret,
  encryptSecret,
  generateEndpointSecret,
  generateEndpointSlug,
  generateInviteToken,
} from "@/lib/crypto";
import { buildForwardHeaders, classifyStatus } from "@/lib/forward";
import { clientIp, decodeBody, queryToJson, retryAfterSeconds, sanitizeHeaders } from "@/lib/ingest";
import { computeSignature, verifySignature } from "@/lib/signature";
import { ForwardUrlError, isBlockedAddress, validateForwardUrl } from "@/lib/ssrf";

const enc = (s: string) => new TextEncoder().encode(s);

describe("assinatura (compatível com o legacy-bridge)", () => {
  const secret = "a".repeat(64);
  const body = enc('{"entity":"pedido","operation":"updated","data":{"id":1}}');
  const now = 1_794_405_600;

  it("bate com a fórmula do legacy-bridge: HMAC(secret utf8, `${ts}.${body}`)", () => {
    const expected =
      "sha256=" + createHmac("sha256", Buffer.from(secret, "utf8")).update(`${now}.`).update(body).digest("hex");
    assert.equal(computeSignature(secret, String(now), body), expected);
  });

  it("valid / invalid / missing / not_configured", () => {
    const sig = computeSignature(secret, String(now), body);
    assert.equal(verifySignature({ secret, signature: sig, timestamp: String(now), rawBody: body, nowSeconds: now }), "valid");
    const tampered = sig.slice(0, -1) + (sig.endsWith("0") ? "1" : "0");
    assert.equal(verifySignature({ secret, signature: tampered, timestamp: String(now), rawBody: body, nowSeconds: now }), "invalid");
    assert.equal(verifySignature({ secret, signature: "sha256=abc", timestamp: String(now), rawBody: body, nowSeconds: now }), "invalid");
    assert.equal(verifySignature({ secret, signature: null, timestamp: String(now), rawBody: body, nowSeconds: now }), "missing");
    assert.equal(verifySignature({ secret, signature: sig, timestamp: null, rawBody: body, nowSeconds: now }), "missing");
    assert.equal(verifySignature({ secret: null, signature: sig, timestamp: String(now), rawBody: body }), "not_configured");
  });

  it("timestamp fora de ±300 s é inválido, mesmo com assinatura certa", () => {
    const old = String(now - 301);
    const sig = computeSignature(secret, old, body);
    assert.equal(verifySignature({ secret, signature: sig, timestamp: old, rawBody: body, nowSeconds: now }), "invalid");
    const edge = String(now - 300);
    const sigEdge = computeSignature(secret, edge, body);
    assert.equal(verifySignature({ secret, signature: sigEdge, timestamp: edge, rawBody: body, nowSeconds: now }), "valid");
    assert.equal(verifySignature({ secret, signature: sig, timestamp: "abc", rawBody: body, nowSeconds: now }), "invalid");
  });

  it("usa os bytes brutos (corpo binário)", () => {
    const raw = Uint8Array.from([0xff, 0x00, 0xfe]);
    const sig = computeSignature(secret, String(now), raw);
    assert.equal(verifySignature({ secret, signature: sig, timestamp: String(now), rawBody: raw, nowSeconds: now }), "valid");
  });
});

describe("crypto", () => {
  const key = randomBytes(32);

  it("AES-256-GCM ida e volta, no formato iv.tag.ciphertext", () => {
    const secret = generateEndpointSecret();
    assert.match(secret, /^[0-9a-f]{64}$/);
    const payload = encryptSecret(secret, key);
    assert.equal(payload.split(".").length, 3);
    assert.equal(decryptSecret(payload, key), secret);
  });

  it("recusa ciphertext adulterado ou chave errada", () => {
    const payload = encryptSecret("segredo", key);
    const [iv, tag, ct] = payload.split(".");
    const tampered = Buffer.from(ct, "base64");
    tampered[0] ^= 1;
    assert.throws(() => decryptSecret(`${iv}.${tag}.${tampered.toString("base64")}`, key));
    assert.throws(() => decryptSecret(payload, randomBytes(32)));
  });

  it("slug com 12 caracteres [a-z0-9] e token base64url de 32 bytes", () => {
    for (let i = 0; i < 200; i++) assert.match(generateEndpointSlug(), /^[a-z0-9]{12}$/);
    const token = generateInviteToken();
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(Buffer.from(token, "base64url").length, 32);
  });
});

describe("ingestão", () => {
  it("redige headers sensíveis e descarta x-vercel-*", () => {
    const h = new Headers({
      Authorization: "Bearer x",
      Cookie: "a=b",
      "Proxy-Authorization": "Basic y",
      "X-Api-Key": "k",
      "X-Vercel-Oidc-Token": "jwt",
      "Content-Type": "application/json",
    });
    assert.deepEqual(sanitizeHeaders(h), {
      authorization: "[redacted]",
      cookie: "[redacted]",
      "proxy-authorization": "[redacted]",
      "x-api-key": "[redacted]",
      "content-type": "application/json",
    });
  });

  it("UTF-8 válido vira utf8; binário ou com NUL vira base64", () => {
    assert.deepEqual(decodeBody(enc("olá")), { body: "olá", encoding: "utf8" });
    assert.equal(decodeBody(Uint8Array.from([0xc3, 0x28])).encoding, "base64");
    assert.deepEqual(decodeBody(Uint8Array.from([0x61, 0x00])), { body: "YQA=", encoding: "base64" });
    assert.deepEqual(decodeBody(new Uint8Array()), { body: "", encoding: "utf8" });
  });

  it("IP do primeiro x-forwarded-for", () => {
    assert.equal(clientIp(new Headers({ "x-forwarded-for": "203.0.113.5, 10.0.0.1" })), "203.0.113.5");
    assert.equal(clientIp(new Headers({ "x-forwarded-for": "lixo" })), null);
  });

  it("rate limit: Retry-After pelo limite mais distante", () => {
    const now = 1_000_000;
    assert.equal(retryAfterSeconds([{ success: true, reset: 0 }, { success: true, reset: 0 }], now), null);
    assert.equal(retryAfterSeconds([{ success: false, reset: now + 12_300 }, { success: true, reset: now + 59_000 }], now), 13);
    assert.equal(retryAfterSeconds([{ success: false, reset: now + 2_000 }, { success: false, reset: now + 40_000 }], now), 40);
    assert.equal(retryAfterSeconds([{ success: false, reset: now - 5 }], now), 1);
  });

  it("query com chaves repetidas", () => {
    assert.deepEqual(queryToJson(new URLSearchParams("a=1&b=2&a=3")), { a: ["1", "3"], b: "2" });
  });
});

describe("encaminhamento", () => {
  it("remove host, content-length, connection, transfer-encoding e os redigidos", () => {
    const out = buildForwardHeaders(
      {
        host: "x",
        "content-length": "3",
        connection: "keep-alive",
        "transfer-encoding": "chunked",
        authorization: "[redacted]",
        cookie: "[redacted]",
        "x-bridge-signature": "sha256=abc",
        "content-type": "application/json",
      },
      "req-1",
    );
    assert.deepEqual(out, {
      "x-bridge-signature": "sha256=abc",
      "content-type": "application/json",
      "x-hookbox-request-id": "req-1",
    });
  });

  it("classifica respostas", () => {
    assert.equal(classifyStatus(204).kind, "success");
    assert.equal(classifyStatus(301).kind, "permanent");
    assert.equal(classifyStatus(400).kind, "permanent");
    assert.equal(classifyStatus(404).kind, "permanent");
    assert.equal(classifyStatus(408).kind, "retry");
    assert.equal(classifyStatus(429).kind, "retry");
    assert.equal(classifyStatus(503).kind, "retry");
  });
});

describe("SSRF", () => {
  it("bloqueia faixas internas e reservadas", () => {
    for (const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.0.10",
      "169.254.169.254",
      "0.0.0.0",
      "224.0.0.1",
      "::1",
      "::",
      "fc00::1",
      "fd12::1",
      "fe80::1",
      "ff02::1",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "::ffff:169.254.169.254",
    ]) {
      assert.equal(isBlockedAddress(ip), true, ip);
    }
    for (const ip of ["8.8.8.8", "172.32.0.1", "2606:4700:4700::1111"]) {
      assert.equal(isBlockedAddress(ip), false, ip);
    }
  });

  const opts = (resolveTo: string[]) => ({
    appUrl: "https://hookbox.example.com",
    requireHttps: true,
    resolve: async () => resolveTo.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })),
  });

  it("aceita https público", async () => {
    const url = await validateForwardUrl("https://api.example.org/hook", opts(["93.184.215.14"]));
    assert.equal(url.hostname, "api.example.org");
  });

  it("recusa http em produção, IPs internos, rebinding parcial e o próprio domínio", async () => {
    await assert.rejects(validateForwardUrl("http://api.example.org", opts(["93.184.215.14"])), ForwardUrlError);
    await assert.rejects(validateForwardUrl("https://127.0.0.1/x", opts([])), ForwardUrlError);
    await assert.rejects(validateForwardUrl("https://[::1]/x", opts([])), ForwardUrlError);
    await assert.rejects(validateForwardUrl("https://evil.example", opts(["93.184.215.14", "10.0.0.1"])), ForwardUrlError);
    await assert.rejects(validateForwardUrl("https://hookbox.example.com/in/x", opts(["93.184.215.14"])), ForwardUrlError);
    await assert.rejects(validateForwardUrl("https://localhost/x", opts(["127.0.0.1"])), ForwardUrlError);
    await assert.rejects(validateForwardUrl("https://user:pw@api.example.org", opts(["93.184.215.14"])), ForwardUrlError);
    await assert.rejects(validateForwardUrl("ftp://api.example.org", opts(["93.184.215.14"])), ForwardUrlError);
  });

  it("aceita http fora de produção", async () => {
    await validateForwardUrl("http://api.example.org", { ...opts(["93.184.215.14"]), requireHttps: false });
  });
});
