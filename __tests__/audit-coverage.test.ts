import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it, vi } from "vitest";
import ts from "typescript";
import { AUDIT_EXEMPT } from "@/lib/audit-coverage";

const retired = vi.hoisted(() => ({ session: vi.fn(), user: vi.fn(), owns: vi.fn(), write: vi.fn() }));
vi.mock("@/lib/session", () => ({ requireSession: retired.session }));
vi.mock("@/lib/db", () => ({
  CLINIC_TIME_ZONE: "Asia/Aden", findUserByUsername: retired.user, doctorOwnsPatient: retired.owns,
  createPlan: retired.write, createPlanV2: retired.write, recordAudit: retired.write,
}));
vi.mock("@/lib/patient-access", () => ({ canViewPatientMoney: vi.fn() }));
import { POST as retiredPlanPOST } from "../app/api/plans/route";
import { PATCH as deferredNumberPATCH } from "../app/api/patients/[id]/number/route";

/**
 * (TD-06 / TD-REG-009) كل فعل كتابة يكتب سطر تدقيق — أو مستثنى بسببه.
 *
 * تحليلٌ ثابت لرسم الاستدعاء: معالج الفعل يُدقِّق إن كتب سطرًا بنفسه (`recordAudit`)، أو
 * استدعى — مباشرةً أو عبر دوال ملفه — دالةً من `lib/` تكتبه (`insertAuditRow`،
 * `INSERT INTO audit_log`، …) ولو بوسيط. الحارس يقيس **وجود** مسار تدقيق في المعالج، لا
 * كل فرعٍ فيه — **حدّه المعلن:** معالجٌ يُدقِّق في فرعٍ ولا يُدقِّق في آخر ناجح يمرّ هنا، فكل مسارٍ
 * له فروع تدقيقٍ مشروطة (سعر مخالف، رد...) يحتاج اختبارًا سلوكيًّا يغطي الفرع العادي أيضًا
 * (انظر `audit-coverage-http.test.ts`: إضافة بند بسعر الدليل). وُجد بهذا ثغرةٌ فعلية: بند الخطة
 * كان يُدقَّق عند مخالفة السعر وحدها.
 */

