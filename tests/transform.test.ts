import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyTransform,
  buildTransformContext,
  MAX_OUTPUT_BYTES,
  TransformError,
  validateTemplate,
  type TransformContext,
} from "@/lib/transform";

function ctx(over: Partial<TransformContext> = {}): TransformContext {
  return {
    method: "POST",
    headers: { "x-github-event": "push", "content-type": "application/json" },
    query: { id: "42", tag: ["a", "b"] },
    body: { id: 7, status: "pago", ok: true, nada: null, order: { id: 99, tags: ["x", "y"] }, items: [{ sku: "A1" }, { sku: "B2" }] },
    ...over,
  };
}

const run = (template: unknown, c: TransformContext = ctx()) => JSON.parse(applyTransform(JSON.stringify(template), c));

describe("applyTransform: placeholder único preserva o tipo", () => {
  it("número, booleano, null, objeto, array e string", () => {
    assert.deepEqual(
      run({ a: "{{ body.id }}", b: "{{ body.ok }}", c: "{{ body.nada }}", d: "{{body.order}}", e: "{{ body.order.tags }}", f: "{{ body.status }}" }),
      { a: 7, b: true, c: null, d: { id: 99, tags: ["x", "y"] }, e: ["x", "y"], f: "pago" },
    );
  });

  it("valor ausente vira null", () => {
    assert.deepEqual(run({ a: "{{ body.nao.existe }}", b: "{{ headers.x-nada }}", c: "{{ query.zzz }}", d: "{{ body.items[9].sku }}" }), {
      a: null,
      b: null,
      c: null,
      d: null,
    });
  });

  it("raiz sozinha: method, body e query", () => {
    assert.deepEqual(run({ m: "{{ method }}", q: "{{ query }}" }), { m: "POST", q: { id: "42", tag: ["a", "b"] } });
    assert.equal(run("{{ body }}", ctx({ body: "texto cru" })), "texto cru");
  });

  it("só valores são processados: chaves ficam como estão", () => {
    assert.deepEqual(run({ "{{ body.id }}": "{{ body.id }}" }), { "{{ body.id }}": 7 });
  });

  it("números, booleanos e null do template passam direto", () => {
    assert.deepEqual(run({ n: 1, b: false, z: null, l: [1, "{{ method }}"] }), { n: 1, b: false, z: null, l: [1, "POST"] });
  });
});

describe("applyTransform: interpolação em texto", () => {
  it("string fica como está; null e ausente viram vazio", () => {
    assert.deepEqual(run({ text: "Pedido {{ body.id }}: {{ body.status }}", v: "[{{ body.nada }}|{{ body.xx }}]" }), {
      text: "Pedido 7: pago",
      v: "[|]",
    });
  });

  it("objetos, arrays e booleanos via JSON.stringify", () => {
    assert.deepEqual(run({ t: "x {{ body.order }} y {{ body.order.tags }} z {{ body.ok }}" }), {
      t: 'x {"id":99,"tags":["x","y"]} y ["x","y"] z true',
    });
  });

  it("dois placeholders colados não contam como placeholder único", () => {
    assert.deepEqual(run({ t: "{{ body.id }}{{ body.id }}" }), { t: "77" });
  });

  it("texto sem placeholder e chaves soltas ficam intactos", () => {
    assert.deepEqual(run({ t: "oi {{ sem fechar", u: "{ {body.id} }" }), { t: "oi {{ sem fechar", u: "{ {body.id} }" });
  });
});

describe("caminhos", () => {
  it("índices de array encadeados e com chaves", () => {
    assert.deepEqual(run({ a: "{{ body.items[0].sku }}", b: "{{ body.items[1].sku }}", c: "{{ body.order.tags[1] }}" }), {
      a: "A1",
      b: "B2",
      c: "y",
    });
    assert.equal(run("{{ body[1][0] }}", ctx({ body: [1, [5, 6]] })), 5);
  });

  it("headers são acessados em minúsculas", () => {
    assert.deepEqual(run({ a: "{{ headers.X-GitHub-Event }}", b: "{{ headers.x-github-event }}" }), { a: "push", b: "push" });
  });

  it("query com valor repetido (array)", () => {
    assert.deepEqual(run({ id: "{{ query.id }}", tags: "{{ query.tag }}", primeira: "{{ query.tag[0] }}" }), {
      id: "42",
      tags: ["a", "b"],
      primeira: "a",
    });
  });

  it("não alcança propriedades do protótipo", () => {
    assert.deepEqual(run({ a: "{{ body.constructor }}", b: "{{ body.__proto__ }}", c: "{{ body.items.length }}" }), {
      a: null,
      b: null,
      c: null,
    });
  });

  it("raiz desconhecida ou sintaxe inválida é erro", () => {
    for (const path of ["foo.bar", "", "body.", "body..a", "body[a]", "body[-1]", "body[1", "body.a b", "method.x", "Body.id", "body.ç", "body.a(1)"]) {
      assert.equal(validateTemplate(JSON.stringify({ a: `{{ ${path} }}` })), `Caminho inválido: {{ ${path.trim()} }}.`, path);
      assert.throws(() => applyTransform(JSON.stringify({ a: `{{ ${path} }}` }), ctx()), TransformError, path);
    }
  });

  it("caminho inválido em texto interpolado também é erro", () => {
    assert.equal(validateTemplate('{"a":"x {{ nope.y }} z"}'), "Caminho inválido: {{ nope.y }}.");
  });
});

