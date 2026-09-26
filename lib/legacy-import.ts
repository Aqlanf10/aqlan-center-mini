/**
 * (P1-5ج) معالجات النظام القديم ودفعاته — قرار المالك: «كل شيء يدخل كما في النظام القديم».
 *
 * تُحفظ المعالجات والدفعات القديمة **أرشيفًا للقراءة** في ملف كل مريض (بتاريخها وطبيبها
 * وخدمتها وسعرها وعملتها وسعر صرفها وصندوقها) — ولا تدخل الصندوق ولا الدفاتر: دفعاتٌ
 * قُبضت قبل سنتين لو دخلت صندوق اليوم لظهر فيه مالٌ لا وجود له.
 *
 * و**الباقي** على كل معالجة يصير رصيدًا افتتاحيًّا **بعملته** (السعودي سعودي، والدولار
 * دولار — لا تحويل)، مجموعًا لكل مريضٍ وعملة. هذا وحده ما يدخل حساب المريض وتحصيله.
 *
 * دوال خالصة: قراءة الأعمدة، وربط كل سطرٍ بمريضه، والتلخيص. القاعدة تستهلكها.
 */
import { normalizeName, samePhone } from "./duplicates";
import { parseAmount, type Currency } from "./money";
import { westernDigits } from "./patient-import";

export interface LegacyTreatment {
  line: number;
  legacyNumber: number;
  treatedOn: string | null;
  patientName: string;
  phone: string | null;
  doctorName: string | null;
  service: string | null;
  currency: Currency;
  priceMinor: number;
  /** سعر الصرف كما سجّله النظام القديم — يُحفظ للاطلاع ولا يُستعمل لتحويل. */
  rate: number | null;
  paidMinor: number;
  remainingMinor: number;
}

export interface LegacySession {
  line: number;
  legacyNumber: number;
  paidOn: string | null;
  patientName: string;
  treatmentNumber: number | null;
  currency: Currency;
  amountMinor: number;
  rate: number | null;
  method: string | null;
  cashBox: string | null;
  service: string | null;
  doctorName: string | null;
}

export interface LegacyParseResult<T> { records: T[]; problems: { line: number; reason: string }[] }

const CURRENCY_WORDS: Record<string, Currency> = {
  "ريال يمني": "YER", "يمني": "YER", "YER": "YER",
  "ريال سعودي": "SAR", "سعودي": "SAR", "SAR": "SAR",
  "دولار": "USD", "دولار امريكي": "USD", "دولار أمريكي": "USD", "USD": "USD",
};

function currencyOf(value: string): Currency | null {
  return CURRENCY_WORDS[value.trim()] ?? null;
}

function headerIndex(headers: readonly string[], ...names: string[]): number | undefined {
  const clean = (value: string) => value.trim().replace(/\s+/g, " ");
  const index = headers.findIndex((header) => names.some((name) => clean(header) === name));
  return index >= 0 ? index : undefined;
}

function cell(row: readonly string[], index: number | undefined): string {
  return index === undefined ? "" : (row[index] ?? "").trim();
}

function dateOf(value: string): string | null {
  const text = westernDigits(value.trim());
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  const dmy = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(text);
  return dmy ? `${dmy[3]}-${dmy[2].padStart(2, "0")}-${dmy[1].padStart(2, "0")}` : null;
}

function minorOf(value: string, currency: Currency): number | null {
  const text = westernDigits(value.trim());
  if (!text) return 0;
  const number = Number(text.replace(/,/g, ""));
  if (!Number.isFinite(number) || number < 0) return null;
  // parseAmount يقبل صيغة العرض؛ والرقم الخام من Excel قد يحمل كسورًا طويلة (171.2234…).
  return parseAmount(number.toFixed(currency === "YER" ? 0 : 2), currency);
}

function rateOf(value: string): number | null {
  const number = Number(westernDigits(value.trim()));
  return Number.isFinite(number) && number > 0 ? number : null;
}

