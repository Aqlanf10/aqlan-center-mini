/**
 * (P1-5) استيراد مرضى المركز القديم من ملف Excel محفوظ «CSV UTF-8».
 *
 * قرار المالك: المصدر ملفات Excel/CSV. والقواعد:
 *  - **المعاينة قبل الحفظ**: كل سطرٍ يُصنَّف ويُعرض قبل أن يُكتب شيء.
 *  - **المكرر المؤكد** (نفس الهاتف، أو نفس الاسم ونفس سنة الميلاد) يُتخطّى ولا يُدمج
 *    تلقائيًّا — الدمج قرارٌ بشري بأداة الدمج الموجودة.
 *  - **المشتبه** (تشابه الاسم وحده) لا يُستورد إلا باختيارٍ صريح.
 *  - **العملة**: الرصيد الافتتاحي بالريال اليمني يُستورد؛ وبغيره لا يُحوَّل بسعرٍ
 *    مخمَّن — يُنشأ المريض ويُعلَّم «أدخل رصيده يدويًّا» بمبلغه وعملته.
 *
 * دوال خالصة: التحليل والتصنيف هنا، والقاعدة والشاشة تستهلكانهما.
 */
import { findDuplicates, nameTokens, normalizeName, samePhone, type CandidatePatient } from "./duplicates";
import { validatePatient, type PatientInput } from "./patient";
import { CURRENCIES, parseAmount, type Currency } from "./money";

/** أقصى عدد أسطر في ملف واحد — ملفٌ أكبر يُقسَّم (حماية الخادم والمعاينة). */
export const IMPORT_MAX_ROWS = 5000;

/* ─── CSV (RFC 4180) ───────────────────────────────────────────────────────── */

/** يحلّل CSV بعلامات الاقتباس والأسطر المتعددة داخل الخلية، ويكتشف الفاصل (, أو ; أو tab). */
export function parseCsv(text: string): string[][] {
  const source = text.replace(/^\uFEFF/, "");
  const firstLine = source.split(/\r?\n/, 1)[0] ?? "";
  const delimiter = [",", ";", "\t", "،"]
    .map((candidate) => ({ candidate, count: firstLine.split(candidate).length }))
    .sort((a, b) => b.count - a.count)[0].candidate;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (quoted) {
      if (char === "\"") {
        if (source[i + 1] === "\"") { cell += "\""; i += 1; } else { quoted = false; }
      } else {
        cell += char;
      }
    } else if (char === "\"" && cell === "") {
      quoted = true;
    } else if (char === delimiter) {
      row.push(cell); cell = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && source[i + 1] === "\n") i += 1;
      row.push(cell); cell = "";
      if (row.some((value) => value.trim() !== "")) rows.push(row);
      row = [];
    } else {
      cell += char;
    }
  }
  row.push(cell);
  if (row.some((value) => value.trim() !== "")) rows.push(row);
  return rows;
}

/** هل النص UTF-8 سليم؟ ملف Excel محفوظ بترميز عربي قديم يظهر رموزًا مكسورة. */
export function looksLikeBrokenEncoding(text: string): boolean {
  return text.includes("�");
}

/* ─── ربط الأعمدة ──────────────────────────────────────────────────────────── */

export type ImportField =
  | "fullName" | "phone" | "altPhone" | "gender" | "birthYear" | "birthDate" | "address"
  | "medicalAlert" | "note" | "legacyNumber" | "openingBalance" | "openingCurrency"
  | "guardianName" | "guardianPhone" | "referralSource";

/** أسماء الأعمدة المقبولة — عربية وإنجليزية، بلا حساسية لحالة الأحرف والمسافات. */
const HEADER_ALIASES: Record<ImportField, string[]> = {
  fullName: ["الاسم", "اسم المريض", "الاسم الكامل", "name", "full name", "patient name"],
  phone: ["الهاتف", "رقم الهاتف", "الجوال", "رقم الجوال", "phone", "mobile", "phone number"],
  altPhone: ["هاتف بديل", "هاتف آخر", "الهاتف البديل", "alt phone", "phone 2"],
  gender: ["الجنس", "النوع", "gender", "sex"],
  birthYear: ["سنة الميلاد", "مواليد", "birth year", "year of birth"],
  birthDate: ["تاريخ الميلاد", "birth date", "date of birth", "dob"],
  address: ["العنوان", "السكن", "address"],
  medicalAlert: ["تنبيه طبي", "الحساسية", "الأمراض", "medical alert", "allergy", "allergies"],
  note: ["ملاحظة", "ملاحظات", "note", "notes"],
  legacyNumber: ["رقم الملف", "رقم الملف القديم", "الرقم", "file number", "file no", "id"],
  openingBalance: ["الرصيد", "الرصيد الافتتاحي", "المتبقي", "balance", "opening balance"],
  openingCurrency: ["العملة", "عملة الرصيد", "currency"],
  guardianName: ["ولي الأمر", "وليّ الأمر", "guardian", "guardian name"],
  guardianPhone: ["هاتف ولي الأمر", "هاتف وليّ الأمر", "guardian phone"],
  referralSource: ["المصدر", "من أين عرفنا", "مصدر المريض", "source", "referral"],
};

