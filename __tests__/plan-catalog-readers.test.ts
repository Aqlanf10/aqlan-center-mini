import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import ts from "typescript";
import {
  getSettingsInTransaction, listServicesInTransaction,
  type DbClient, type DbPool,
} from "../lib/db";
import { withDefaults } from "../lib/settings";
import { withTransaction } from "../lib/transactions";

// A connected DbClient is mandatory. This rejects ordinary pools and omission,
// but deliberately does not pretend that the structural type proves BEGIN.
type AssertTrue<T extends true> = T;
export type PlanCatalogClientContract = [
  AssertTrue<DbPool extends Parameters<typeof getSettingsInTransaction>[0] ? false : true>,
  AssertTrue<DbPool extends Parameters<typeof listServicesInTransaction>[0] ? false : true>,
  AssertTrue<undefined extends Parameters<typeof getSettingsInTransaction>[0] ? false : true>,
  AssertTrue<undefined extends Parameters<typeof listServicesInTransaction>[0] ? false : true>,
  AssertTrue<DbClient extends Parameters<typeof getSettingsInTransaction>[0] ? true : false>,
  AssertTrue<DbClient extends Parameters<typeof listServicesInTransaction>[0] ? true : false>,
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

const serviceRow = (overrides: Record<string, unknown> = {}) => ({
  id: 7, name: " Synthetic service ", category: "filling", price_minor: "12345",
  is_active: true, sort_order: 9, price_configured: true, price_provisional: false,
  price_sar_minor: "987", price_usd_minor: null, ...overrides,
});
const serviceColumns = "id, name, category, price_minor, is_active, sort_order, price_configured, price_provisional, price_sar_minor, price_usd_minor";

describe("same-client catalog reader source boundary", () => {
  const source = ts.createSourceFile("db.ts", readFileSync(new URL("../lib/db.ts", import.meta.url), "utf8"),
    ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declaration = (name: string) => {
    const fn = source.statements.find((node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === name);
    expect(fn?.body).toBeDefined();
    return fn!;
  };

  it.each(["getSettingsInTransaction", "listServicesInTransaction", "readSettings", "readServices"])("%s cannot access cache, acquire a connection or control a transaction", (name) => {
    const calls: string[] = []; const literals: string[] = []; const identifiers: string[] = [];
    function walk(node: ts.Node) {
      if (ts.isCallExpression(node)) calls.push(node.expression.getText(source));
      if (ts.isStringLiteralLike(node)) literals.push(node.text);
      if (ts.isIdentifier(node)) identifiers.push(node.text);
      ts.forEachChild(node, walk);
    }
    walk(declaration(name).body!);
    expect(calls.some((call) => /(?:getPool|ensureSchema|withTransaction|\.connect|\.release)$/.test(call))).toBe(false);
    expect(literals.some((sql) => /^\s*(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|START\s+TRANSACTION)\b/i.test(sql))).toBe(false);
    expect(identifiers).not.toContain("settingsCache");
    expect(identifiers).not.toContain("invalidateSettingsCache");
    expect(identifiers).not.toContain("getSettings");
    expect(identifiers).not.toContain("getSettingsSafe");
  });

  it("shares the existing defaults and service mapper with unchanged public signatures", () => {
    expect(declaration("getSettings").parameters).toHaveLength(0);
    expect(declaration("getSettings").type?.getText(source)).toBe("Promise<SettingsMap>");
    expect(declaration("listServices").parameters.map((node) => node.getText(source)))
      .toEqual(["includeInactive = false"]);
    expect(declaration("listServices").type?.getText(source)).toBe("Promise<Service[]>");
    expect(declaration("getSettingsInTransaction").body!.getText(source)).toContain("return readSettings(client, options)");
    expect(declaration("listServicesInTransaction").body!.getText(source)).toContain("return readServices(client, includeInactive)");
    expect(declaration("readSettings").body!.getText(source)).toContain("const settings = withDefaults(stored)");
    expect(declaration("readServices").body!.getText(source)).toContain("return rows.map(toService)");
    expect(declaration("readServices").body!.getText(source)).toContain("${SERVICE_COLUMNS}");
  });

  it("preserves getSettings cache hit before schema initialization and timestamp before I/O", () => {
    const body = declaration("getSettings").body!.getText(source);
    const statements = [
      "const now = Date.now()",
      "if (settingsCache && now - settingsCache.at < SETTINGS_TTL_MS) return settingsCache.value",
      "await ensureSchema()", "const value = await readSettings(getPool())",
      "settingsCache = { value, at: now }", "return value",
    ];
    const positions = statements.map((statement) => body.indexOf(statement));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(source.text).toContain("const SETTINGS_TTL_MS = 5_000;");
    expect(declaration("listServices").body!.getText(source)).toBe(`{
  await ensureSchema();
  return readServices(getPool(), includeInactive);
}`);
  });
});

describe("settings on the supplied client", () => {
  it("preserves defaults, empty/null handling, unknown-key exclusion and raw nonempty values", async () => {
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

  it("queries every time, using only this client's current rows without reusing a prior result", async () => {
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

  it("propagates executor failure unchanged instead of returning safe defaults", async () => {
    const failure = new Error("synthetic settings read failure"); const e = executor([], failure);
    await expect(getSettingsInTransaction(e.client)).rejects.toBe(failure);
    expect(e.query).toHaveBeenCalledTimes(1); expect(e.release).not.toHaveBeenCalled();
  });
});

describe("services on the supplied client", () => {
  it.each([undefined, false, true])("keeps exact SQL/filter/order for includeInactive=%s", async (includeInactive) => {
    const e = executor();
    expect(await listServicesInTransaction(e.client, includeInactive)).toEqual([]);
    expect(e.query.mock.calls).toEqual([[`SELECT ${serviceColumns} FROM services
      ${includeInactive ? "" : "WHERE is_active"}
      ORDER BY sort_order, name`]]);
    expect(e.release).not.toHaveBeenCalled();
  });

  it("preserves row order, strings, null/zero currency prices and boolean mapping", async () => {
    const e = executor([
      serviceRow(),
      serviceRow({ id: 8, name: "Second", category: null, is_active: false, price_minor: "0",
        price_configured: null, price_provisional: true, price_sar_minor: null, price_usd_minor: "0" }),
    ]);
    expect(await listServicesInTransaction(e.client, true)).toEqual([
      { id: 7, name: " Synthetic service ", category: "filling", priceMinor: 12345,
        isActive: true, sortOrder: 9, priceConfigured: true, priceProvisional: false,
        priceSarMinor: 987, priceUsdMinor: null },
      { id: 8, name: "Second", category: null, priceMinor: 0,
        isActive: false, sortOrder: 9, priceConfigured: false, priceProvisional: true,
        priceSarMinor: null, priceUsdMinor: 0 },
    ]);
  });

  it.each(["price_minor", "price_sar_minor", "price_usd_minor"])("retains safe-integer rejection for %s", async (column) => {
    const e = executor([serviceRow({ [column]: "9007199254740992" })]);
    await expect(listServicesInTransaction(e.client)).rejects.toThrow("قيمة مالية خارج نطاق الأعداد الصحيحة الآمنة");
    expect(e.release).not.toHaveBeenCalled();
  });

  it.each(["1.5", "not-a-number"])("retains existing malformed monetary rejection for %s", async (value) => {
    await expect(listServicesInTransaction(executor([serviceRow({ price_minor: value })]).client))
      .rejects.toThrow("قيمة مالية");
  });

  it("propagates executor failure unchanged", async () => {
    const failure = new Error("synthetic service read failure"); const e = executor([], failure);
    await expect(listServicesInTransaction(e.client)).rejects.toBe(failure);
    expect(e.query).toHaveBeenCalledTimes(1); expect(e.release).not.toHaveBeenCalled();
  });

  it("allows the outer transaction owner alone to roll back and release on a read failure", async () => {
    const failure = new Error("synthetic composed catalog failure"); const commands: string[] = [];
    const query = vi.fn(async (sql: string) => {
      commands.push(sql);
      if (sql.includes("FROM services")) throw failure;
      return { rows: [] };
    });
    const release = vi.fn();
    const client: DbClient = { query, release };
    const pool: DbPool = { connect: vi.fn(async () => client), query: vi.fn(async () => {
      throw new Error("Unexpected pooled query");
    }) };
    await expect(withTransaction(pool, async (tx) => {
      await getSettingsInTransaction(tx);
      return listServicesInTransaction(tx);
    })).rejects.toBe(failure);
    expect(commands[0]).toBe("BEGIN"); expect(commands.at(-1)).toBe("ROLLBACK");
    expect(commands).not.toContain("COMMIT"); expect(pool.connect).toHaveBeenCalledTimes(1);
    expect(pool.query).not.toHaveBeenCalled(); expect(release).toHaveBeenCalledTimes(1);
  });
});
