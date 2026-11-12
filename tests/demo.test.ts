import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DEMO_ENDPOINT_SLUGS } from "@/lib/demo-constants";

describe("slugs da demo", () => {
  it("a migration demo_guards usa a mesma lista de lib/demo-constants.ts", () => {
    const sql = readFileSync(
      join(process.cwd(), "supabase/migrations/20261112000000_demo_guards.sql"),
      "utf8",
    );
    const match = /old\.slug\s+in\s*\(([^)]*)\)/i.exec(sql);
    assert.ok(match, "não achei `old.slug in (...)` na migration demo_guards");
    const inMigration = [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
    const inCode = [...DEMO_ENDPOINT_SLUGS].sort();
    assert.deepEqual(
      inMigration,
      inCode,
      "Os slugs da demo divergem: atualize DEMO_ENDPOINT_SLUGS em lib/demo-constants.ts e o `old.slug in (...)` em supabase/migrations/20261112000000_demo_guards.sql (ou uma migration nova).",
    );
  });
});