function normalizeHeader(value: string): string {
  return value.replace(/^\uFEFF/, "").trim().toLowerCase().replace(/[\s_]+/g, " ").replace(/[إأآ]/g, "ا");
}

export function mapHeaders(headers: readonly string[]): { mapping: Partial<Record<ImportField, number>>; unknown: string[] } {
  const mapping: Partial<Record<ImportField, number>> = {};
  const unknown: string[] = [];
  headers.forEach((header, index) => {
    const normalized = normalizeHeader(header);
    const field = (Object.keys(HEADER_ALIASES) as ImportField[]).find((key) =>
      HEADER_ALIASES[key].some((alias) => normalizeHeader(alias) === normalized));
    if (field && mapping[field] === undefined) mapping[field] = index;
    else if (header.trim()) unknown.push(header.trim());
  });
  return { mapping, unknown };
}

/* ─── تصنيف الأسطر ─────────────────────────────────────────────────────────── */

export type ImportRowStatus = "new" | "duplicate" | "possible_duplicate" | "duplicate_in_file" | "invalid";

export interface ImportRow {
  /** رقم السطر في الملف (١ = العناوين). */
  line: number;
  status: ImportRowStatus;
  reason: string | null;
  patient: PatientInput | null;
  legacyNumber: string | null;
  /** الرصيد الافتتاحي بالريال اليمني (وحدات صغرى) — يُستورد. */
  openingMinor: number | null;
  /** رصيدٌ بعملةٍ أخرى — لا يُحوَّل؛ يُعرض لإدخاله يدويًّا. */
  manualBalance: { amount: string; currency: Currency } | null;
  /** المريض الموجود الذي يطابقه (للمكرر والمشتبه). */
  matchedPatient: { id: number; patientNumber: string; fullName: string } | null;
}

const GENDER_WORDS: Record<string, "male" | "female"> = {
  "ذكر": "male", "م": "male", "male": "male", "m": "male",
  "انثى": "female", "أنثى": "female", "female": "female", "f": "female",
};

/**
 * تاريخ الميلاد كما يكتبه Excel العربي: «15/03/2010» أو «15-3-2010» (يوم/شهر/سنة)،
 * أو ISO «2010-03-15». وما سواهما يُترك كما هو فيرفضه التحقق برسالته.
 */
