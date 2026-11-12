import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { generateApiKey, hashApiKey, parseBearer } from "@/lib/api-keys";

describe("generateApiKey", () => {
  it("gera hbk_ + 43 caracteres base64url", () => {
    const { key } = generateApiKey();
    assert.match(key, /^hbk_[A-Za-z0-9_-]{43}$/);
  });

  it("prefix são os 12 primeiros caracteres e hash é o sha256 da chave inteira", () => {
    const { key, prefix, hash } = generateApiKey();
    assert.equal(prefix, key.slice(0, 12));
    assert.equal(prefix.length, 12);
    assert.match(hash, /^[0-9a-f]{64}$/);
    assert.equal(hash, hashApiKey(key));
  });

  it("gera chaves diferentes a cada chamada", () => {
    const keys = new Set(Array.from({ length: 50 }, () => generateApiKey().key));
    assert.equal(keys.size, 50);
  });
});

describe("hashApiKey", () => {
  it("é determinístico e depende da chave inteira", () => {
    assert.equal(hashApiKey("hbk_abc"), hashApiKey("hbk_abc"));
    assert.notEqual(hashApiKey("hbk_abc"), hashApiKey("hbk_abd"));
  });

  it("bate com o sha256 conhecido", () => {
    // echo -n abc | sha256sum
    assert.equal(hashApiKey("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("parseBearer", () => {
  const { key } = generateApiKey();

  it("aceita Bearer + chave válida", () => {
    assert.equal(parseBearer(`Bearer ${key}`), key);
  });

  it("recusa ausência de header", () => {
    assert.equal(parseBearer(null), null);
    assert.equal(parseBearer(""), null);
  });

  it("recusa sem o esquema Bearer", () => {
    assert.equal(parseBearer(key), null);
    assert.equal(parseBearer(`Basic ${key}`), null);
    assert.equal(parseBearer(`Token ${key}`), null);
  });

  it("recusa esquema em minúsculas", () => {
    assert.equal(parseBearer(`bearer ${key}`), null);
    assert.equal(parseBearer(`BEARER ${key}`), null);
  });

  it("recusa espaços extras", () => {
    assert.equal(parseBearer(`Bearer  ${key}`), null);
    assert.equal(parseBearer(` Bearer ${key}`), null);
    assert.equal(parseBearer(`Bearer ${key} `), null);
    assert.equal(parseBearer(`Bearer\t${key}`), null);
  });

  it("recusa chave curta ou longa demais", () => {
    assert.equal(parseBearer(`Bearer ${key.slice(0, -1)}`), null);
    assert.equal(parseBearer(`Bearer ${key}A`), null);
    assert.equal(parseBearer("Bearer hbk_"), null);
  });

  it("recusa prefixo errado", () => {
    assert.equal(parseBearer(`Bearer xbk_${key.slice(4)}`), null);
    assert.equal(parseBearer(`Bearer HBK_${key.slice(4)}`), null);
  });

  it("recusa caracteres fora do base64url", () => {
    assert.equal(parseBearer(`Bearer ${key.slice(0, -1)}+`), null);
    assert.equal(parseBearer(`Bearer ${key.slice(0, -1)}/`), null);
    assert.equal(parseBearer(`Bearer ${key.slice(0, -1)}=`), null);
    assert.equal(parseBearer(`Bearer ${key.slice(0, -1)}\n`), null);
  });
});