/** ملف «المعالجات» من النظام القديم. */
export function parseLegacyTreatments(rows: readonly string[][]): LegacyParseResult<LegacyTreatment> {
  const problems: { line: number; reason: string }[] = [];
  if (rows.length < 2) return { records: [], problems: [{ line: 1, reason: "الملف فارغ." }] };
  const headers = rows[0];
  const col = {
    number: headerIndex(headers, "رقم المعالجة"),
    date: headerIndex(headers, "تاريخ المعالجة"),
    patient: headerIndex(headers, "المريض", "اسم المريض"),
    doctor: headerIndex(headers, "الطبيب المعالج"),
    service: headerIndex(headers, "الخدمة الطبية"),
    price: headerIndex(headers, "سعر المعالجة"),
    currency: headerIndex(headers, "عملة المعالجة"),
    rate: headerIndex(headers, "سعر صرف المعالجة"),
    paid: headerIndex(headers, "سعر الجلسات"),
    remaining: headerIndex(headers, "الباقي"),
    phone: headerIndex(headers, "هاتف1", "الهاتف"),
  };
  if (col.number === undefined || col.patient === undefined || col.currency === undefined || col.remaining === undefined) {
    return { records: [], problems: [{ line: 1, reason: "ليس ملف معالجات النظام القديم: تنقصه أعمدة «رقم المعالجة» أو «المريض» أو «عملة المعالجة» أو «الباقي»." }] };
  }
  const records: LegacyTreatment[] = [];
  rows.slice(1).forEach((row, offset) => {
    const line = offset + 2;
    const legacyNumber = Number(westernDigits(cell(row, col.number)));
    const patientName = cell(row, col.patient);
    const currency = currencyOf(cell(row, col.currency));
    if (!Number.isInteger(legacyNumber) || legacyNumber <= 0) { problems.push({ line, reason: "رقم معالجة غير صالح." }); return; }
    if (!patientName) { problems.push({ line, reason: "بلا اسم مريض." }); return; }
    if (!currency) { problems.push({ line, reason: `عملة غير معروفة «${cell(row, col.currency)}».` }); return; }
    const priceMinor = minorOf(cell(row, col.price), currency);
    const paidMinor = minorOf(cell(row, col.paid), currency);
    const remainingMinor = minorOf(cell(row, col.remaining), currency);
    if (priceMinor === null || paidMinor === null || remainingMinor === null) {
      problems.push({ line, reason: "مبلغ غير صالح في السعر أو المدفوع أو الباقي." });
      return;
    }
    const phoneDigits = westernDigits(cell(row, col.phone)).replace(/\D/g, "");
    records.push({
      line, legacyNumber, patientName, currency, priceMinor, paidMinor, remainingMinor,
      treatedOn: dateOf(cell(row, col.date)),
      phone: phoneDigits.length >= 6 ? phoneDigits : null,
      doctorName: cell(row, col.doctor) || null,
      service: cell(row, col.service) || null,
      rate: rateOf(cell(row, col.rate)),
    });
  });
  const seen = new Set<number>();
  for (const record of records) {
    if (seen.has(record.legacyNumber)) problems.push({ line: record.line, reason: `رقم المعالجة ${record.legacyNumber} مكرر في الملف.` });
    seen.add(record.legacyNumber);
  }
  return { records, problems };
}