export function normalizeImportDate(value: string): string {
  const western = value.trim().replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));
  const dmy = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(western);
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, "0")}-${dmy[1].padStart(2, "0")}`;
  const ymd = /^(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})$/.exec(western);
  if (ymd) return `${ymd[1]}-${ymd[2].padStart(2, "0")}-${ymd[3].padStart(2, "0")}`;
  return western;
}

/**
 * فهرس المرضى الموجودين — لكي لا يُقارَن كل سطر بكل مريض.
 *
 * ملف ٥٠٠٠ سطر مقابل عشرين ألف مريض مقارنةً كاملة مئة مليون مقارنة أسماء. والفهرس
 * يرشّح لكل سطر من يشاركه **هاتفًا** أو **كلمتين من الاسم** — وهو شرطٌ لازمٌ لأي
 * مطابقة اسمٍ تعدّها `findDuplicates` (تطابقٌ تام أو تداخل ٧٥٪ من الأقصر). ويُفهرس
 * بأزواج الكلمات لا بالكلمة وحدها: «محمد» يشترك فيها الآلاف، وزوجٌ منها لا.
 * والاسم ذو الكلمة الواحدة (نادر) يُطابَق بكلمته.
 */
function buildCandidateIndex(existing: readonly CandidatePatient[]) {
  const byPhone = new Map<string, CandidatePatient[]>();
  const byPair = new Map<string, CandidatePatient[]>();
  const byToken = new Map<string, CandidatePatient[]>();
  const singleByToken = new Map<string, CandidatePatient[]>();
  const push = (map: Map<string, CandidatePatient[]>, key: string, patient: CandidatePatient) => {
    const list = map.get(key);
    if (list) list.push(patient); else map.set(key, [patient]);
  };
  const phoneKey = (phone: string | null) => {
    const digits = (phone ?? "").replace(/\D/g, "");
    return digits ? (digits.length < 7 ? digits : digits.slice(-9)) : null;
  };
  const pairsOf = (tokens: string[]) => {
    const pairs: string[] = [];
    for (let i = 0; i < tokens.length; i += 1) {
      for (let j = i + 1; j < tokens.length; j += 1) pairs.push(tokens[i] < tokens[j] ? `${tokens[i]}|${tokens[j]}` : `${tokens[j]}|${tokens[i]}`);
    }
    return pairs;
  };
  const tokensOf = (name: string) => [...new Set(nameTokens(name))].slice(0, 8);
  for (const patient of existing) {
    for (const phone of [patient.phone, patient.altPhone]) {
      const key = phoneKey(phone);
      if (key) push(byPhone, key, patient);
    }
    const tokens = tokensOf(patient.fullName);
    for (const token of tokens) push(byToken, token, patient);
    if (tokens.length === 1) push(singleByToken, tokens[0], patient);
    for (const pair of pairsOf(tokens)) push(byPair, pair, patient);
  }
  return (input: { fullName: string; phone: string | null; altPhone: string | null }): CandidatePatient[] => {
    const picked = new Map<number, CandidatePatient>();
    const take = (list: CandidatePatient[] | undefined) => { for (const patient of list ?? []) picked.set(patient.id, patient); };
    for (const phone of [input.phone, input.altPhone]) {
      const key = phoneKey(phone);
      if (key) take(byPhone.get(key));
    }
    const tokens = tokensOf(input.fullName);
    if (tokens.length === 1) take(byToken.get(tokens[0]));
    for (const token of tokens) take(singleByToken.get(token));
    for (const pair of pairsOf(tokens)) take(byPair.get(pair));
    return [...picked.values()];
  };
}

function cellOf(row: readonly string[], index: number | undefined): string {
  return index === undefined ? "" : (row[index] ?? "").trim();
}

function currencyOf(value: string): Currency | null {
  const normalized = value.trim().toUpperCase();
  if (!normalized) return "YER";
  const aliases: Record<string, Currency> = {
    "ريال يمني": "YER", "يمني": "YER", "ر.ي": "YER", "ريال": "YER",
    "ريال سعودي": "SAR", "سعودي": "SAR", "ر.س": "SAR",
    "دولار": "USD", "$": "USD",
  };
  if ((CURRENCIES as readonly string[]).includes(normalized)) return normalized as Currency;
  return aliases[value.trim()] ?? null;
}

/**
 * يصنّف أسطر الملف مقابل المرضى الموجودين.
 * `existing` قائمة المرضى الحاليين (للكشف في الذاكرة لا استعلامًا لكل سطر).
 */
export function classifyImportRows(
  rows: readonly string[][],
  existing: readonly CandidatePatient[],
  today: string,
): { rows: ImportRow[]; problems: string[] } {
  const problems: string[] = [];
  if (rows.length < 2) return { rows: [], problems: ["الملف فارغ أو بلا سطر بيانات بعد سطر العناوين."] };
  if (rows.length - 1 > IMPORT_MAX_ROWS) {
    return { rows: [], problems: [`الملف يحوي ${rows.length - 1} سطرًا — الحد ${IMPORT_MAX_ROWS} في الدفعة الواحدة؛ قسّمه.`] };
  }
  const { mapping, unknown } = mapHeaders(rows[0]);
  if (mapping.fullName === undefined) {
    return { rows: [], problems: ["لا يوجد عمود «الاسم» في سطر العناوين."] };
  }
  if (unknown.length > 0) problems.push(`أعمدة لم تُفهم وستُتجاهل: ${unknown.join("، ")}`);

  const candidatesFor = buildCandidateIndex(existing);
  const result: ImportRow[] = [];
  const seenInFile: { name: string; phone: string | null; line: number }[] = [];

  rows.slice(1).forEach((row, index) => {
    const line = index + 2;
    const base: ImportRow = {
      line, status: "invalid", reason: null, patient: null, legacyNumber: null,
      openingMinor: null, manualBalance: null, matchedPatient: null,
    };
    const genderWord = cellOf(row, mapping.gender).toLowerCase();
    const legacyNumber = cellOf(row, mapping.legacyNumber) || null;
    const note = [cellOf(row, mapping.note), legacyNumber ? `رقم الملف في النظام القديم: ${legacyNumber}` : ""]
      .filter(Boolean).join(" — ");
    const validation = validatePatient({
      fullName: cellOf(row, mapping.fullName),
      phone: cellOf(row, mapping.phone),
      altPhone: cellOf(row, mapping.altPhone),
      gender: GENDER_WORDS[genderWord] ?? "unknown",
      birthYear: cellOf(row, mapping.birthYear),
      birthDate: normalizeImportDate(cellOf(row, mapping.birthDate)),
      address: cellOf(row, mapping.address),
      medicalAlert: cellOf(row, mapping.medicalAlert),
      note,
      guardianName: cellOf(row, mapping.guardianName),
      guardianPhone: cellOf(row, mapping.guardianPhone),
      referralSource: cellOf(row, mapping.referralSource),
    }, today);
    if (!validation.ok) {
      result.push({ ...base, reason: validation.message, legacyNumber });
      return;
    }
    const patient = validation.value;

    // الرصيد الافتتاحي: اليمني يُستورد، وغيره يُترك للإدخال اليدوي — لا تحويل بسعرٍ مخمَّن.
    let openingMinor: number | null = null;
    let manualBalance: ImportRow["manualBalance"] = null;
    const balanceText = cellOf(row, mapping.openingBalance);
    if (balanceText) {
      const currency = currencyOf(cellOf(row, mapping.openingCurrency));
      if (!currency) {
        result.push({ ...base, reason: `عملة غير معروفة «${cellOf(row, mapping.openingCurrency)}».`, legacyNumber });
        return;
      }
      const minor = parseAmount(balanceText, currency);
      if (minor === null || minor < 0) {
        result.push({ ...base, reason: `رصيد غير صالح «${balanceText}».`, legacyNumber });
        return;
      }
      if (minor > 0) {
        if (currency === "YER") openingMinor = minor;
        else manualBalance = { amount: balanceText, currency };
      }
    }

    const filled: ImportRow = { ...base, patient, legacyNumber, openingMinor, manualBalance, status: "new" };

    const nameKey = normalizeName(patient.fullName);
    const inFile = seenInFile.find((seen) =>
      (patient.phone && seen.phone && samePhone(patient.phone, seen.phone)) || (!patient.phone && !seen.phone && seen.name === nameKey));
    if (inFile) {
      result.push({ ...filled, status: "duplicate_in_file", reason: `مكرر داخل الملف (السطر ${inFile.line}).` });
      return;
    }
    seenInFile.push({ name: nameKey, phone: patient.phone, line });

    const [best] = findDuplicates(
      { fullName: patient.fullName, phone: patient.phone, altPhone: patient.altPhone, birthYear: patient.birthYear },
      candidatesFor(patient),
    );
    if (best) {
      const matched = { id: best.patient.id, patientNumber: best.patient.patientNumber, fullName: best.patient.fullName };
      if (best.score >= 80) {
        result.push({
          ...filled, status: "duplicate", matchedPatient: matched,
          reason: best.reason === "phone" ? `نفس الهاتف لملف ${matched.patientNumber}.` : `نفس الاسم وسنة الميلاد لملف ${matched.patientNumber}.`,
        });
        return;
      }
      result.push({ ...filled, status: "possible_duplicate", matchedPatient: matched, reason: `اسمٌ مشابه لملف ${matched.patientNumber} — راجع.` });
      return;
    }
    result.push(filled);
  });

  return { rows: result, problems };
}

export function importSummary(rows: readonly ImportRow[]): Record<ImportRowStatus, number> & { manualBalances: number } {
  const summary = { new: 0, duplicate: 0, possible_duplicate: 0, duplicate_in_file: 0, invalid: 0, manualBalances: 0 };
  for (const row of rows) {
    summary[row.status] += 1;
    if (row.manualBalance) summary.manualBalances += 1;
  }
  return summary;
}
