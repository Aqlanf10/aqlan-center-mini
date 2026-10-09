import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import ts from "typescript";
import { assertRealPostgresUrl } from "./_setup";
import { assertLocalExpenseComparisonUrl } from "./_expense-comparison-fixture-url";
import { validatePostgresTestTarget } from "./_safe-target";

/** Query-level regression using the exact SQL in the production read owner.
 * Do not import/run db.ts: its internal ensureSchema/getPool bindings would bypass
 * an export mock and could initialize public tables. Reuse the existing guarded
 * real-PG TEMP/ROLLBACK pattern, with no copied query or application initializer.
 * The browser journey separately covers the complete API/UI/recall contract.
 */
assertRealPostgresUrl();
const target = validatePostgresTestTarget({ ...process.env }, { allowDatabaseUrlFallback: true });
const connectionString = assertLocalExpenseComparisonUrl(target.testUrl.toString());
const client = new Client({ connectionString, ssl: false, connectionTimeoutMillis: 5_000, statement_timeout: 10_000 });

function productionHistorySql(): string {
  const source = ts.createSourceFile("lib/db.ts", readFileSync(new URL("../../lib/db.ts", import.meta.url), "utf8"),
    ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const owner = source.statements.find((node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === "listSettingHistory");
  if (!owner) throw new Error("Production listSettingHistory owner not found.");
  const queries: string[] = [];
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === "query") {
      const sql = node.arguments[0];
      if (!sql || !ts.isNoSubstitutionTemplateLiteral(sql)) {
        throw new Error("History query must be one static production SQL template.");
      }
      queries.push(sql.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(owner);
  if (queries.length !== 1 || !/^\s*SELECT\b/i.test(queries[0])
    || queries[0].includes(";") || /\bpublic\s*\./i.test(queries[0])) {
    throw new Error("History fixture accepts exactly one unqualified SELECT query.");
  }
  return queries[0];
}
const sql = productionHistorySql();
const key = "ops.follow_up_lookback_days";
const action = "clinic_settings.update";
const actor = "synthetic-history-order";
const at = "2026-10-08T12:00:00.000Z";
type QueryRow = { id: string; action: string; entity_id: string; details: Record<string, string>; created_at: Date };

beforeAll(async () => {
  await client.connect();
  await client.query("SET search_path TO pg_temp");
  await client.query(`CREATE TEMP TABLE audit_log (
    id bigint PRIMARY KEY, action text NOT NULL, entity text NOT NULL, entity_id text,
    details jsonb, actor text NOT NULL, actor_role text, created_at timestamptz NOT NULL
  )`);
});
beforeEach(async () => {
  // READ ONLY still allows TEMP inserts; afterEach rolls back every fixture row.
  await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
  expect((await client.query("SHOW transaction_read_only")).rows[0].transaction_read_only).toBe("on");
});
afterEach(async () => { await client.query("ROLLBACK"); });
afterAll(async () => { await client.end(); });

async function seed(id: string, before: string, after: string, options: {
  key?: string; action?: string; entity?: string; actor?: string; category?: string; at?: string;
} = {}) {
  await client.query(`INSERT INTO pg_temp.audit_log
    (id, action, entity, entity_id, details, actor, actor_role, created_at)
    VALUES ($1::bigint, $2, $3, $4, $5::jsonb, $6, 'admin', $7::timestamptz)`,
  [id, options.action ?? action, options.entity ?? "clinic_setting", options.key ?? key,
    JSON.stringify({ قبل: before, بعد: after, الفئة: options.category ?? "patient_workflow" }), options.actor ?? actor, options.at ?? at]);
}
async function fingerprint() {
  return (await client.query("SELECT to_jsonb(a) AS row FROM pg_temp.audit_log a ORDER BY a.id")).rows;
}
async function read(options: {
  key?: string | null; action?: string | null; category?: string | null; actor?: string | null;
  from?: string | null; to?: string | null; limit?: number; beforeId?: string | null;
} = {}): Promise<QueryRow[]> {
  const before = await fingerprint();
  try {
    const result = await client.query<QueryRow>(sql, ["clinic_setting",
      options.key === undefined ? key : options.key, options.category ?? null, options.actor ?? null,
      options.from ?? null, options.to ?? null, options.limit ?? 100, options.beforeId ?? null,
      options.action === undefined ? action : options.action]);
    // Preserve the public string ID contract while sorting the underlying bigint.
    expect(result.fields[0]).toMatchObject({ name: "id", dataTypeID: 25 });
    expect(result.rows.every((row) => typeof row.id === "string")).toBe(true);
    return result.rows;
  } finally {
    // ROLLBACK alone could hide a TEMP mutation; compare before it happens.
    expect(await fingerprint()).toEqual(before);
  }
}

async function noise() {
  await seed("9001", "530", "531.125", { key: "finance.rate.USD", category: "finance" });
  await seed("9002", "140", "141.25", { key: "finance.rate.SAR", category: "finance" });
  await seed("9003", "60", "30", { action: "clinic_settings.reset" });
  await seed("9004", "30", "99", { entity: "lab_order" });
  await seed("9005", "30", "99", { action: "settings.update" });
}

describe("settings history numeric ID order and cursor contract", () => {
  it.each([["9", "10"], ["99", "100"], ["999", "1000"]] as const)(
    "returns newer %s/%s update first despite finance audit noise", async (older, newer) => {
      await seed(older, "30", "10");
      await seed(newer, "10", "60");
      await noise();
      const rows = await read();
      expect(rows.map((row) => row.id)).toEqual([newer, older]);
      expect(rows.map((row) => ({ key: row.entity_id, action: row.action, before: row.details.قبل, after: row.details.بعد })))
        .toEqual([
          { key, action, before: "10", after: "60" },
          { key, action, before: "30", after: "10" },
        ]);
      const first = await read({ limit: 1 });
      expect(first.map((row) => row.id)).toEqual([newer]);
      const second = await read({ limit: 1, beforeId: first[0].id });
      expect(second.map((row) => row.id)).toEqual([older]);
      expect(await read({ limit: 1, beforeId: second[0].id })).toEqual([]);
    },
  );

  it("paginates across all digit boundaries without skipping or duplicating rows", async () => {
    for (const id of ["9", "10", "99", "100", "999", "1000"]) await seed(id, "10", "60");
    await noise();
    const first = await read({ limit: 2 });
    const second = await read({ limit: 2, beforeId: first.at(-1)!.id });
    const third = await read({ limit: 2, beforeId: second.at(-1)!.id });
    const ids = [...first, ...second, ...third].map((row) => row.id);
    expect(ids).toEqual(["1000", "999", "100", "99", "10", "9"]);
    expect(new Set(ids).size).toBe(6);
    expect(await read({ limit: 2, beforeId: third.at(-1)!.id })).toEqual([]);
  });

  it("keeps bigint IDs exact above Number.MAX_SAFE_INTEGER and leaves history untouched", async () => {
    await seed("9007199254740991", "30", "10");
    await seed("9007199254740992", "10", "60");
    await seed("9007199254740993", "60", "90");
    const rows = await read({ limit: 2 });
    expect(rows.map((row) => row.id)).toEqual(["9007199254740993", "9007199254740992"]);
    expect((await read({ beforeId: rows[1].id })).map((row) => row.id)).toEqual(["9007199254740991"]);
  });

  it("retains combined key/action/category/actor/date filters and the empty result", async () => {
    await seed("9", "30", "10");
    await seed("10", "10", "60");
    await seed("11", "60", "90", { actor: "different-actor" });
    await seed("12", "60", "90", { category: "finance" });
    await seed("13", "60", "90", { at: "2026-10-07T12:00:00.000Z" });
    await seed("14", "60", "90", { at: "2026-10-09T12:00:00.000Z" });
    await noise();
    expect((await read({ category: "patient_workflow", actor, from: "2026-10-08", to: "2026-10-08" }))
      .map((row) => row.id)).toEqual(["10", "9"]);
    expect(await read({ key: "clinic.not_a_fixture" })).toEqual([]);
    expect((await read({ action: "clinic_settings.reset" })).map((row) => row.id)).toEqual(["9003"]);
    expect((await read({ key: "finance.rate.USD" })).map((row) => row.id)).toEqual(["9001"]);
  });
});
