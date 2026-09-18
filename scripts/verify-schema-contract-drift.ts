#!/usr/bin/env node
/**
 * npm run schema:contract:verify — بوابة الانحراف البنيوي لعقد المخطط الحالي.
 *
 * ليست هذه بوابة verify:schema ولا بديلًا عنها: ذاك يقارن البناء الطازج بعقدٍ
 * ملتزم بمنطق المجموعة الجزئية (العقد ⊆ الواقع؛ الزيادة تُعلَن لا تُفشِل) —
 * حمايةٌ مستقلة باقية كما هي. وهذه البوابة تجيب سؤالًا آخر تمامًا:
 *
 *   هل `schema/current-schema-contract.pg18.json` نفسه ما زال يصف ما يبنيه
 *   الكود **اليوم** — بنيويًّا حرفيًّا؟
 *
 * قبلها كان CI يولّد العقد الطازج ثم يستعيد الملف الملتزم فورًا (نسخ إلى
 * /tmp ثم `git checkout --`) **بلا مقارنة** — فكان عقدٌ متقادم يمرّ أخضر: الرحلات
 * ترى الزيادة فتعلنها (لا تفشل)، والملف لا يُحدَّث، والانحراف يعيش. الآن كل
 * فرقٍ بنيوي بين الملتزم والطازج يُفشل البناء برمز SCHEMA_CONTRACT_DRIFT.
 *
 * المقارنة canonical/بنيوية: تُهمل حقول المصدر وحدها (generatedBy و
 * generatedOnServerVersion — ترقية minor لصورة CI لا تغيّر كائنًا مخططيًّا،
 * فـ18.4 مقابل 18.6 تمرّ ما دام major=18 والبنية متطابقة)، وتقارن الصيغة
 * (format/formatVersion) والعدّادات والجداول كلها: الأعمدة بأنواعها وقبولها
 * للعدم، والمفاتيح الأساسية، وقيود الفرادة والفحص، والإشارات، والفهارس
 * بفرادتها، والمشغّلات بتوقيتها وأحداثها.
 *
 * الاستعمال:
 *   npm run schema:contract:verify
 *     يولّد عقدًا طازجًا من بناءٍ على PostgreSQL 18 عبر DATABASE_URL — نفس طريق
 *     التوليد حرفيًّا (withFreshSchema → ensureSchema → introspectSchema) — ثم
 *     يقارنه بالملتزم.
 *   npm run schema:contract:verify -- --fresh /tmp/current-schema-contract.pg18.json
 *     يقارن ملفًا طازجًا جاهزًا (كما تفعل CI) ضد الملتزم.
 *   ‎--committed <path>  افتراضيًّا schema/current-schema-contract.pg18.json من
 *   شجرة العمل — وفي CI يُمرَّر صراحةً من `git show HEAD:` لأن المقارنة تجري
 *   **قبل** استعادة الملف الملتزم فوق شجرة العمل.
 */
import "./load-env.mjs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import {
  SUPPORTED_POSTGRES_MAJOR,
  assertPostgresMajorOrThrow,
  postgresMajorFromVersionNum,
} from "../lib/env-contract";
import { sslFor, withFreshSchema } from "./build-current-schema";
import type { SchemaContract } from "./schema-introspect";

/** رمز الفشل التعاقدي — يُطبع ويُخرج exit 1 عند أي انحراف بنيوي. */
export const SCHEMA_CONTRACT_DRIFT_MARKER = "SCHEMA_CONTRACT_DRIFT";

const COMMITTED_CONTRACT_PATH = "schema/current-schema-contract.pg18.json";

/** حقول مصدرٍ (provenance) تُقال ولا تُقارن: minor الإصدار لا يمسّ البنية. */
export const IGNORED_PROVENANCE_FIELDS = ["generatedBy", "generatedOnServerVersion"] as const;

/** الحقول البنيوية المقارَنة — كل ما في العقد عدا المصدر. */
export const COMPARED_STRUCTURAL_FIELDS = ["format", "formatVersion", "counts", "tables"] as const;

export interface SchemaContractDiffEntry {
  /** مسار الفرق داخل العقد — tables.invoices.columns.amount_minor.type مثلًا. */
  path: string;
  committed: string;
  fresh: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describe(value: unknown): string {
  if (value === undefined) return "(غائب)";
  const text = JSON.stringify(value);
  if (text === undefined) return String(value);
  return text.length > 160 ? `${text.slice(0, 160)}…` : text;
}

function joinPath(base: string, key: string): string {
  return base ? `${base}.${key}` : key;
}

/**
 * المظهر البنيوي canonical: إسقاط حقول المصدر ثم فرز مفاتيح كل كائن (ترتيب
 * المفاتيح ليس بنيةً). المصفوفات لا تُفرز — ترتيبها جزءٌ من المعنى (ترتيب
 * أعمدة المفتاح/الفهرس) والمولّد يرتبها أصلًا ترتيبًا حتميًّا.
 */
export function canonicalizeStructuralContract(contract: SchemaContract): Record<string, unknown> {
  const source = contract as unknown as Record<string, unknown>;
  const structural: Record<string, unknown> = {};
  for (const field of COMPARED_STRUCTURAL_FIELDS) structural[field] = source[field];
  return sortKeysDeep(structural) as Record<string, unknown>;
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (!isRecord(value)) return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) sorted[key] = sortKeysDeep(value[key]);
  return sorted;
}

