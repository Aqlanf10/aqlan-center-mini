import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import ts from "typescript";
import {
  createPlanInTransaction, createPlanV2InTransaction, PlanCreationRefusal,
  type DbClient, type DbPool, type PlanItemDraft, type QueryResult,
} from "../lib/db";
import { withTransaction } from "../lib/transactions";

// Compile-time contract: a normal DbPool must not be accepted as an inner writer
// client. DbClient still does not prove BEGIN; the outer caller owns that duty.
type AssertTrue<T extends true> = T;
export type PlanWriterClientContract = [
  AssertTrue<DbPool extends Parameters<typeof createPlanInTransaction>[0] ? false : true>,
  AssertTrue<DbPool extends Parameters<typeof createPlanV2InTransaction>[0] ? false : true>,
  AssertTrue<DbClient extends Parameters<typeof createPlanInTransaction>[0] ? true : false>,
  AssertTrue<DbClient extends Parameters<typeof createPlanV2InTransaction>[0] ? true : false>,
];

// Real extracted writer functions with only their supplied query executor mocked.
// No schema initialization, PGlite, live database or copied writer implementation.
const item = (overrides: Partial<PlanItemDraft> = {}): PlanItemDraft => ({
  serviceId: null, serviceName: " Synthetic filling ", category: "filling", toothCode: 11,
  surfaces: null, quantity: 1, unitPriceMinor: 300, billingRule: "on_completion",
  sessionCount: 2, note: " synthetic note ", ...overrides,
});
const v2 = (items: PlanItemDraft[] = [item()]) => ({
  patientId: 11, title: "Synthetic plan", specialty: null, primaryDoctorId: null,
  billingMode: "custom_schedule" as const, baseCurrency: "SAR" as const, startDate: "2028-01-03",
  note: null, items, installments: [{ dueDate: "2028-01-03", amountMinor: 100.6 }], createdBy: "synthetic",
});
const legacy = () => ({
  patientId: 11, title: " Legacy title ", totalMinor: 300, baseCurrency: "USD" as const,
  startDate: "2028-01-03", note: " legacy note ", createdBy: "synthetic",
  installments: [{ number: 7, dueDate: "2028-01-03", amountMinor: 100.6 }],
});
function executor(fail?: (sql: string, values: unknown[] | undefined) => Error | undefined) {
  const calls: { sql: string; values: unknown[] | undefined }[] = [];
  let plan = 100, visit = 200, planItem = 300;
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    calls.push({ sql, values });
    const error = fail?.(sql, values); if (error) throw error;
    const id = /INSERT INTO treatment_plans/.test(sql) ? ++plan
      : /INSERT INTO planned_visits/.test(sql) ? ++visit
        : /INSERT INTO plan_items/.test(sql) ? ++planItem : undefined;
    return { rows: id === undefined ? [] : [{ id }] };
  });
  const release = vi.fn();
  const client: DbClient = { query: query as DbClient["query"], release };
  const pool: DbPool = { connect: vi.fn(async () => client), query: async <T>(): Promise<QueryResult<T>> => {
    throw new Error("Unexpected pooled query");
  } };
  return { calls, query, release, client, pool };
}
const tables = (calls: { sql: string }[]) => calls.map(({ sql }) => /INSERT INTO (\w+)/.exec(sql)?.[1] ?? sql);

