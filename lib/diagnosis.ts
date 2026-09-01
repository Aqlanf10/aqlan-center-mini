/**
 * التشخيص النسخي — تاريخٌ يُقرأ ولا يُمحى.
 *
 * المالك قاعدها صراحةً: «ولا نمسح التشخيص القديم — Versioned history وليس
 * overwrite». والتشخيص في التقويم ليس ثابتًا: ما كُتب يوم بدء العلاج «Skeletal
 * Class II — Overjet 7mm» يتغيّر بعد سنةٍ من العلاج، والقيمة الأعظم أن تُقرأ
 * النسختان معًا فترى ما فعله العلاج.
 *
 * فالجدول يُضاف إليه فقط: كل تحديثٍ نسخةٌ جديدة تشير إلى التي سبقتها، والقراءة
 * تُرتبها فترى تطوّر الحالة كما راحه الطبيب.
 */

/** حقول التشخيص التقويمي المعيارية — كما يكتبها الأخصائي في تقرير البداية. */
export interface DiagnosisContent {
  /** مثل: «صنف هيكلي ثانٍ». */
  skeletal: string | null;
  /** مثل: «صنف ثانٍ شعبة ١». */
  dental: string | null;
  /** مثل: «ازدحام علوي ٥ مم». */
  crowding: string | null;
  /** مثل: «Overjet ٧ مم». */
  overjet: string | null;
  /** مثل: «عمق إطباق متوسط». */
  bite: string | null;
  /** ما لا يسع حقًّا معياريًّا. */
  note: string | null;
}

const FIELD_LIMIT = 200;

const FIELD_KEYS: { key: keyof DiagnosisContent; label: string }[] = [
  { key: "skeletal", label: "الصنف الهيكلي" },
  { key: "dental", label: "الصنف السني" },
  { key: "crowding", label: "الازدحام" },
  { key: "overjet", label: "البعد الأفقي Overjet" },
  { key: "bite", label: "الإطباق" },
  { key: "note", label: "ملاحظات" },
];

export function DIAGNOSIS_FIELDS(): { key: keyof DiagnosisContent; label: string }[] {
  return FIELD_KEYS;
}

function cleanText(value: unknown, limit = FIELD_LIMIT): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text) return null;
  return text.slice(0, limit);
}

export type DiagnosisValidation =
  | { ok: true; content: DiagnosisContent }
  | { ok: false; message: string };

/**
 * يتحقّق من نسخةٍ جديدة ويُنظّف حقولها.
 *
 * التشخيص الفارغ كلّه رفض: «نسخةٌ بلا كلام» لا معنى لها في سجلٍ يُضاف إليه
 * فقط. وحقلٌ واحدٌ متغيّر كافٍ لنسخةٍ جديدة — لا يُطلب إعادة كتابة كل شيء.
 */
export function validateDiagnosisContent(raw: unknown): DiagnosisValidation {
  if (!raw || typeof raw !== "object") {
    return { ok: false, message: "اكتب التشخيص قبل الحفظ." };
  }
  const source = raw as Record<string, unknown>;
  const content: DiagnosisContent = {
    skeletal: cleanText(source.skeletal),
    dental: cleanText(source.dental),
    crowding: cleanText(source.crowding),
    overjet: cleanText(source.overjet),
    bite: cleanText(source.bite),
    note: cleanText(source.note, 1000),
  };
  const hasAny = Object.values(content).some((value) => value !== null);
  if (!hasAny) {
    return { ok: false, message: "اكتب التشخيص قبل الحفظ — لا تُحفَظ نسخة فارغة." };
  }
  return { ok: true, content };
}

export interface DiagnosisVersion {
  id: number;
  version: number;
  content: DiagnosisContent;
  /** سبب التحديث — «تحديث بعد ستة أشهر» مثلًا. اختياري. */
  label: string | null;
  createdBy: string;
  createdAt: string;
  /** معرّف النسخة التي تغيّر عنها — سلسلة التاريخ. */
  supersedes: number | null;
}

/** سطرٌ يقرأ الإنسان من نسخة التشخيص: الحقول المملوءة وحدها. */
export function diagnosisSummary(content: DiagnosisContent): string[] {
  const lines: string[] = [];
  for (const { key, label } of FIELD_KEYS) {
    const value = content[key];
    if (value) lines.push(key === "note" ? value : `${label}: ${value}`);
  }
  return lines;
}
