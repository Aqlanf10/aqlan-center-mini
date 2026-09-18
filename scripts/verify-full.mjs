#!/usr/bin/env node
import "./load-env.mjs";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  GATE_DATABASE_URL_ENV_NAMES,
  checkDatabaseUrlForGates,
} from "../lib/env-contract.ts";

/**
 * npm run verify:full — البوابةُ المحلية الكاملة الواحدة (TD-02 / TD-REG-013).
 *
 * قبلها كان «npm test نجح» يعني أن الوحدات نجحت — لا أن البوابة الإلزامية
 * نجحت: اختبارات PostgreSQL الحقيقية ورحلات التحقق واختبارات الأمن على HTTP
 * خارج `npm test` بتصميمٍ (كلٌّ منها يحتاج بيئته)، فكان الفرقُ بين الجهاز
 * المحلي وCI فرقًا يعرفُه مَن قرأ ملف الـworkflow فقط.
 *
 * هذه البوابة تُشغّل **كل بوابة CI أساسية فاشلةٍ بذاتها** — البوابات كلها،
 * بالترتيب نفسه، بلا تخطٍّ صامت:
 *
 *  1.  عقد البيئة (verify:environment)                     — كما في CI
 *  2.  الأنواع (typecheck)                                   — كما في CI
 *  3.  التنقيط (lint)                                         — كما في CI
 *  4.  اختبارات الوحدة (test)                                 — كما في CI
 *  5.  اختبارات PostgreSQL الحقيقية (test:postgres)           — كما في CI
 *  6.  توليد عقد المخطط الحالي على PostgreSQL 18 (schema:contract)
 *      — فاشلةٌ بذاتها (فحص major قبل الكتابة)؛ بعد التوليد يُستعاد الملف
 *      الملتزم وتُحفظ النسخة الطازجة في مجلد الأثر — عين سلوك CI
 *      (نسخ إلى /tmp ثم `git checkout --`) بلا اقتلاع عملٍ غير ملتزم.
 *  7.  رحلات التحقق التشغيلية (verify:ci) — وتشمل رحلة verify:schema
 *      التي تطابق البناء الطازج بالعقد الملتزم               — كما في CI
 *  8.  توليد بيان خط الأساس المرشّح (db:baseline:manifest)    — كما في CI
 *      إلى ملف مؤقت خارج المستودع (لا يلمس الملتزم).
 *  9.  تحقق بيان خط الأساس الملتزم ضد التوليد الطازج
 *      (db:baseline:manifest:verify --fresh) — **بوابة أمان**، لا خطوة رفع أثر.
 * 10.  تدقيق الاعتماديات (ci:audit)                           — كما في CI
 * 11.  ماسح قارئات الأجسام (ci:scan:body)                     — كما في CI
 * 12.  بناء الإنتاج (build)                                    — كما في CI
 * 13.  اختبارات الأمن على HTTP (test:security-http)            — كما في CI
 *
 * ما يبقى CI-only هو رفعُ الآثار (artifacts) وتثبيت Chromium — خطوات منشأ
 * وإثبات مصدر لا بوابات فحص، موثَّقة في docs/ENVIRONMENT_CI_PARITY.md.
 *
 * متطلبات قبل التشغيل (يفحصها هذا السكربت ويشرحها عند غيابها):
 *  * Node داخل العقد (‎.nvmrc / engines) — يفحصها verify:environment أولًا.
 *  * قاعدة PostgreSQL 18 حقيقية (docker compose up -d pg18) برابطين صريحين:
 *      TEST_DATABASE_URL = قاعدة اختبار التكامل (aqlan_p1_test)
 *      DATABASE_URL      = قاعدة الصيانة للرحلات التشغيلية (postgres)
 *    (تصحيح مراجعة المالك: الرحلات تقرأ DATABASE_URL وحده — من ضبط رابط
 *    الاختبار فقط عبر البوابة ثم رأى الرحلات تتخطى، فالفحص المسبق يطالب
 *    بالرابطين معًا ويمنع USE_LOCAL_DB.)
 *  * Chromium لرحلات المتصفح (npx playwright install --with-deps chromium).
 */

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

/** مجلد أثرٍ مؤقت خارج المستودع — عين دور /tmp في CI (رفع الأثر CI-only). */
const provenanceDir = mkdtempSync(join(tmpdir(), "verify-full-"));
const BASELINE_MANIFEST_CANDIDATE = join(provenanceDir, "baseline-schema-manifest.json");
const SCHEMA_CONTRACT_CANDIDATE = join(provenanceDir, "current-schema-contract.pg18.json");
const SCHEMA_CONTRACT_COMMITTED = join(repoRoot, "schema", "current-schema-contract.pg18.json");

/** الطريق المحلي الموثَّق — يُطبع عند نقص المتطلبات ويُختبر في __tests__. */
export const DOCUMENTED_FULL_GATE_SETUP = {
  composeUp: "docker compose up -d pg18",
  databaseUrl: "postgresql://ci:ci@127.0.0.1:54329/postgres?sslmode=disable",
  testDatabaseUrl: "postgresql://ci:ci@127.0.0.1:54329/aqlan_p1_test?sslmode=disable",
  command: "npm run verify:full",
};