/**
 * الفروق البنيوية بين عقدين — مسارًا مسارًا حتى العمق كله. جدولٌ زائد أو ناقص،
 * عمودٌ أو نوعٌ أو قابلية عدم، مفتاح/فرادة/فحص/إشارة، فهرسٌ أو مُشغِّل، عدّاد —
 * كلها فروقٌ تُعاد بالمسار الدقيق لتُقرأ في سجل الفشل.
 */
export function structuralDiffs(committed: SchemaContract, fresh: SchemaContract): SchemaContractDiffEntry[] {
  const diffs: SchemaContractDiffEntry[] = [];
  walk("", canonicalizeStructuralContract(committed), canonicalizeStructuralContract(fresh), diffs);
  return diffs;
}

function walk(current: string, committed: unknown, fresh: unknown, diffs: SchemaContractDiffEntry[]): void {
  if (Object.is(committed, fresh)) return;
  if (isRecord(committed) && isRecord(fresh)) {
    /* اتحاد مفاتيح الطرفين **بلا تكرار** — المفتاح المشترك يُزار مرة واحدة
       وإلا دُبل كل فرقٍ تحت مسارٍ مشترك. */
    const keys = [...new Set([...Object.keys(committed), ...Object.keys(fresh)])].sort();
    for (const key of keys) {
      walk(joinPath(current, key), committed[key], fresh[key], diffs);
    }
    return;
  }
  if (Array.isArray(committed) && Array.isArray(fresh)) {
    if (committed.length !== fresh.length) {
      diffs.push({
        path: `${current || "(الجذر)"} — عدد العناصر`,
        committed: String(committed.length),
        fresh: String(fresh.length),
      });
    }
    const shared = Math.min(committed.length, fresh.length);
    for (let index = 0; index < shared; index += 1) {
      walk(`${current}[${index}]`, committed[index], fresh[index], diffs);
    }
    return;
  }
  diffs.push({ path: current || "(الجذر)", committed: describe(committed), fresh: describe(fresh) });
}

/** major من نص إصدار الخادم المسجَّل في العقد — "18.4" ⇒ 18 (وnull لغير القابل للتفسير). */
export function serverMajorFromContractVersion(version: string): number | null {
  const match = /^(\d+)(?:\.|$)/.exec(String(version ?? "").trim());
  return match ? Number(match[1]) : null;
}

/**
 * مشاكل المصدر التي تُفشل رغم إهمال النص الكامل: major غير 18 في أي طرف (ملف
 * ‎.pg18 اسمٌ كاذب) — والطرفان إذا اختلف major فهما أصلاً على غير 18 أحدهما
 * فتُمسك القاعدة نفسها.
 */
export function provenanceMajorProblems(committed: SchemaContract, fresh: SchemaContract): string[] {
  const problems: string[] = [];
  const committedMajor = serverMajorFromContractVersion(String(committed.generatedOnServerVersion ?? ""));
  const freshMajor = serverMajorFromContractVersion(String(fresh.generatedOnServerVersion ?? ""));
  if (committedMajor !== SUPPORTED_POSTGRES_MAJOR) {
    problems.push(
      `الملف الملتزم وُلّد على major ${committedMajor ?? "غير معروف"} — الملف ‎.pg18 لا يُقبل إلا من PostgreSQL ${SUPPORTED_POSTGRES_MAJOR}.`,
    );
  }
  if (freshMajor !== SUPPORTED_POSTGRES_MAJOR) {
    problems.push(
      `العقد الطازج وُلّد على major ${freshMajor ?? "غير معروف"} — التوليد مقصور على PostgreSQL ${SUPPORTED_POSTGRES_MAJOR}.`,
    );
  }
  return problems;
}

/** قراءة عقد من ملف مع تحقق الصيغة — JSON تالف أو صيغة غريبة ⇒ خطأ صريح (فشل مغلق). */
export async function loadSchemaContractFile(file: string, role: string): Promise<SchemaContract> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    throw new Error(`${role}: تعذّرت قراءة ${file} — ${(error as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${role}: JSON تالف في ${file} — ${(error as Error).message}`);
  }
  if (!isRecord(parsed) || parsed.format !== "aqlan-current-schema-contract" || parsed.formatVersion !== 1) {
    throw new Error(`${role}: ${file} ليس عقد مخططٍ حاليًّا بصيغة مدعومة (format/formatVersion).`);
  }
  if (!isRecord(parsed.tables) || !isRecord(parsed.counts)) {
    throw new Error(`${role}: ${file} ناقص البنية — tables وcounts مطلوبتان.`);
  }
  const knownFields = new Set<string>([...COMPARED_STRUCTURAL_FIELDS, ...IGNORED_PROVENANCE_FIELDS]);
  for (const key of Object.keys(parsed)) {
    if (!knownFields.has(key)) {
      throw new Error(
        `${role}: ${file} يحمل حقلًا غير معروف («${key}») — البوابة تقارن عقدًا معروف الحقول حصرًا (فشل مغلق لا تجاهل).`,
      );
    }
  }
  return parsed as unknown as SchemaContract;
}