describe("transaction-owned plan writer source boundary", () => {
  const source = ts.createSourceFile("db.ts", readFileSync(new URL("../lib/db.ts", import.meta.url), "utf8"),
    ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  it.each(["createPlanInTransaction", "createPlanV2InTransaction"])("%s cannot acquire/control/release a transaction", (name) => {
    const fn = source.statements.find((node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === name);
    expect(fn?.body).toBeDefined();
    const calls: string[] = []; const literals: string[] = [];
    function walk(node: ts.Node) {
      if (ts.isCallExpression(node)) calls.push(node.expression.getText(source));
      if (ts.isStringLiteralLike(node)) literals.push(node.text);
      ts.forEachChild(node, walk);
    }
    walk(fn!.body!);
    expect(calls.some((call) => /(?:getPool|ensureSchema|withTransaction|\.connect|\.release)$/.test(call))).toBe(false);
    expect(literals.some((sql) => /^\s*(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|START\s+TRANSACTION)\b/i.test(sql))).toBe(false);
  });
  it("keeps schema initialization and the empty-V2 fast refusal before connection acquisition", () => {
    for (const name of ["createPlan", "createPlanV2"]) {
      const fn = source.statements.find((node): node is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(node) && node.name?.text === name)!;
      const body = fn.body!.getText(source);
      expect(body.indexOf("await ensureSchema()")).toBeLessThan(body.indexOf("getPool().connect()"));
      if (name === "createPlanV2") {
        expect(body.indexOf("input.items.length === 0")).toBeGreaterThan(body.indexOf("await ensureSchema()"));
        expect(body.indexOf("input.items.length === 0")).toBeLessThan(body.indexOf("getPool().connect()"));
      }
    }
  });
});

describe("legacy SQL/value/order compatibility on a supplied client", () => {
  it("preserves raw legacy strings, numbering and amounts without new normalization", async () => {
    const e = executor(); const input = legacy();
    expect(await createPlanInTransaction(e.client, input)).toBe(101);
    expect(tables(e.calls)).toEqual(["treatment_plans", "plan_installments"]);
    expect(e.calls[0].values).toEqual([11, " Legacy title ", 300, "USD", "2028-01-03", " legacy note ", "synthetic"]);
    expect(e.calls[1].values).toEqual([101, 7, "2028-01-03", 100.6]);
    expect(e.release).not.toHaveBeenCalled();
  });
  it("preserves empty zero-total legacy clinical plan", async () => {
    const e = executor();
    expect(await createPlanInTransaction(e.client, { ...legacy(), totalMinor: 0, installments: [] })).toBe(101);
    expect(tables(e.calls)).toEqual(["treatment_plans"]);
  });
});

describe("V2 SQL/value/order and typed refusal boundary", () => {
  it("preserves rounding, normal-session order and installment normalization", async () => {
    const e = executor(); const input = v2([item({ quantity: 1.6, unitPriceMinor: 99.7 })]);
    expect(await createPlanV2InTransaction(e.client, input)).toEqual({ ok: true, planId: 101 });
    expect(tables(e.calls)).toEqual(["treatment_plans", "plan_items", "planned_visits", "treatment_sessions", "treatment_sessions", "plan_installments"]);
    expect(e.calls[0].values).toEqual([11, "Synthetic plan", 200, "SAR", "2028-01-03", null, "synthetic", "custom_schedule", null, null, true]);
    expect(e.calls[1].values).toEqual([101, null, "Synthetic filling", "filling", 11, null, 2, 100, "synthetic note", "on_completion", 2]);
    expect(e.calls[3].values?.slice(0, 2)).toEqual([301, 1]);
    expect(e.calls[4].values?.slice(0, 2)).toEqual([301, 2]);
    expect(e.calls[5].values).toEqual([101, 1, "2028-01-03", 101]);
    expect(e.release).not.toHaveBeenCalled();
  });
  it("preserves template grouping, insertion order and the first interval", async () => {
    const sessions = [{ title: "Synthetic session", minutes: 30, afterDays: 7, visitKey: "fill:0", visitTitle: "Synthetic visit" }];
    const e = executor();
    await createPlanV2InTransaction(e.client, v2([
      item({ sessionPlan: sessions, sessionCount: 1 }),
      item({ toothCode: 12, sessionCount: 1, sessionPlan: [{ ...sessions[0], minutes: 45, afterDays: 99 }] }),
    ]));
    expect(tables(e.calls)).toEqual(["treatment_plans", "planned_visits", "plan_items", "treatment_sessions", "plan_items", "treatment_sessions", "plan_installments"]);
    expect(e.calls[1].values).toEqual([11, 101, 1, "Synthetic visit", null, 75, 7]);
    expect(e.calls[3].values).toEqual([301, 1, "Synthetic session", 201, 30]);
    expect(e.calls[5].values).toEqual([302, 1, "Synthetic session", 201, 45]);
  });
  it.each(["name", "tooth"])("throws a typed late %s refusal without committing partial rows", async (reason) => {
    const e = executor(); const invalid = item(reason === "name" ? { serviceName: " " } : { toothCode: 99 });
    await expect(withTransaction(e.pool, (client) => createPlanV2InTransaction(client, v2([item(), invalid]))))
      .rejects.toBeInstanceOf(PlanCreationRefusal);
    expect(tables(e.calls)).toEqual(["BEGIN", "treatment_plans", "plan_items", "planned_visits", "treatment_sessions", "treatment_sessions", "ROLLBACK"]);
    expect(e.release).toHaveBeenCalledTimes(1);
  });
  it("empty and zero-total inner requests throw; neither issues SQL itself", async () => {
    for (const input of [{ ...v2([]), installments: [] }, v2([item({ unitPriceMinor: 0 })])]) {
      const e = executor();
      await expect(createPlanV2InTransaction(e.client, input)).rejects.toBeInstanceOf(PlanCreationRefusal);
      expect(e.calls).toEqual([]); expect(e.release).not.toHaveBeenCalled();
    }
  });
  it("preserves a thrown executor error without translating it into business refusal", async () => {
    const failure = new Error("synthetic insert failure");
    const e = executor((sql) => sql.includes("INSERT INTO treatment_sessions") ? failure : undefined);
    await expect(withTransaction(e.pool, (client) => createPlanV2InTransaction(client, v2())))
      .rejects.toBe(failure);
    expect(tables(e.calls).at(-1)).toBe("ROLLBACK");
    expect(e.calls.some(({ sql }) => sql === "COMMIT")).toBe(false);
  });
  it("composes both writers with one external BEGIN/COMMIT/connection/release", async () => {
    const e = executor();
    const result = await withTransaction(e.pool, async (client) => ({
      legacyId: await createPlanInTransaction(client, legacy()),
      v2: await createPlanV2InTransaction(client, v2()),
    }));
    expect(result).toEqual({ legacyId: 101, v2: { ok: true, planId: 102 } });
    expect(e.calls.filter(({ sql }) => sql === "BEGIN")).toHaveLength(1);
    expect(e.calls.filter(({ sql }) => sql === "COMMIT")).toHaveLength(1);
    expect(e.calls.some(({ sql }) => sql === "ROLLBACK")).toBe(false);
    expect(e.pool.connect).toHaveBeenCalledTimes(1); expect(e.release).toHaveBeenCalledTimes(1);
  });
});