function documentedSetupHint() {
  return "أسرع طريق مُوثَّق (PostgreSQL 18 على المنفذ 54329):\n"
    + `    ${DOCUMENTED_FULL_GATE_SETUP.composeUp}\n`
    + `    DATABASE_URL=${DOCUMENTED_FULL_GATE_SETUP.databaseUrl} \\\n`
    + `    TEST_DATABASE_URL=${DOCUMENTED_FULL_GATE_SETUP.testDatabaseUrl} \\\n`
    + `      ${DOCUMENTED_FULL_GATE_SETUP.command}`;
}

/**
 * فحص متطلبات قاعدة البيئة — مُصدَّر ليُختبر عليه قرار البيئة الموثَّق
 * (تصحيح مراجعة المالك: تغطية تنفيذية لا نصية).
 */
export function databasePreflight(environment = process.env) {
  const problems = [];
  const warnings = [];
  const ci = environment.CI === "true";
  const testUrl = environment.TEST_DATABASE_URL?.trim() || "";
  const runtimeUrl = environment.DATABASE_URL?.trim() || "";

  if (!testUrl) {
    problems.push(
      "TEST_DATABASE_URL غير مضبوط — رابط قاعدة **اختبار التكامل** (aqlan_p1_test): "
      + "اختبارات PostgreSQL الحقيقية واختبارات الأمن وبيان خط الأساس تقرؤه.\n"
      + documentedSetupHint(),
    );
  }
  if (!runtimeUrl) {
    problems.push(
      "DATABASE_URL غير مضبوط — رابط قاعدة **الصيانة** للرحلات التشغيلية (postgres): "
      + "الرحلات تقرؤه وحده، وبغيابه تتخطى لا تنجح.\n"
      + documentedSetupHint(),
    );
  }
  if (environment.USE_LOCAL_DB === "true") {
    problems.push(
      "USE_LOCAL_DB=true يناقض البوابة الكاملة — رحلات PostgreSQL الحقيقية جزءٌ "
      + "من عقد CI ولا تُثبت على PGlite. أزل المتغير ثم أعد التشغيل.",
    );
  }
  // فحص أمان ساكن لكل مسار اتصال مضبوط — لا اتصال يُفتح هنا.
  for (const varName of GATE_DATABASE_URL_ENV_NAMES) {
    const raw = environment[varName]?.trim();
    if (!raw) continue;
    const violation = checkDatabaseUrlForGates(raw, varName, { ci });
    if (violation) problems.push(`[${violation.rule}] ${violation.message}`);
  }
  if (testUrl && runtimeUrl && testUrl === runtimeUrl) {
    warnings.push(
      "TEST_DATABASE_URL وDATABASE_URL على الرابط نفسه — العقد الموثَّق يفصلهما: "
      + "الأول قاعدة اختبار التكامل (aqlan_p1_test) والثاني قاعدة صيانة الرحلات "
      + "(postgres). البوابة تعمل، لكن الفصل الموثَّق أوضح للتشخيص.",
    );
  }
  return { problems, warnings };
}

/** خطوات البوابة الكاملة — يُختبر وجودُ كلٍّ منها في __tests__/environment-parity.test.ts. */
export const FULL_GATE_STEPS = [
  { name: "عقد البيئة", command: ["npm", "run", "verify:environment"] },
  { name: "الأنواع", command: ["npm", "run", "typecheck"] },
  { name: "التنقيط", command: ["npm", "run", "lint"] },
  { name: "اختبارات الوحدة", command: ["npm", "test"] },
  { name: "اختبارات PostgreSQL الحقيقية", command: ["npm", "run", "test:postgres"] },
  {
    name: "توليد عقد المخطط الحالي على PostgreSQL 18",
    command: ["npm", "run", "schema:contract"],
    /** يُستعاد الملف الملتزم بعد التوليد (عين `git checkout --` في CI) وتُحفظ النسخة في مجلد الأثر. */
    regeneratesCommittedSchemaContract: true,
  },
  { name: "رحلات التحقق التشغيلية", command: ["npm", "run", "verify:ci"] },
  {
    name: "توليد بيان خط الأساس المرشّح (PostgreSQL 18)",
    command: ["npm", "run", "db:baseline:manifest", "--", "--output", BASELINE_MANIFEST_CANDIDATE],
  },
  {
    name: "تحقق بيان خط الأساس الملتزم ضد التوليد الطازج",
    command: ["npm", "run", "db:baseline:manifest:verify", "--", "--fresh", BASELINE_MANIFEST_CANDIDATE],
  },
  { name: "تدقيق الاعتماديات", command: ["npm", "run", "ci:audit"] },
  { name: "ماسح قارئات الأجسام", command: ["npm", "run", "ci:scan:body"] },
  { name: "بناء الإنتاج", command: ["npm", "run", "build"] },
  { name: "اختبارات الأمن على HTTP", command: ["npm", "run", "test:security-http"] },
];