describe("validateTemplate", () => {
  it("template válido devolve null", () => {
    assert.equal(validateTemplate('{"text":"Pedido {{ body.id }}: {{ body.status }}"}'), null);
    assert.equal(validateTemplate("[]"), null);
  });

  it("JSON inválido", () => {
    assert.equal(validateTemplate("{não é json"), "O template não é um JSON válido.");
    assert.equal(validateTemplate(""), "O template não é um JSON válido.");
  });

  it("limite de 10.000 caracteres do template", () => {
    const ok = JSON.stringify({ a: "x".repeat(10_000 - 8) });
    assert.equal(ok.length, 10_000);
    assert.equal(validateTemplate(ok), null);
    assert.equal(validateTemplate(`${ok} `), "O template pode ter no máximo 10.000 caracteres.");
  });

  it("profundidade máxima", () => {
    const nest = (n: number) => "[".repeat(n) + "]".repeat(n);
    assert.equal(validateTemplate(nest(30)), null);
    assert.match(validateTemplate(nest(40)) ?? "", /aninhamento/);
    assert.throws(() => applyTransform(nest(40), ctx()), TransformError);
  });
});

describe("limite de saída", () => {
  it("resultado acima de 256 KB lança TransformError", () => {
    const big = "x".repeat(200 * 1024);
    const c = ctx({ body: { big } });
    assert.doesNotThrow(() => applyTransform('{"a":"{{ body.big }}"}', c));
    assert.throws(() => applyTransform('{"a":"{{ body.big }}","b":"{{ body.big }}"}', c), /256 KB/);
    assert.throws(() => applyTransform('{"a":"{{ body.big }}","b":"{{ body.big }}"}', c), TransformError);
  });

  it("template pequeno que repete o corpo inteiro é cortado cedo", () => {
    const c = ctx({ body: { big: "x".repeat(100 * 1024) } });
    const template = JSON.stringify(Array.from({ length: 600 }, () => "{{ body }}"));
    assert.ok(template.length <= 10_000);
    assert.throws(() => applyTransform(template, c), TransformError);
    const texts = JSON.stringify(Array.from({ length: 500 }, () => "a {{ body.big }}"));
    assert.throws(() => applyTransform(texts, c), TransformError);
  });

  it("o limite é em bytes UTF-8", () => {
    const c = ctx({ body: { s: "é".repeat(MAX_OUTPUT_BYTES / 2) } });
    assert.throws(() => applyTransform('{"a":"{{ body.s }}"}', c), /256 KB/);
  });
});

describe("buildTransformContext", () => {
  const base = { method: "POST", headers: { "X-A": "1", n: 2 }, query: { a: "1", b: ["x", "y"] } };

  it("utf8 com JSON válido vira valor parseado", () => {
    const c = buildTransformContext({ ...base, body: '{"a":[1,2]}', body_encoding: "utf8" });
    assert.deepEqual(c.body, { a: [1, 2] });
    assert.deepEqual(c.headers, { "x-a": "1" });
    assert.deepEqual(c.query, { a: "1", b: ["x", "y"] });
    assert.equal(c.method, "POST");
  });

  it("utf8 que não é JSON fica como string crua", () => {
    assert.equal(buildTransformContext({ ...base, body: "a=1&b=2", body_encoding: "utf8" }).body, "a=1&b=2");
    assert.equal(buildTransformContext({ ...base, body: "", body_encoding: "utf8" }).body, "");
  });

  it("base64 e corpo nulo viram null", () => {
    assert.equal(buildTransformContext({ ...base, body: "e30=", body_encoding: "base64" }).body, null);
    assert.equal(buildTransformContext({ ...base, body: null, body_encoding: "utf8" }).body, null);
  });

  it("headers e query inesperados viram objetos vazios", () => {
    const c = buildTransformContext({ method: "GET", headers: null, query: "x", body: null, body_encoding: "utf8" });
    assert.deepEqual(c.headers, {});
    assert.deepEqual(c.query, {});
  });

  it("integra com applyTransform: body não JSON e base64", () => {
    const raw = buildTransformContext({ ...base, body: "texto", body_encoding: "utf8" });
    assert.equal(applyTransform('{"b":"{{ body }}","t":"[{{ body.x }}]"}', raw), '{"b":"texto","t":"[]"}');
    const b64 = buildTransformContext({ ...base, body: "e30=", body_encoding: "base64" });
    assert.equal(applyTransform('{"b":"{{ body }}"}', b64), '{"b":null}');
  });
});