const ROOT = process.cwd();
const FUNCTION_START = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*[<(]|^(?:export\s+)?const\s+([A-Za-z0-9_]+)\s*=\s*(?:async\s*)?\(/gm;
/** استدعاء: `name(` أو `name<T>(` (الأنواع العامة، على سطرٍ واحد — فلا يبتلع نوعٌ عامٌّ ما بعده). */
const CALL = /\b([A-Za-z_][A-Za-z0-9_]*)\s*(?:<[^()\n;]*?>)?\s*\(/g;
const WRITES_AUDIT = /recordAudit\(|insertAuditRow\(|INSERT INTO audit_log|auditVisitStep\(|saveSettingsAudited\(/;
const MUTATING = ["POST", "PUT", "PATCH", "DELETE"] as const;

function walk(dir: string, accept: (name: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, accept));
    else if (accept(entry.name)) out.push(full);
  }
  return out;
}

/** جسم كل دالةٍ على المستوى الأعلى — من بدايتها إلى بداية التالية. */
function splitFunctions(source: string): Map<string, string> {
  const starts = [...source.matchAll(FUNCTION_START)];
  const bodies = new Map<string, string>();
  starts.forEach((match, index) => {
    const name = match[1] ?? match[2];
    const end = index + 1 < starts.length ? starts[index + 1].index! : source.length;
    bodies.set(name, (bodies.get(name) ?? "") + source.slice(match.index!, end));
  });
  return bodies;
}

function callsIn(body: string): Set<string> {
  // recordExpense has a read-only quote branch that returns before its audit/write
  // path. Do not count that edge as proof of auditing. Only a literal, unambiguous
  // quoteOnly:true qualifies; dynamic options remain conservatively audited.
  const source = ts.createSourceFile("audit-scan.ts", body, ts.ScriptTarget.Latest, true);
  const quoteCalls = new Set<number>();
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
      && node.expression.text === "recordExpense" && node.arguments.length === 1) {
      const options = node.arguments[0];
      if (ts.isObjectLiteralExpression(options) && options.properties.every(property =>
        ts.isPropertyAssignment(property)
        && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)))) {
        const flags = options.properties.filter(property => ts.isPropertyAssignment(property)
          && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
          && property.name.text === "quoteOnly");
        if (flags.length === 1 && ts.isPropertyAssignment(flags[0])
          && flags[0].initializer.kind === ts.SyntaxKind.TrueKeyword) {
          quoteCalls.add(node.expression.getStart(source));
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return new Set([...body.matchAll(CALL)]
    .filter(match => !quoteCalls.has(match.index!)).map(match => match[1]));
}

/** دوال lib التي تكتب سطر تدقيق — مباشرةً أو عبر دالةٍ تكتبه (نقطة ثابتة). */
function auditingLibFunctions(): Set<string> {
  const bodies = new Map<string, string>();
  for (const file of walk(join(ROOT, "lib"), (name) => name.endsWith(".ts"))) {
    for (const [name, body] of splitFunctions(readFileSync(file, "utf8"))) bodies.set(name, (bodies.get(name) ?? "") + body);
  }
  const audited = new Set([...bodies].filter(([, body]) => WRITES_AUDIT.test(body)).map(([name]) => name));
  const calls = new Map([...bodies].map(([name, body]) => [name, callsIn(body)]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, called] of calls) {
      if (audited.has(name)) continue;
      for (const callee of called) {
        if (callee !== name && audited.has(callee)) { audited.add(name); changed = true; break; }
      }
    }
  }
  return audited;
}

function handlerAudits(local: Map<string, string>, handler: string, audited: Set<string>): boolean {
  const seen = new Set<string>();
  const stack = [handler];
  while (stack.length > 0) {
    const name = stack.pop()!;
    if (seen.has(name)) continue;
    seen.add(name);
    const body = local.get(name) ?? "";
    if (WRITES_AUDIT.test(body)) return true;
    for (const callee of callsIn(body)) {
      if (local.has(callee)) stack.push(callee);
      else if (audited.has(callee)) return true;
    }
  }
  return false;
}

// A retired mutation is not an audit-exempt writer: every admitted request
// terminates in 409, after the original authentication/body/role/patient checks.
// Pin its entire handler so a future call/branch cannot silently inherit this
// classification. Behavioral checks below and plans-creation-entry.test.ts cover
// refusal, preserved policy, body limits and no writer/success-audit invocation;
// plan-creation-entry-http.test.ts covers proxy policy and unchanged DB rows.
// New-only numbering also retains an authenticated refusal endpoint (403).
// Its exact handler hash and behavior below prevent a writer inheriting this
// classification; patient-numbering-new-only-http.test.ts covers real CSRF/DB.
const REFUSAL_ONLY = {
  "PATCH /api/patients/[id]/number": {
    reason: "تعديل الرقم الحالي مؤجل: رفض بعد التحقق من الجلسة والصلاحية، بلا كتابة أو تدقيق نجاح.",
    sha256: "97ab64b41d579fb1fc9d831eb7b64a4adca386c3f05dc69e7651009e744a08c2",
  },
  "POST /api/plans": {
    reason: "إنشاء الخطط القديم موقوف: رفض 409 بعد الصلاحيات، بلا كتابة أو تدقيق نجاح.",
    sha256: "cd5aa5ddddd9ccb7aba89bbdb3d060c96113a7a6226e1167f67634612a23ac2e",
  },
};
const audited = auditingLibFunctions();
const handlers = walk(join(ROOT, "app", "api"), (name) => name === "route.ts").flatMap((file) => {
  const route = `/${relative(join(ROOT, "app"), file).replace(/\\/g, "/").replace(/\/route\.ts$/, "")}`;
  const local = splitFunctions(readFileSync(file, "utf8"));
  return MUTATING.filter((method) => local.has(method)).map((method) => ({
    key: `${method} ${route}`,
    audits: handlerAudits(local, method, audited),
    sha256: createHash("sha256").update(local.get(method)!).digest("hex"),
  }));
});

describe("TD-06: تغطية التدقيق لكل فعل كتابة", () => {
  it("distinguishes the read-only expense quote from mandatory create auditing", () => {
    expect(audited.has("recordExpense")).toBe(true);
    expect(handlers.find(handler => handler.key === "POST /api/expenses")?.audits).toBe(true);
    expect(handlers.find(handler => handler.key === "POST /api/expenses/quote")?.audits).toBe(false);
    expect(AUDIT_EXEMPT).toHaveProperty("POST /api/expenses/quote");
    expect(AUDIT_EXEMPT).not.toHaveProperty("POST /api/expenses");
  });

  it("only omits an unambiguous literal quote call, not writes or uncertain options", () => {
    expect(callsIn('recordExpense({ amountMinor: value.amountMinor, quoteOnly: true });')
      .has("recordExpense")).toBe(false);
    for (const options of [
      '{}', '{ quoteOnly: false }', '{ quoteOnly: value }', 'options',
      '{ quoteOnly: true, ...options }', '{ ...options, quoteOnly: true }',
      '{ quoteOnly: true, quoteOnly: false }', '{ [field]: false, quoteOnly: true }',
    ]) expect(callsIn(`recordExpense(${options});`).has("recordExpense")).toBe(true);
    expect(callsIn('recordExpense({ quoteOnly: true }); recordExpense({ quoteOnly: false });')
      .has("recordExpense")).toBe(true);
    expect(callsIn('recordExpense({ quoteOnly: true, amountMinor: recordAudit() });')
      .has("recordAudit")).toBe(true);
  });

  it("الحارس يرى أفعال الكتابة فعلًا (لا قائمة فارغة تمرّ صامتة)", () => {
    expect(handlers.length).toBeGreaterThan(150);
    expect(audited.has("recordPlanInstallment")).toBe(true);
    expect(audited.has("setPlanStatus")).toBe(true);
  });

  it("كل فعل كتابة يدقق أو يستثنى بسببه؛ ومسار الرفض يطابق عقده المثبت", () => {
    const refusalOnly = new Map(Object.entries(REFUSAL_ONLY));
    const uncovered = handlers.filter((handler) => !handler.audits && !(handler.key in AUDIT_EXEMPT)
      && refusalOnly.get(handler.key)?.sha256 !== handler.sha256).map((handler) => handler.key);
    expect(uncovered).toEqual([]);
  });

  it("لا استثناء ميت: كل استثناء لفعلٍ موجود ولا يُدقَّق", () => {
    const keys = new Map(handlers.map((handler) => [handler.key, handler.audits]));
    const stale = Object.keys(AUDIT_EXEMPT).filter((key) => !keys.has(key) || keys.get(key) === true);
    expect(stale).toEqual([]);
  });

  it("كل استثناء يحمل سببًا عربيًّا", () => {
    for (const [key, reason] of Object.entries(AUDIT_EXEMPT)) {
      expect({ key, ok: /[؀-ۿ]/.test(reason) && reason.length > 15 }).toEqual({ key, ok: true });
    }
  });
  it("تصنيف الرفض موثق ولا يغطي مسارًا مفقودًا أو كاتبًا أو مستثنى", () => {
    for (const [key, contract] of Object.entries(REFUSAL_ONLY)) {
      expect(contract.reason).toMatch(/[؀-ۿ]/);
      expect(contract.reason.length).toBeGreaterThan(15);
      expect(AUDIT_EXEMPT).not.toHaveProperty(key);
      expect(handlers.filter(handler => handler.key === key)).toEqual([
        { key, audits: false, sha256: contract.sha256 },
      ]);
    }
  });

  it.each([
    { role: null, edit: true, owns: true, status: 401 },
    { role: "assistant", edit: true, owns: true, status: 403 },
    { role: "accountant", edit: true, owns: true, status: 403 },
    { role: "doctor", edit: false, owns: true, status: 403 },
    { role: "doctor", edit: true, owns: false, status: 403 },
    { role: "doctor", edit: true, owns: true, status: 409 },
    { role: "admin", edit: true, owns: true, status: 409 },
    { role: "reception", edit: true, owns: true, status: 409 },
    // The direct handler retains canHandleMoney; HTTP proxy still denies cashier.
    { role: "cashier", edit: true, owns: true, status: 409 },
  ])("retired POST plans: $role edit=$edit owned=$owns keeps $status and never writes", async ({ role, edit, owns, status }) => {
    vi.resetAllMocks();
    retired.session.mockResolvedValue(role ? { role, username: "synthetic-audit", partyId: 7 } : null);
    retired.user.mockResolvedValue({ partyId: 7, permissions: { canEditPlans: edit } });
    retired.owns.mockResolvedValue(owns);
    const request = new Request("http://test.invalid/api/plans", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ patientId: 91, mode: "v2", title: "Synthetic refusal", fromInvoice: true }),
    });
    const response = await retiredPlanPOST(request);
    expect(response.status).toBe(status);
    if (status === 409) expect(await response.json()).toEqual({
      code: "PLAN_CREATION_ENTRY_REQUIRED",
      message: "ابدأ العلاج من الفاتورة أو الاتفاق السابق للنظام في حساب المريض.",
    });
    if (!role) expect(request.bodyUsed).toBe(false);
    if (role === "doctor") {
      expect(retired.user).toHaveBeenCalledExactlyOnceWith("synthetic-audit");
      if (edit) expect(retired.owns).toHaveBeenCalledExactlyOnceWith(7, 91);
      else expect(retired.owns).not.toHaveBeenCalled();
    } else {
      expect(retired.user).not.toHaveBeenCalled(); expect(retired.owns).not.toHaveBeenCalled();
    }
    expect(retired.write).not.toHaveBeenCalled();
  });

  it.each([null, "admin", "doctor", "reception", "assistant", "cashier", "accountant"])(
    "deferred numbering PATCH: %s never invokes a writer or success audit", async role => {
      vi.resetAllMocks();
      retired.session.mockResolvedValue(role ? {role, username: "synthetic-audit"} : null);
      const response = await deferredNumberPATCH();
      expect(response.status).toBe(role ? 403 : 401);
      if (role === "admin") expect(await response.json()).toMatchObject({code: "number_edit_deferred"});
      expect(retired.write).not.toHaveBeenCalled();
      expect(retired.user).not.toHaveBeenCalled();
      expect(retired.owns).not.toHaveBeenCalled();
    },
  );

});
