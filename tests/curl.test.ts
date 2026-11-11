import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildCurl } from "@/lib/curl";

describe("Copiar como cURL", () => {
  it("monta método, URL com query, headers úteis e corpo com aspas escapadas", () => {
    const curl = buildCurl({
      url: "https://hookbox.example.com/in/abc",
      method: "POST",
      query: { a: ["1", "2"], b: "x y" },
      headers: {
        host: "hookbox.example.com",
        "content-length": "10",
        authorization: "[redacted]",
        "x-forwarded-for": "1.2.3.4",
        "content-type": "application/json",
      },
      body: `{"nome":"D'Ávila"}`,
      bodyEncoding: "utf8",
    });
    assert.equal(
      curl,
      [
        "curl -X POST 'https://hookbox.example.com/in/abc?a=1&a=2&b=x+y' \\",
        "  -H 'content-type: application/json' \\",
        `  --data-binary '{"nome":"D'\\''Ávila"}'`,
      ].join("\n"),
    );
  });

  it("corpo binário passa por base64 -d", () => {
    const curl = buildCurl({
      url: "https://h.example/in/abc",
      method: "PUT",
      query: {},
      headers: {},
      body: "AP8=",
      bodyEncoding: "base64",
    });
    assert.equal(curl, "printf '%s' 'AP8=' | base64 -d | \\\ncurl -X PUT 'https://h.example/in/abc' \\\n  --data-binary @-");
  });
});
