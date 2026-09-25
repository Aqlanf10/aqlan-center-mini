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
import { nameTokens, normalizeName, samePhone, type CandidatePatient } from "./duplicates";
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
  | "guardianName" | "guardianPhone" | "referralSource"
  /* أعمدة تصدير النظام القديم: هاتفٌ ثالث، ورقم ملف التقويم، ورقم البطاقة. */
  | "extraPhone" | "orthoNumber" | "nationalId";

/** أسماء الأعمدة المقبولة — عربية وإنجليزية، بلا حساسية لحالة الأحرف والمسافات. */
const HEADER_ALIASES: Record<ImportField, string[]> = {
  fullName: ["الاسم", "اسم المريض", "الاسم الكامل", "name", "full name", "patient name"],
  phone: ["الهاتف", "رقم الهاتف", "الجوال", "رقم الجوال", "phone", "mobile", "phone number"],
  altPhone: ["هاتف بديل", "هاتف آخر", "الهاتف البديل", "هاتف2", "هاتف 2", "الهاتف2", "alt phone", "phone 2", "phone2"],
  extraPhone: ["هاتف3", "هاتف 3", "الهاتف3", "phone 3", "phone3"],
  orthoNumber: ["رقم التقويم", "رقم التقويم التسلسلي", "رقم ملف التقويم", "ortho number"],
  nationalId: ["رقم البطاقة", "رقم الهوية", "البطاقة", "national id", "id card"],
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
  /** سبب الحالة — أو تنبيهٌ على سطرٍ جديد (هاتفٌ مشترك مع فرد عائلة). */
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

/** الأرقام العربية الهندية والفارسية إلى لاتينية — قبل أي مقارنة أو حفظ. */
export function westernDigits(value: string): string {
  return value
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
}

/**
 * تاريخ الميلاد كما يكتبه Excel العربي: «15/03/2010» أو «15-3-2010» (يوم/شهر/سنة)،
 * أو ISO «2010-03-15». وما سواهما يُترك كما هو فيرفضه التحقق برسالته.
 */
export function normalizeImportDate(value: string): string {
  const western = westernDigits(value.trim());
  const dmy = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(western);
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, "0")}-${dmy[1].padStart(2, "0")}`;
  const ymd = /^(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})$/.exec(western);
  if (ymd) return `${ymd[1]}-${ymd[2].padStart(2, "0")}-${ymd[3].padStart(2, "0")}`;
  return western;
}

/** أقل خانات لرقمٍ يُعدّ هاتفًا: الأرضي في تعز ستّ خانات بلا مفتاح المنطقة. */
const MIN_PHONE_DIGITS = 6;

/**
 * هاتف خلية من النظام القديم.
 *
 * التصدير القديم يحمل «7» و«77» مكان رقمٍ لم يُكتب، ولو عُدّت أرقامًا لصار مئات
 * المرضى «مكرّرين» برقم «7». فالأقصر من ستّ خانات يُترك ويُحفظ نصّه في الملاحظة.
 * ورقمان ملتصقان في خلية واحدة (١٨ خانة = رقمان يمنيان) يُفصلان.
 */
export function splitLegacyPhone(raw: string): { phones: string[]; junk: string | null } {
  const text = westernDigits(raw.trim());
  if (!text) return { phones: [], junk: null };
  const digits = text.replace(/\D/g, "");
  if (digits.length < MIN_PHONE_DIGITS) return { phones: [], junk: text };
  if (digits.length === 18 && /^7/.test(digits) && /^7/.test(digits.slice(9))) {
    return { phones: [digits.slice(0, 9), digits.slice(9)], junk: null };
  }
  const parts = text.split(/[\s,،/;|-]+/).map((part) => part.replace(/\D/g, "")).filter((part) => part.length >= MIN_PHONE_DIGITS);
  if (parts.length > 1) return { phones: parts, junk: null };
  return { phones: [digits], junk: null };
}

function phoneKey(phone: string | null): string | null {
  const digits = westernDigits(phone ?? "").replace(/\D/g, "");
  if (digits.length < MIN_PHONE_DIGITS) return null;
  return digits.length < 7 ? digits : digits.slice(-9);
}

/**
 * فهرس المرشّحين — للمرضى الموجودين، ثم يُضاف إليه كل سطرٍ قُبل من الملف نفسه فتسري
 * قواعد التكرار بين أسطر الملف كما تسري مع القاعدة.
 *
 * ملف ٥٠٠٠ سطر مقابل عشرين ألف مريض مقارنةً كاملة مئة مليون مقارنة أسماء. والفهرس
 * يرشّح من يشاركه **هاتفًا** أو **كلمتين من الاسم** — وهو شرطٌ لازمٌ لأي مطابقة اسم
 * (تطابقٌ تام أو تداخل ٧٥٪ من الأقصر). ويُفهرس بأزواج الكلمات لا بالكلمة وحدها:
 * «محمد» يشترك فيها الآلاف، وزوجٌ منها لا. والاسم ذو الكلمة الواحدة يُطابَق بكلمته.
 */
interface Candidate extends CandidatePatient {
  /** سطر الملف لمرشّحٍ من الملف نفسه؛ null لمريضٍ في القاعدة. */
  line: number | null;
}

/** المرشّح مفهرسًا: اسمه المطبَّع وكلماته محسوبة مرةً واحدة لا في كل مقارنة. */
interface IndexedCandidate extends Candidate {
  norm: string;
  tokens: Set<string>;
  /** الاسم الأول — «محمد حمود» و«أمل محمد حمود» أبٌ وابنته لا شخصٌ واحد. */
  first: string;
}

class CandidateIndex {
  private byPhone = new Map<string, IndexedCandidate[]>();
  private byPair = new Map<string, IndexedCandidate[]>();
  private byToken = new Map<string, IndexedCandidate[]>();
  private singleByToken = new Map<string, IndexedCandidate[]>();

  private static push(map: Map<string, IndexedCandidate[]>, key: string, candidate: IndexedCandidate) {
    const list = map.get(key);
    if (list) list.push(candidate); else map.set(key, [candidate]);
  }

  private static tokensOf(name: string): string[] {
    return [...new Set(nameTokens(name))].slice(0, 8);
  }

  private static pairsOf(tokens: string[]): string[] {
    const pairs: string[] = [];
    for (let i = 0; i < tokens.length; i += 1) {
      for (let j = i + 1; j < tokens.length; j += 1) {
        pairs.push(tokens[i] < tokens[j] ? `${tokens[i]}|${tokens[j]}` : `${tokens[j]}|${tokens[i]}`);
      }
    }
    return pairs;
  }

  add(raw: Candidate) {
    const words = nameTokens(raw.fullName);
    const candidate: IndexedCandidate = { ...raw, norm: normalizeName(raw.fullName), tokens: new Set(words), first: words[0] ?? "" };
    for (const phone of [candidate.phone, candidate.altPhone]) {
      const key = phoneKey(phone);
      if (key) CandidateIndex.push(this.byPhone, key, candidate);
    }
    const tokens = CandidateIndex.tokensOf(candidate.fullName);
    for (const token of tokens) CandidateIndex.push(this.byToken, token, candidate);
    if (tokens.length === 1) CandidateIndex.push(this.singleByToken, tokens[0], candidate);
    for (const pair of CandidateIndex.pairsOf(tokens)) CandidateIndex.push(this.byPair, pair, candidate);
  }

  candidatesFor(input: { fullName: string; phone: string | null; altPhone: string | null }): IndexedCandidate[] {
    const picked = new Set<IndexedCandidate>();
    const take = (list: IndexedCandidate[] | undefined) => { for (const candidate of list ?? []) picked.add(candidate); };
    for (const phone of [input.phone, input.altPhone]) {
      const key = phoneKey(phone);
      if (key) take(this.byPhone.get(key));
    }
    const tokens = CandidateIndex.tokensOf(input.fullName);
    if (tokens.length === 1) take(this.byToken.get(tokens[0]));
    for (const token of tokens) take(this.singleByToken.get(token));
    for (const pair of CandidateIndex.pairsOf(tokens)) take(this.byPair.get(pair));
    return [...picked];
  }
}

type Verdict = { kind: "duplicate" | "possible" | "shares_phone"; score: number; candidate: Candidate; why: string };

/**
 * حكم التكرار — قاعدة واحدة للقاعدة ولأسطر الملف نفسه.
 *
 * - **مكرر مؤكد** (يُتخطّى): هاتفٌ مشترك **واسمٌ مطابق أو قريب**، أو الاسم نفسه وسنة
 *   الميلاد نفسها.
 * - **مشتبه** (يُراجَع): الاسم نفسه أو القريب بلا دليل هاتف.
 * - **هاتفٌ مشترك باسمٍ مختلف**: في اليمن رقم الأب للأسرة كلها — فهو **جديد** بتنبيه،
 *   لا مكرر؛ وإلا تخطّى الاستيراد إخوةً وأبناءً حقيقيين.
 */
function judge(
  input: { fullName: string; phone: string | null; altPhone: string | null; birthYear: number | null },
  candidates: readonly IndexedCandidate[],
): Verdict | null {
  const phones = [input.phone, input.altPhone].filter((phone): phone is string => Boolean(phone)).map(westernDigits);
  const target = normalizeName(input.fullName);
  const targetWords = nameTokens(input.fullName);
  const targetTokens = new Set(targetWords);
  const targetFirst = targetWords[0] ?? "";
  let best: Verdict | null = null;
  for (const candidate of candidates) {
    const phoneMatch = [candidate.phone, candidate.altPhone]
      .some((stored) => stored && phones.some((given) => samePhone(given, westernDigits(stored))));
    const sameName = candidate.norm === target;
    // تداخل الكلمات نسبةً إلى الأقصر — قاعدة `nameOverlap` نفسها على كلماتٍ محسوبة سلفًا.
    let shared = 0;
    for (const token of targetTokens) if (candidate.tokens.has(token)) shared += 1;
    const smaller = Math.min(targetTokens.size, candidate.tokens.size);
    /* الاسم العربي ثلاثيٌّ يحمل اسم الأب والجد: «محمد حمود» محتوًى في «أمل محمد حمود»
       وهما أبٌ وابنته. فالقرب لا يُحسب إلا والاسم الأول واحد. */
    /* وكلمةٌ واحدة («معاذ»، «هبة») دليلٌ أضعف من أن يُشبَّه بها أحد — تُطابَق تامّةً فقط. */
    const overlap = sameName ? 1 : smaller < 2 || candidate.first !== targetFirst ? 0 : shared / smaller;
    const sameYear = input.birthYear !== null && candidate.birthYear !== null && input.birthYear === candidate.birthYear;
    let verdict: Verdict | null = null;
    if (phoneMatch && overlap >= 0.75) verdict = { kind: "duplicate", score: 100, candidate, why: "phone" };
    else if (sameName && sameYear) verdict = { kind: "duplicate", score: 90, candidate, why: "name_and_year" };
    else if (sameName) verdict = { kind: "possible", score: 60, candidate, why: "same_name" };
    else if (overlap >= 0.75) verdict = { kind: "possible", score: Math.round(50 * overlap), candidate, why: "similar_name" };
    else if (phoneMatch) verdict = { kind: "shares_phone", score: 10, candidate, why: "phone_only" };
    if (verdict && (!best || verdict.score > best.score)) best = verdict;
  }
  return best;
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

function describeMatch(candidate: Candidate): string {
  return candidate.line !== null ? `السطر ${candidate.line}` : `ملف ${candidate.patientNumber}`;
}

/**
 * يصنّف أسطر الملف مقابل المرضى الموجودين وأسطر الملف نفسه.
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

  const index = new CandidateIndex();
  for (const patient of existing) index.add({ ...patient, line: null });
  const result: ImportRow[] = [];

  rows.slice(1).forEach((row, offset) => {
    const line = offset + 2;
    const base: ImportRow = {
      line, status: "invalid", reason: null, patient: null, legacyNumber: null,
      openingMinor: null, manualBalance: null, matchedPatient: null,
    };
    const genderWord = cellOf(row, mapping.gender).toLowerCase();
    const legacyNumber = cellOf(row, mapping.legacyNumber) || null;
    const orthoNumber = westernDigits(cellOf(row, mapping.orthoNumber));

    // الهواتف: الأساسي ثم البديل ثم الثالث — والناقص منها إلى الملاحظة لا إلى المطابقة.
    const phoneCells = [cellOf(row, mapping.phone), cellOf(row, mapping.altPhone), cellOf(row, mapping.extraPhone)];
    const phones: string[] = [];
    const junk: string[] = [];
    for (const cell of phoneCells) {
      const split = splitLegacyPhone(cell);
      for (const phone of split.phones) if (!phones.includes(phone)) phones.push(phone);
      if (split.junk) junk.push(split.junk);
    }
    const note = [
      cellOf(row, mapping.note),
      legacyNumber ? `رقم الملف في النظام القديم: ${legacyNumber}` : "",
      orthoNumber && /^\d+$/.test(orthoNumber) && Number(orthoNumber) > 0 ? `رقم التقويم في النظام القديم: ${orthoNumber}` : "",
      phones.length > 2 ? `هواتف أخرى: ${phones.slice(2).join("، ")}` : "",
      junk.length > 0 ? `هاتف غير مكتمل في النظام القديم: ${junk.join("، ")}` : "",
    ].filter(Boolean).join(" — ");

    const validation = validatePatient({
      fullName: cellOf(row, mapping.fullName),
      phone: phones[0] ?? "",
      altPhone: phones[1] ?? "",
      gender: GENDER_WORDS[genderWord] ?? "unknown",
      birthYear: cellOf(row, mapping.birthYear),
      birthDate: normalizeImportDate(cellOf(row, mapping.birthDate)),
      address: cellOf(row, mapping.address),
      medicalAlert: cellOf(row, mapping.medicalAlert),
      note,
      guardianName: cellOf(row, mapping.guardianName),
      guardianPhone: westernDigits(cellOf(row, mapping.guardianPhone)),
      nationalId: westernDigits(cellOf(row, mapping.nationalId)),
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
    const balanceText = westernDigits(cellOf(row, mapping.openingBalance));
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
    const verdict = judge(patient, index.candidatesFor(patient));
    const matched = verdict && verdict.candidate.line === null
      ? { id: verdict.candidate.id, patientNumber: verdict.candidate.patientNumber, fullName: verdict.candidate.fullName }
      : null;

    if (verdict?.kind === "duplicate") {
      const why = verdict.why === "phone" ? "نفس الهاتف واسمٌ مطابق" : "نفس الاسم وسنة الميلاد";
      if (verdict.candidate.line !== null) {
        result.push({ ...filled, status: "duplicate_in_file", reason: `مكرر داخل الملف (${describeMatch(verdict.candidate)}): ${why}.` });
      } else {
        result.push({ ...filled, status: "duplicate", matchedPatient: matched, reason: `${why} — ${describeMatch(verdict.candidate)}.` });
      }
      return;
    }
    if (verdict?.kind === "possible") {
      const why = verdict.why === "same_name" ? "الاسم نفسه" : "اسمٌ قريب";
      result.push({
        ...filled, status: "possible_duplicate",
        matchedPatient: matched,
        reason: verdict.candidate.line !== null
          ? `${why} في ${describeMatch(verdict.candidate)} من الملف — راجع.`
          : `${why} لـ${describeMatch(verdict.candidate)} — راجع.`,
      });
      return;
    }
    if (verdict?.kind === "shares_phone") {
      filled.reason = `يشارك الهاتف مع «${verdict.candidate.fullName}» (${describeMatch(verdict.candidate)}) — فرد عائلة غالبًا.`;
    }
    result.push(filled);
    index.add({
      id: -line, patientNumber: `سطر ${line}`, fullName: patient.fullName,
      phone: patient.phone, altPhone: patient.altPhone, birthYear: patient.birthYear, line,
    });
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
