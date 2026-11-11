import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { Agent } from "undici";
import { buildForwardHeaders, sendForward } from "@/lib/forward";

type Seen = { method?: string; headers: IncomingMessage["headers"]; body: Buffer };

describe("sendForward contra um servidor HTTP local", () => {
  let server: Server;
  let base: string;
  const seen: Seen[] = [];
  const dispatcher = new Agent();

  before(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        seen.push({ method: req.method, headers: req.headers, body: Buffer.concat(chunks) });
        const status = Number(new URL(req.url ?? "/", "http://x").searchParams.get("status") ?? "200");
        if (req.url?.startsWith("/slow")) return void setTimeout(() => res.end("tarde"), 500);
        if (status >= 300 && status < 400) res.setHeader("location", "https://example.com/");
        res.statusCode = status;
        res.end("ok");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await dispatcher.close();
    await new Promise((resolve) => server.close(resolve));
  });

  const send = (path: string, extra: Partial<Parameters<typeof sendForward>[0]> = {}) =>
    sendForward({
      url: new URL(path, base),
      method: "POST",
      headers: buildForwardHeaders(
        {
          host: "hookbox.example",
          "content-length": "999",
          authorization: "[redacted]",
          "content-type": "application/json",
          "x-bridge-signature": "sha256=abc",
        },
        "req-123",
      ),
      body: '{"ok":true}',
      bodyEncoding: "utf8",
      testOverrides: { dispatcher, timeoutMs: 200 },
      ...extra,
    });

  it("2xx: entrega método, corpo e headers, com x-hookbox-request-id", async () => {
    const result = await send("/hook?status=204");
    assert.equal(result.kind, "success");
    assert.equal(result.statusCode, 204);
    const last = seen.at(-1)!;
    assert.equal(last.method, "POST");
    assert.equal(last.body.toString(), '{"ok":true}');
    assert.equal(last.headers["x-hookbox-request-id"], "req-123");
    assert.equal(last.headers["x-bridge-signature"], "sha256=abc");
    assert.equal(last.headers.authorization, undefined);
    assert.equal(last.headers["content-length"], "11");
    assert.equal(last.headers.host, new URL(base).host);
  });

  it("corpo base64 é decodificado para os bytes originais", async () => {
    await send("/bin", { method: "PUT", body: Buffer.from([0, 255, 1]).toString("base64"), bodyEncoding: "base64" });
    assert.deepEqual([...seen.at(-1)!.body], [0, 255, 1]);
  });

  it("GET não envia corpo", async () => {
    await send("/get", { method: "GET" });
    assert.equal(seen.at(-1)!.method, "GET");
    assert.equal(seen.at(-1)!.body.length, 0);
  });

  it("5xx, 408 e 429 pedem retry; 4xx e redirect são permanentes", async () => {
    assert.equal((await send("/x?status=503")).kind, "retry");
    assert.equal((await send("/x?status=408")).kind, "retry");
    assert.equal((await send("/x?status=429")).kind, "retry");
    assert.equal((await send("/x?status=404")).kind, "permanent");
    const redirect = await send("/x?status=302");
    assert.equal(redirect.kind, "permanent");
    assert.equal(redirect.statusCode, 302);
  });

  it("timeout pede retry", async () => {
    const result = await send("/slow");
    assert.equal(result.kind, "retry");
    assert.equal(result.statusCode, null);
    assert.match(result.kind === "retry" ? result.error : "", /Timeout/);
  });

  it("o dispatcher de produção recusa IP interno na conexão (DNS rebinding)", async () => {
    const result = await sendForward({
      url: new URL("/hook", base),
      method: "POST",
      headers: {},
      body: "",
      bodyEncoding: "utf8",
    });
    assert.equal(result.kind, "permanent");
  });

  it("o dispatcher de produção recusa hostname que resolve para loopback", async () => {
    const url = new URL("/hook", base);
    url.hostname = "localhost";
    const before = seen.length;
    const result = await sendForward({ url, method: "POST", headers: {}, body: "", bodyEncoding: "utf8" });
    assert.equal(result.kind, "permanent");
    assert.match(result.kind === "permanent" ? result.error : "", /bloqueado/);
    assert.equal(seen.length, before, "nada chegou ao servidor");
  });
});
