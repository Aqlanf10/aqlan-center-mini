import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import ts from "typescript";
import { getSettingsInTransaction, type DbClient, type DbPool } from "../lib/db";
import { withDefaults } from "../lib/settings";

// The caller must supply its connected client, rather than an ordinary pool.
type AssertTrue<T extends true> = T;
export type LabSettingsClientContract = [
  AssertTrue<DbPool extends Parameters<typeof getSettingsInTransaction>[0] ? false : true>,
  AssertTrue<undefined extends Parameters<typeof getSettingsInTransaction>[0] ? false : true>,
  AssertTrue<DbClient extends Parameters<typeof getSettingsInTransaction>[0] ? true : false>,
];

function executor(rows: unknown[] = [], failure?: Error) {
  const query = vi.fn(async (_sql: string, _values?: unknown[]) => {
    if (failure) throw failure;
    return { rows };
  });
  const release = vi.fn();
  const client: DbClient = { query: query as DbClient["query"], release };
  return { query, release, client };
}

describe("isolated transaction settings reader boundary", () => {
  const source = ts.createSourceFile("db.ts", readFileSync(new URL("../lib/db.ts", import.meta.url), "utf8"),
    ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declaration = (name: string) => {
    const fn = source.statements.find((node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === name);
    expect(fn?.body).toBeDefined();
    return fn!;
  };

  it.each(["getSettingsInTransaction", "readSettings"])("%s cannot access cache, acquire a connection or own a transaction", name => {
    const calls: string[] = []; const literals: string[] = []; const identifiers: string[] = [];
    function walk(node: ts.Node) {
      if (ts.isCallExpression(node)) calls.push(node.expression.getText(source));
      if (ts.isStringLiteralLike(node)) literals.push(node.text);
      if (ts.isIdentifier(node)) identifiers.push(node.text);
      ts.forEachChild(node, walk);
    }
    walk(declaration(name).body!);
    expect(calls.some(call => /(?:getPool|ensureSchema|withTransaction|\.connect|\.release)$/.test(call))).toBe(false);
    expect(literals.some(sql => /^\s*(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|START\s+TRANSACTION)\b/i.test(sql))).toBe(false);
    for (const forbidden of ["settingsCache", "invalidateSettingsCache", "getSettings", "getSettingsSafe"])
      expect(identifiers).not.toContain(forbidden);
  });

  it("shares the existing default mapping without changing public settings/cache behavior", () => {
    expect(declaration("getSettings").parameters).toHaveLength(0);
    expect(declaration("getSettings").type?.getText(source)).toBe("Promise<SettingsMap>");
    expect(declaration("getSettingsInTransaction").body!.getText(source)).toContain("return readSettings(client, options)");
    expect(declaration("readSettings").body!.getText(source)).toContain("const settings = withDefaults(stored)");
    const body = declaration("getSettings").body!.getText(source);
    const statements = [
      "const now = Date.now()",
      "if (settingsCache && now - settingsCache.at < SETTINGS_TTL_MS) return settingsCache.value",
      "await ensureSchema()", "const value = await readSettings(getPool())",
      "settingsCache = { value, at: now }", "return value",
    ];
    const positions = statements.map(statement => body.indexOf(statement));
    expect(positions.every(position => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(source.text).toContain("const SETTINGS_TTL_MS = 5_000;");
  });

  it("preserves default, empty/null, unknown-key and raw nonempty setting mapping", async () => {
    const e = executor([
      { key: "clinic.name", value: " Synthetic clinic " },
      { key: "clinic.chairs", value: "" },
      { key: "clinic.phone", value: null },
      { key: "ops.follow_up_lookback_days", value: "0" },
      { key: "unknown.synthetic.key", value: "ignored" },
    ]);
    const settings = await getSettingsInTransaction(e.client);
    expect(settings).toEqual(withDefaults({ "clinic.name": " Synthetic clinic ", "ops.follow_up_lookback_days": "0" }));
    expect(settings).not.toHaveProperty("unknown.synthetic.key");
    expect(e.query.mock.calls).toEqual([["SELECT key, value FROM settings"]]);
    expect(e.release).not.toHaveBeenCalled();
  });

  it("always queries the same client for fresh rows and does not mutate a previous result", async () => {
    const rows = [{ key: "clinic.name", value: "first" }];
    const e = executor(rows);
    const first = await getSettingsInTransaction(e.client);
    rows[0].value = "second";
    const second = await getSettingsInTransaction(e.client);
    expect(first["clinic.name"]).toBe("first");
    expect(second["clinic.name"]).toBe("second");
    expect(second).not.toBe(first);
    expect(e.query).toHaveBeenCalledTimes(2);
    expect(await getSettingsInTransaction(executor().client)).toEqual(withDefaults({}));
  });

  it("propagates storage failure unchanged instead of returning default FX", async () => {
    const failure = new Error("Synthetic settings failure");
    const e = executor([], failure);
    await expect(getSettingsInTransaction(e.client, { requireStoredExchangeRates: true })).rejects.toBe(failure);
    expect(e.query).toHaveBeenCalledTimes(1);
    expect(e.release).not.toHaveBeenCalled();
  });
});
