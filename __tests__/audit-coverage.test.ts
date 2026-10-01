import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { AUDIT_EXEMPT } from "@/lib/audit-coverage";

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
  return new Set([...body.matchAll(CALL)].map((match) => match[1]));
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

const audited = auditingLibFunctions();
const handlers = walk(join(ROOT, "app", "api"), (name) => name === "route.ts").flatMap((file) => {
  const route = `/${relative(join(ROOT, "app"), file).replace(/\\/g, "/").replace(/\/route\.ts$/, "")}`;
  const local = splitFunctions(readFileSync(file, "utf8"));
  return MUTATING.filter((method) => local.has(method)).map((method) => ({
    key: `${method} ${route}`,
    audits: handlerAudits(local, method, audited),
  }));
});

describe("TD-06: تغطية التدقيق لكل فعل كتابة", () => {
  it("الحارس يرى أفعال الكتابة فعلًا (لا قائمة فارغة تمرّ صامتة)", () => {
    expect(handlers.length).toBeGreaterThan(150);
    expect(audited.has("recordPlanInstallment")).toBe(true);
    expect(audited.has("setPlanStatus")).toBe(true);
  });

  it("كل فعل كتابة يكتب سطر تدقيق أو مستثنى بسببه في lib/audit-coverage.ts", () => {
    const uncovered = handlers.filter((handler) => !handler.audits && !(handler.key in AUDIT_EXEMPT)).map((handler) => handler.key);
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
});