/**
 * فحص major قبل البناء — عين فحص المولّد قبل الكتابة (TD-REG-008): لا عقد pg18
 * من خادم آخر. (يُكرَّر هنا لأن استيراد المولّد نفسه يُشغّل main() — فالبقاء على
 * الطريق الموثَّق الأصغر أنظف من خلط وحدتين تنفّذان عند الاستيراد.)
 */
async function assertLivePostgres18(source: string): Promise<void> {
  const client = new Client({ connectionString: source, ssl: sslFor(source) });
  await client.connect();
  try {
    const { rows } = await client.query<{ server_version_num: string }>(
      "SELECT current_setting('server_version_num') AS server_version_num",
    );
    assertPostgresMajorOrThrow(postgresMajorFromVersionNum(rows[0]?.server_version_num ?? 0));
  } finally {
    await client.end();
  }
}

/** توليد العقد الطازج من بناءٍ كامل على قاعدة مؤقتة — نفس طريق `npm run schema:contract` حرفيًّا. */
async function generateFreshContract(): Promise<SchemaContract> {
  if (process.env.DATABASE_ENVIRONMENT === "production" || process.env.NODE_ENV === "production") {
    throw new Error(
      "توليد عقدٍ طازج لهذه البوابة مرفوض في سياق production — مرّر --fresh <path> أو استخدم قاعدة CI/تطوير معزولة.",
    );
  }
  const source = process.env.DATABASE_URL?.trim() ?? "";
  if (!source) {
    throw new Error("DATABASE_URL غير مضبوط — التوليد الطازج يحتاج خادم PostgreSQL 18 (أو مرّر --fresh <path> لملف جاهز).");
  }
  await assertLivePostgres18(source);
  return withFreshSchema(source, async ({ contract }) => contract);
}

function pathArg(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) return path.resolve(process.argv[index + 1]);
  return null;
}

async function main(): Promise<void> {
  const committedPath = pathArg("--committed") ?? path.resolve(COMMITTED_CONTRACT_PATH);
  const freshPath = pathArg("--fresh");
  const committed = await loadSchemaContractFile(committedPath, "الملف الملتزم");
  const fresh = freshPath
    ? await loadSchemaContractFile(freshPath, "العقد الطازج")
    : await generateFreshContract();

  const majorProblems = provenanceMajorProblems(committed, fresh);
  if (majorProblems.length > 0) {
    for (const problem of majorProblems) console.error(`${SCHEMA_CONTRACT_DRIFT_MARKER}: ${problem}`);
    process.exit(1);
  }

  const diffs = structuralDiffs(committed, fresh);
  if (diffs.length > 0) {
    console.error(
      `${SCHEMA_CONTRACT_DRIFT_MARKER}: العقد الملتزم ${committedPath} لا يطابق المخطط الحالي بنيويًّا — ${diffs.length} فرقًا:`,
    );
    for (const diff of diffs.slice(0, 40)) {
      console.error(`  - ${diff.path}: committed=${diff.committed} | fresh=${diff.fresh}`);
    }
    if (diffs.length > 40) console.error(`  … و${diffs.length - 40} فرقًا أخرى.`);
    console.error("  إن كان تغيّر المخطط مقصودًا فأعد توليد العقد على PostgreSQL 18 (npm run schema:contract) واعرض الملف للمراجعة؛");
    console.error("  وإلا فصحّح lib/db.ts — العقد الملتزم هو المرجع الثابت.");
    process.exit(1);
  }

  console.log(
    `schema contract drift verify: OK — البنية متطابقة: ${fresh.counts.tables} جدولًا · ${fresh.counts.columns} عمودًا`
      + ` · ${fresh.counts.constraints} قيدًا · ${fresh.counts.indexes} فهرسًا · ${fresh.counts.triggers} مُشغِّلًا.`,
  );
  const committedVersion = String(committed.generatedOnServerVersion ?? "?");
  const freshVersion = String(fresh.generatedOnServerVersion ?? "?");
  if (committedVersion !== freshVersion) {
    console.log(
      `  مصدرٌ مختلف فقط (لا يُقارن): ملتزم PostgreSQL ${committedVersion} · طازج PostgreSQL ${freshVersion} — major ${SUPPORTED_POSTGRES_MAJOR} واحد والبنية واحدة.`,
    );
  }
}

const invokedDirectly = process.argv[1] !== undefined
  && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invokedDirectly) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