/** ملف «الجلسات/الدفعات» من النظام القديم. */
export function parseLegacySessions(rows: readonly string[][]): LegacyParseResult<LegacySession> {
  const problems: { line: number; reason: string }[] = [];
  if (rows.length < 2) return { records: [], problems: [{ line: 1, reason: "الملف فارغ." }] };
  const headers = rows[0];
  const col = {
    number: headerIndex(headers, "رقم الجلسة"),
    date: headerIndex(headers, "تاريخ الجلسة"),
    patient: headerIndex(headers, "المريض"),
    treatment: headerIndex(headers, "المعالجة الرئيسية"),
    amount: headerIndex(headers, "سعر الجلسة"),
    // عمود «العملة» مكرر في التصدير القديم — الأول هو عملة الجلسة، والثاني فارغ.
    currency: headerIndex(headers, "العملة"),
    rate: headerIndex(headers, "سعر الصرف"),
    method: headerIndex(headers, "طريقة الدفع"),
    box: headerIndex(headers, "الصندوق"),
    service: headerIndex(headers, "الخدمة الطبية"),
    doctor: headerIndex(headers, "الطبيب المعالج"),
  };
  if (col.number === undefined || col.patient === undefined || col.amount === undefined || col.currency === undefined) {
    return { records: [], problems: [{ line: 1, reason: "ليس ملف دفعات النظام القديم: تنقصه أعمدة «رقم الجلسة» أو «المريض» أو «سعر الجلسة» أو «العملة»." }] };
  }
  const records: LegacySession[] = [];
  rows.slice(1).forEach((row, offset) => {
    const line = offset + 2;
    const legacyNumber = Number(westernDigits(cell(row, col.number)));
    const patientName = cell(row, col.patient);
    const currency = currencyOf(cell(row, col.currency));
    if (!Number.isInteger(legacyNumber) || legacyNumber <= 0) { problems.push({ line, reason: "رقم جلسة غير صالح." }); return; }
    if (!patientName) { problems.push({ line, reason: "بلا اسم مريض." }); return; }
    if (!currency) { problems.push({ line, reason: `عملة غير معروفة «${cell(row, col.currency)}».` }); return; }
    const amountMinor = minorOf(cell(row, col.amount), currency);
    if (amountMinor === null) { problems.push({ line, reason: "مبلغ الجلسة غير صالح." }); return; }
    const treatment = /^(\d+)/.exec(westernDigits(cell(row, col.treatment)));
    records.push({
      line, legacyNumber, patientName, currency, amountMinor,
      paidOn: dateOf(cell(row, col.date)),
      treatmentNumber: treatment ? Number(treatment[1]) : null,
      rate: rateOf(cell(row, col.rate)),
      method: cell(row, col.method) || null,
      cashBox: cell(row, col.box) || null,
      service: cell(row, col.service) || null,
      doctorName: cell(row, col.doctor) || null,
    });
  });
  return { records, problems };
}

export interface LegacyPatientRef { id: number; patientNumber: string; fullName: string; phone: string | null; altPhone: string | null }

export type LegacyMatch =
  | { kind: "matched"; patient: LegacyPatientRef }
  | { kind: "ambiguous"; candidates: LegacyPatientRef[] }
  | { kind: "unmatched" };

/**
 * يربط اسمًا (وهاتفًا إن وُجد) بمريضٍ في النظام — بالاسم المطبَّع حرفيًّا، ثم الهاتف
 * لتفريق الأسماء المتكررة. لا تخمين بالاسم القريب: معالجةٌ تُنسب لغير صاحبها أسوأ من
 * معالجةٍ تُعرض «بلا صاحب» ليربطها المالك.
 */
export function legacyMatcher(patients: readonly LegacyPatientRef[]) {
  const byName = new Map<string, LegacyPatientRef[]>();
  for (const patient of patients) {
    const key = normalizeName(patient.fullName);
    const list = byName.get(key);
    if (list) list.push(patient); else byName.set(key, [patient]);
  }
  return (name: string, phone: string | null): LegacyMatch => {
    const candidates = byName.get(normalizeName(name)) ?? [];
    if (candidates.length === 1) return { kind: "matched", patient: candidates[0] };
    if (candidates.length === 0) return { kind: "unmatched" };
    if (phone) {
      const byPhone = candidates.filter((patient) => samePhone(phone, patient.phone) || samePhone(phone, patient.altPhone));
      if (byPhone.length === 1) return { kind: "matched", patient: byPhone[0] };
    }
    return { kind: "ambiguous", candidates };
  };
}