/** متطلبات بيئة تُشرح قبل أن يصطدم بها الـsteps لاحقًا برسائلٍ أقل تحديدًا. */
async function preflight() {
  const problems = [];
  const { problems: dbProblems, warnings } = databasePreflight();
  problems.push(...dbProblems);
  for (const warning of warnings) console.log(`  تنبيه: ${warning}`);
  // عقد المخطط الملتزم: تقرأ البوابة محتواه قبل توليده لتستعيده بعده — غيابه عائقٌ صريح.
  try {
    readFileSync(SCHEMA_CONTRACT_COMMITTED, "utf8");
  } catch {
    problems.push(
      `schema/current-schema-contract.pg18.json غير مقروء — بوابة التوليد تحتاج الملف الملتزم موجودًا (تُستعاد نسخته بعد التوليد).`,
    );
  }
  // Chromium: نستعلم مسار التنفيذ من playwright نفسه — لا تخمينَ للمسارات.
  try {
    const playwright = await import("playwright");
    const executable = playwright.chromium.executablePath();
    if (!existsSync(executable)) {
      problems.push(
        `Chromium غير مثبَّت (${executable}) — رحلات المتصفح واختبارات الأمن تحتاجه:\n`
        + "    npx playwright install --with-deps chromium",
      );
    }
  } catch {
    problems.push("تعذّر قراءة حزمة playwright — شغّل npm ci أولًا.");
  }
  return problems;
}

function runStep(step, context) {
  return new Promise((resolve) => {
    const started = Date.now();
    console.log(`\n═══ بوابة كاملة · ${step.name} ═══`);
    const child = spawn(step.command[0], step.command.slice(1), {
      stdio: "inherit",
      cwd: repoRoot,
      env: process.env,
    });
    child.on("error", (error) => {
      restoreCommittedSchemaContract(step, context);
      resolve({ ...step, ok: false, seconds: 0, error: error.message });
    });
    child.on("close", (code) => {
      restoreCommittedSchemaContract(step, context);
      resolve({ ...step, ok: code === 0, seconds: (Date.now() - started) / 1000 });
    });
  });
}

/**
 * عين سلوك CI بعد `npm run schema:contract`: نسخ الطازج إلى الأثر ثم استعادة
 * الملف الملتزم — لكن بلا git: المحتوى قُرئ قبل الخطوة فيُكتب كما كان، فلا
 * يُقتلع عملٌ غير ملتزم إن وُجد، ولا يبقى الملف معدَّلًا بعد البوابة.
 */
function restoreCommittedSchemaContract(step, context) {
  if (!step?.regeneratesCommittedSchemaContract || !context?.committedSchemaContract) return;
  try {
    try {
      const generated = readFileSync(SCHEMA_CONTRACT_COMMITTED, "utf8");
      writeFileSync(SCHEMA_CONTRACT_CANDIDATE, generated, "utf8");
      console.log(`  نسخة الأثر (كخطوة CI): ${SCHEMA_CONTRACT_CANDIDATE}`);
    } catch {
      // التوليد لم يكتب ملفًا — لا نسخة أثر لهذه الجولة.
    }
    writeFileSync(SCHEMA_CONTRACT_COMMITTED, context.committedSchemaContract, "utf8");
  } catch (error) {
    console.error(`  ✘ تعذّرت استعادة عقد المخطط الملتزم: ${error?.message ?? error}`);
  }
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  const problems = await preflight();
  if (problems.length > 0) {
    console.error("✘ متطلبات البوابة الكاملة ناقصة — هذا فشل بيئةٍ لا فشل كود:");
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  const context = { committedSchemaContract: readFileSync(SCHEMA_CONTRACT_COMMITTED, "utf8") };
  const results = [];
  for (const step of FULL_GATE_STEPS) {
    const result = await runStep(step, context);
    results.push(result);
    if (!result.ok) {
      const remaining = FULL_GATE_STEPS.slice(results.length).map((s) => s.name);
      console.error(`\n✘ سقطت البوابة: ${result.name}${result.error ? ` (${result.error})` : ""}`);
      if (remaining.length > 0) console.error(`  البوابات المتبقية (لم تُشغَّل): ${remaining.join("، ")}`);
      console.error("  البوابة الكاملة لا تتجاوز خطوةً ساقطة — أصلح ثم أعد التشغيل من أوله.");
      process.exit(1);
    }
  }
  const totalSeconds = results.reduce((sum, r) => sum + r.seconds, 0);
  console.log(`\n✓ البوابة الكاملة نجحت — ${results.length}/${FULL_GATE_STEPS.length} خطوة في ${(totalSeconds / 60).toFixed(1)} دقيقة.`);
  console.log("  كل بوابة CI أساسية فاشلةٍ بذاتها جرت هنا (رفع الآثار وتثبيت Chromium فقط CI-only).");
  console.log(`  أثر هذه الجولة (عقد المخطط + بيان خط الأساس): ${provenanceDir}`);
  process.exit(0);
}
