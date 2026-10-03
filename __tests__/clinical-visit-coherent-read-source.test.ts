import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import ts from "typescript";

// Pure source contract: importing this test never imports the application DB,
// initializes a schema, connects to a server, or loads the route at runtime.
const source = ts.createSourceFile("db.ts", readFileSync(new URL("../lib/db.ts", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const route = ts.createSourceFile("route.ts", readFileSync(new URL("../app/api/visits/[id]/clinical/route.ts", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
function declaration(name: string, file = source): ts.FunctionDeclaration {
  const matches = file.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name);
  expect(matches, `one exact ${name} declaration`).toHaveLength(1);
  expect(matches[0].body).toBeDefined();
  return matches[0];
}
function descendants(node: ts.Node): ts.Node[] {
  const nodes: ts.Node[] = [];
  function walk(item: ts.Node) { nodes.push(item); ts.forEachChild(item, walk); }
  walk(node);
  return nodes;
}
function calls(name: string) { return descendants(declaration(name).body!).filter(ts.isCallExpression); }
function namedCalls(name: string, callee: string) { return calls(name).filter((call) => call.expression.getText(source) === callee); }
function ordered(body: string, statements: string[]) {
  const positions = statements.map((statement) => body.indexOf(statement));
  expect(positions.every((position) => position >= 0), statements.join(" -> ")).toBe(true);
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
}
const readers = [
  "readClinicalVisitOnClient", "previewPatientId", "visitPlanContext", "unlinkedPlanSessionConflicts",
  "visitOrthoContext", "openOrthoCaseForOnClient", "hydrateCases", "photosForAdjustments",
  "orthoAdjustmentForVisit", "orthoAdjustmentBillingClass", "visitWorkflowContext", "listPatientCasesOnClient",
  "listCasePlanItemsOnClient", "referralBlockersByCase", "unmetPlanItemRequirements", "visitSuggestionsFor", "visitReferralContext",
] as const;
const readerNames = new Set<string>(readers);

describe("canonical clinical read source boundary", () => {
  it("initializes schema before choosing the existing backend and connecting to PostgreSQL", () => {
    const body = declaration("getClinicalVisit").body!.getText(source);
    ordered(body, ["await ensureSchema()", "const pool = getPool()", "if (pgliteInstance !== null)",
      "return readClinicalVisitOnClient(pool, visitId, options)", "const client = await pool.connect()",
      'await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")',
      "await readClinicalVisitOnClient(client, visitId, options)", 'await client.query("COMMIT")', "return visit"]);
    expect(namedCalls("getClinicalVisit", "ensureSchema")).toHaveLength(1);
    expect(namedCalls("getClinicalVisit", "getPool")).toHaveLength(1);
    expect(namedCalls("getClinicalVisit", "pool.connect")).toHaveLength(1);
    expect(namedCalls("getClinicalVisit", "readClinicalVisitOnClient")).toHaveLength(2);
    expect(descendants(declaration("getClinicalVisit").body!).filter(ts.isIdentifier).map((node) => node.text))
      .not.toContain("process");
  });

  it("owns commit, rollback, original-error propagation and exactly one release in finally", () => {
    const fn = declaration("getClinicalVisit");
    const transaction = fn.body!.statements.find(ts.isTryStatement)!;
    expect(transaction).toBeDefined();
    expect(transaction.catchClause?.block.getText(source)).toContain('await client.query("ROLLBACK").catch(() => undefined)');
    expect(transaction.catchClause?.block.getText(source)).toContain("throw error");
    expect(transaction.finallyBlock?.getText(source)).toBe("{\n    client.release();\n  }");
    expect(namedCalls("getClinicalVisit", "client.release")).toHaveLength(1);
    expect(namedCalls("getClinicalVisit", "client.query").map((call) => (call.arguments[0] as ts.StringLiteral).text))
      .toEqual(["BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY", "COMMIT", "ROLLBACK"]);
  });

  it.each(readers)("%s has no schema/pool/public-wrapper escape or transaction boundary", (name) => {
    const fn = declaration(name);
    const executor = fn.parameters[0];
    expect(fn.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false).toBe(false);
    expect(executor.initializer).toBeUndefined();
    expect(executor.questionToken).toBeUndefined();
    expect(executor.type?.getText(source)).toMatch(/^(Pick<DbClient, "query">|\{ query: DbClient\["query"\] \})$/);
    const executorName = executor.name.getText(source);
    const bodyCalls = calls(name);
    const targets = bodyCalls.map((call) => call.expression.getText(source));
    expect(targets.some((callee) => /(?:getPool|ensureSchema|withTransaction|\.connect|\.release)$/.test(callee))).toBe(false);
    for (const wrapper of ["getClinicalVisit", "openOrthoCaseFor", "listPatientCases", "listCasePlanItems"]) expect(targets).not.toContain(wrapper);
    for (const call of bodyCalls) {
      const callee = call.expression.getText(source);
      if (callee.endsWith(".query")) {
        expect(callee).toBe(`${executorName}.query`);
        // Include interpolated templates, not just standalone string literals.
        const sqlText = call.arguments[0]?.getText(source).replace(/^[`'"]/, "") ?? "";
        expect(sqlText).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|START\s+TRANSACTION|INSERT|UPDATE|DELETE|ALTER|CREATE|DROP)\b/i);
      }
      if (readerNames.has(callee)) expect(call.arguments[0]?.getText(source)).toBe(executorName);
    }
    const sql = descendants(fn.body!).filter(ts.isStringLiteralLike).map((literal) => literal.text);
    expect(sql.some((text) => /^\s*(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|START\s+TRANSACTION|INSERT|UPDATE|DELETE|ALTER|CREATE|DROP)\b/i.test(text))).toBe(false);
  });

  it("has one projection body and passes its executor through every context path", () => {
    const targets = calls("readClinicalVisitOnClient").map((call) => call.expression.getText(source));
    for (const helper of ["previewPatientId", "visitPlanContext", "visitOrthoContext", "visitWorkflowContext", "visitSuggestionsFor", "visitReferralContext"]) {
      expect(targets).toContain(helper);
    }
    const main = declaration("readClinicalVisitOnClient");
    const projection = main.body!.statements.find((node): node is ts.ReturnStatement => ts.isReturnStatement(node)
      && node.expression !== undefined && ts.isObjectLiteralExpression(node.expression))!;
    const object = projection.expression as ts.ObjectLiteralExpression;
    expect(object.properties.map((property) => property.name?.getText(source)).sort()).toEqual([
      "id", "patientId", "patientName", "chiefComplaint", "examination", "diagnosis", "treatmentDone", "nextPlan", "addendum",
      "doctorId", "status", "signedAt", "signedBy", "invoiceId", "arrivedAt", "procedures", "totalMinor", "planCurrency",
      "billingCurrency", "planItemsMatched", "planTitle", "planWarning", "ortho", "plannedVisit", "previousVisit", "latestDiagnosis",
      "activeCases", "outstanding", "sessionPricing", "labOrders", "suggestions", "referral",
    ].sort());
    expect(main.body!.getText(source)).toContain("if (!rows[0]) return null");
    expect(main.body!.getText(source)).toContain("const procedures = procedureRows.map(toProcedureLine)");
  });

  it("traverses workflow readers sequentially so a rejected sibling cannot outlive rollback", () => {
    const body = declaration("visitWorkflowContext").body!.getText(source);
    expect(body).not.toContain("Promise.all");
    expect(namedCalls("visitWorkflowContext", "listPatientCasesOnClient")).toHaveLength(1);
    expect(namedCalls("visitWorkflowContext", "listCasePlanItemsOnClient")).toHaveLength(1);
  });

  it.each([
    ["openOrthoCaseFor", ["patientId: number", "today: string"], "Promise<OrthoCase | null>", "openOrthoCaseForOnClient"],
    ["listPatientCases", ["patientId: number"], "Promise<SpecialtyCase[]>", "listPatientCasesOnClient"],
    ["listCasePlanItems", ["patientId: number"], "Promise<{ items: CasePlanItem[]; dependencies: PlanItemDependency[] }>", "listCasePlanItemsOnClient"],
  ] as const)("keeps %s's public signature and schema-first pooled compatibility wrapper", (name, parameters, result, reader) => {
    const fn = declaration(name);
    expect(fn.parameters.map((parameter) => parameter.getText(source))).toEqual(parameters);
    expect(fn.type?.getText(source)).toBe(result);
    expect(fn.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)).toBe(true);
    expect(namedCalls(name, "ensureSchema")).toHaveLength(1);
    const invocation = namedCalls(name, reader);
    expect(invocation).toHaveLength(1);
    expect(invocation[0].arguments[0].getText(source)).toBe("getPool()");
    expect(fn.body!.getText(source).indexOf("await ensureSchema()")).toBeLessThan(invocation[0].getStart(source) - fn.body!.getStart(source));
  });
});

describe("local adapter identity is established by its existing lifecycle", () => {
  it("creates the local instance only inside its pool factory and resets it with the cached pool", () => {
    const instantiations = descendants(source).filter((node): node is ts.CallExpression => ts.isCallExpression(node)
      && node.expression.getText(source) === "getPgliteInstance");
    expect(instantiations).toHaveLength(1);
    const factory = declaration("createPglitePool");
    expect(instantiations[0].getStart(source)).toBeGreaterThan(factory.body!.getStart(source));
    expect(instantiations[0].getEnd()).toBeLessThan(factory.body!.getEnd());
    const assignments = descendants(source).filter((node): node is ts.BinaryExpression => ts.isBinaryExpression(node)
      && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && node.left.getText(source) === "pgliteInstance");
    expect(assignments.map((node) => node.right.getText(source))).toEqual(["new PGlite()", "null"]);
    expect(declaration("getPgliteInstance").body!.getText(source)).toContain("pgliteInstance = new PGlite()");
    const reset = declaration("resetPoolForTesting").body!.getText(source);
    expect(reset).toContain("pgliteInstance = null");
    expect(reset).toContain("pool = null");
    ordered(declaration("getPool").body!.getText(source), ["if (pool) return pool", 'process.env.USE_LOCAL_DB === "true"', "pool = createPglitePool()"]);
  });

  it("does not insert an await or mutable environment selection between pool capture and the local branch", () => {
    const statements = declaration("getClinicalVisit").body!.statements;
    const captureIndex = statements.findIndex((node) => node.getText(source) === "const pool = getPool();");
    expect(captureIndex).toBeGreaterThan(0);
    expect(statements[captureIndex + 1].getText(source))
      .toBe("if (pgliteInstance !== null) return readClinicalVisitOnClient(pool, visitId, options);");
    expect(statements[captureIndex + 2].getText(source)).toBe("const client = await pool.connect();");
  });
});

describe("clinical GET authorization boundary remains in the route", () => {
  it("retains exact-patient and assistant-day checks before the independent structured projection", () => {
    const body = declaration("GET", route).body!.getText(route);
    ordered(body, ["await requireSession()", "if (!session) return denied()", "await idFrom(context)",
      "await getClinicalVisit(visitId, { actorPartyId: session.partyId ?? null })", "if (!visit)",
      "visit.patientId !== null && !(await canAccessPatient(session, visit.patientId))",
      'session.role === "assistant" && assistantOutsideToday(visit)',
      "await getVisitStructuredClinical(visitId, visit.patientId)", "return NextResponse.json({ ...visit, structuredClinical })"]);
    expect(body).toContain(".catch(() => unavailableStructuredClinical(visitId, visit.patientId))");
    expect(body).toContain("unavailableStructuredClinical(visitId, null)");
    expect(body).toContain("{ status: 403 }");
    expect(body).toContain("{ status: 404 }");
    expect(body).toContain("{ status: 500 }");
  });
});