export interface LegacyPlanRow<T> { record: T; match: LegacyMatch }

export interface LegacyPlan {
  treatments: LegacyPlanRow<LegacyTreatment>[];
  sessions: (LegacyPlanRow<LegacySession> & { treatmentFound: boolean })[];
  /** الأرصدة الافتتاحية الناتجة: لكل مريضٍ وعملة مجموع الباقي، وأرقام معالجاته. */
  balances: { patientId: number; currency: Currency; amountMinor: number; treatmentNumbers: number[] }[];
  summary: {
    treatments: number; treatmentsMatched: number; treatmentsAmbiguous: number; treatmentsUnmatched: number;
    sessions: number; sessionsMatched: number; sessionsUnmatched: number;
    balancesByCurrency: Partial<Record<Currency, number>>;
  };
}

/**
 * خطة الاستيراد: كل معالجةٍ ودفعة بمريضها، والأرصدة الناتجة. الدفعة تتبع معالجتها
 * (رقم «المعالجة الرئيسية») فتأخذ مريضها؛ وبلا معالجةٍ معروفة تُربط باسمها.
 */
export function planLegacyImport(
  treatments: readonly LegacyTreatment[],
  sessions: readonly LegacySession[],
  patients: readonly LegacyPatientRef[],
): LegacyPlan {
  const match = legacyMatcher(patients);
  const treatmentRows = treatments.map((record) => ({ record, match: match(record.patientName, record.phone) }));
  const treatmentByNumber = new Map(treatmentRows.map((row) => [row.record.legacyNumber, row]));
  const sessionRows = sessions.map((record) => {
    const parent = record.treatmentNumber !== null ? treatmentByNumber.get(record.treatmentNumber) : undefined;
    const sameName = parent && normalizeName(parent.record.patientName) === normalizeName(record.patientName);
    return {
      record,
      match: parent && sameName ? parent.match : match(record.patientName, null),
      treatmentFound: Boolean(parent && sameName),
    };
  });

  return planFromRows(treatmentRows, sessionRows);
}

/** الأرصدة والملخص من أسطرٍ مربوطة — تُعاد بعد تطبيق اختيارات المالك. */
export function planFromRows(
  treatmentRows: LegacyPlanRow<LegacyTreatment>[],
  sessionRows: (LegacyPlanRow<LegacySession> & { treatmentFound: boolean })[],
): LegacyPlan {
  const totals = new Map<string, { patientId: number; currency: Currency; amountMinor: number; treatmentNumbers: number[] }>();
  for (const row of treatmentRows) {
    if (row.match.kind !== "matched" || row.record.remainingMinor <= 0) continue;
    const key = `${row.match.patient.id}:${row.record.currency}`;
    const entry = totals.get(key) ?? { patientId: row.match.patient.id, currency: row.record.currency, amountMinor: 0, treatmentNumbers: [] };
    entry.amountMinor += row.record.remainingMinor;
    entry.treatmentNumbers.push(row.record.legacyNumber);
    totals.set(key, entry);
  }
  const balances = [...totals.values()];
  const balancesByCurrency: Partial<Record<Currency, number>> = {};
  for (const balance of balances) balancesByCurrency[balance.currency] = (balancesByCurrency[balance.currency] ?? 0) + balance.amountMinor;

  return {
    treatments: treatmentRows,
    sessions: sessionRows,
    balances,
    summary: {
      treatments: treatmentRows.length,
      treatmentsMatched: treatmentRows.filter((row) => row.match.kind === "matched").length,
      treatmentsAmbiguous: treatmentRows.filter((row) => row.match.kind === "ambiguous").length,
      treatmentsUnmatched: treatmentRows.filter((row) => row.match.kind === "unmatched").length,
      sessions: sessionRows.length,
      sessionsMatched: sessionRows.filter((row) => row.match.kind === "matched").length,
      sessionsUnmatched: sessionRows.filter((row) => row.match.kind !== "matched").length,
      balancesByCurrency,
    },
  };
}
