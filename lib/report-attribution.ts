/**
 * إسناد التحصيل والمتبقي إلى بنود الفواتير — ومن البند إلى طبيبه وتخصصه وخدمته.
 *
 * كان تقرير الطبيب والتخصص يأخذ المريض كله لمجرد علاقةٍ تاريخية به: كل تحصيله في
 * الفترة، ورصيده كله، وصافي الفاتورة كاملًا لكل طبيبٍ ظهر فيها (RPT-08…14). فتتكرر
 * الدفعة الواحدة عند طبيبين، ويظهر دين علاج العصب في تقرير التقويم.
 *
 * القاعدة هنا هي قاعدة محرّك العمولات نفسها (lib/db.ts ← commissionReport):
 *  - لكل عملةٍ دلوها: الدفعة تسوّي دلو عملة تسويتها فقط، لا تحويل.
 *  - FIFO داخل الدلو: الرصيد الافتتاحي أولًا (دلو الأساس)، ثم الفواتير بالأقدم.
 *  - ما زاد عن طاقة الدلو رصيدٌ دائن للمريض لا يُنسب لفاتورة ولا لطبيب.
 *  - الاسترداد يعيد فتح أحدث ما غُطّي أولًا (LIFO) — فيعود المتبقي على بنده.
 * ثم يُقسم ما غُطّي من الفاتورة على بنودها بنسبة صافي كل بند (الباقي الأكبر)، فمجموع
 * الأنصبة = المبلغ حرفيًّا: لا تكرار ولا ضياع.
 *
 * * خالصة: لا قاعدة بيانات، ولا تاريخ جهاز. كل التواريخ أيام العيادة بتوقيتها نصًّا.
 */

import { CLINIC_BASE_CURRENCY, CURRENCIES, type Currency } from "./money";

export interface AttributionLine {
  doctorId: number | null;
  category: string | null;
  serviceId: number | null;
  /** نصيب البند من صافي الفاتورة بعد الخصم — بعملة الفاتورة. */
  netMinor: number;
}

export interface AttributionInvoice {
  id: number;
  date: string;
  currency: Currency;
  netMinor: number;
  lines: AttributionLine[];
}

export interface AttributionPayment {
  id: number;
  date: string;
  kind: string;
  settlementCurrency: Currency;
  settlementMinor: number;
  /** رصيدٌ دائن افتتاحي يُعامل كدفعةٍ سابقة للتسوية، لكنه ليس تحصيلًا في أي فترة. */
  synthetic?: boolean;
  /** (RPT-SPEC) لحظة الدفعة (ISO) — لما يُحلّ بوقت الحدث نفسه (نسبة المواد). */
  at?: string;
}

/** (P1-5ب) الرصيد الافتتاحي بعملته — دلوٌ لكل عملة. */
export type OpeningsByCurrency = Partial<Record<Currency, { date: string; minor: number }>>;

export interface AttributionInput {
  openings: OpeningsByCurrency;
  invoices: AttributionInvoice[];
  payments: AttributionPayment[];
}

/** هدف جزء التحصيل: فاتورة، أو الرصيد الافتتاحي، أو رصيدٌ دائن غير موزّع. */
export type ChunkTarget = { kind: "invoice"; invoiceId: number } | { kind: "opening" } | { kind: "credit" };

export interface CollectionChunk {
  target: ChunkTarget;
  /** يوم الدفعة (أو الاسترداد) — به يُنسب التحصيل إلى الفترة. */
  date: string;
  currency: Currency;
  /** موجب للقبض، سالب للاسترداد. */
  amount: number;
  /** من رصيدٍ دائن افتتاحي — يسوّي ولا يُعدّ تحصيلًا. */
  synthetic?: boolean;
  /** (RPT-SPEC) لحظة الدفعة أو الاسترداد (ISO) إن عُرفت. */
  at?: string;
}

export interface AttributionResult {
  chunks: CollectionChunk[];
  /** ما غُطّي من كل فاتورة حتى تاريخ الإسناد — بعملتها. */
  coveredByInvoice: Map<number, number>;
  /** ما بقي من الرصيد الافتتاحي غير مسدَّد (دلو الأساس). */
  openingRemaining: number;
}

interface Capacity { target: ChunkTarget; total: number; covered: number }

/** يسند دفعات المريض حتى `asOf` إلى فواتيره ورصيده الافتتاحي — لكل عملة دلوها. */
export function attributeCollections(input: AttributionInput, asOf: string): AttributionResult {
  const chunks: CollectionChunk[] = [];
  const coveredByInvoice = new Map<number, number>();
  let openingRemaining = 0;

  for (const currency of CURRENCIES) {
    const capacities: Capacity[] = [];
    // الرصيد السابق أقدم من كل فاتورة في دلو عملته — فما دخل عليه لا يُنسب لفاتورة ولا عمولة.
    const opening = input.openings[currency];
    if (opening && opening.date <= asOf && opening.minor > 0) {
      capacities.push({ target: { kind: "opening" }, total: opening.minor, covered: 0 });
    }
    const invoices = input.invoices
      .filter((invoice) => invoice.currency === currency && invoice.date <= asOf && invoice.netMinor > 0)
      .sort((a, b) => (a.date === b.date ? a.id - b.id : a.date < b.date ? -1 : 1));
    for (const invoice of invoices) {
      capacities.push({ target: { kind: "invoice", invoiceId: invoice.id }, total: invoice.netMinor, covered: 0 });
    }

    const payments = input.payments
      .filter((payment) => payment.settlementCurrency === currency && payment.date <= asOf && payment.settlementMinor !== 0)
      .sort((a, b) => (a.date === b.date ? a.id - b.id : a.date < b.date ? -1 : 1));

    /* مكدّس ما غُطّي بترتيب حدوثه — الاسترداد يفكّ من أعلاه. */
    const applied: { capacity: Capacity | null; amount: number; synthetic: boolean }[] = [];
    for (const payment of payments) {
      if (payment.kind !== "refund") {
        let left = payment.settlementMinor;
        for (const capacity of capacities) {
          if (left <= 0) break;
          const room = capacity.total - capacity.covered;
          if (room <= 0) continue;
          const take = Math.min(room, left);
          capacity.covered += take;
          left -= take;
          applied.push({ capacity, amount: take, synthetic: Boolean(payment.synthetic) });
          chunks.push({ target: capacity.target, date: payment.date, ...(payment.at ? { at: payment.at } : {}), currency, amount: take, ...(payment.synthetic ? { synthetic: true } : {}) });
        }
        if (left > 0) {
          applied.push({ capacity: null, amount: left, synthetic: Boolean(payment.synthetic) });
          chunks.push({ target: { kind: "credit" }, date: payment.date, ...(payment.at ? { at: payment.at } : {}), currency, amount: left, ...(payment.synthetic ? { synthetic: true } : {}) });
        }
        continue;
      }
      // استرداد: يفكّ أحدث ما غُطّي أولًا (والرصيد الدائن في آخر المكدّس يُفكّ قبل الفواتير).
      let left = payment.settlementMinor;
      for (let index = applied.length - 1; left > 0 && index >= 0; index -= 1) {
        const entry = applied[index];
        if (entry.amount <= 0) continue;
        const take = Math.min(entry.amount, left);
        entry.amount -= take;
        left -= take;
        if (entry.capacity) entry.capacity.covered -= take;
        chunks.push({ target: entry.capacity ? entry.capacity.target : { kind: "credit" }, date: payment.date, ...(payment.at ? { at: payment.at } : {}), currency, amount: -take, ...(entry.synthetic ? { synthetic: true } : {}) });
      }
      if (left > 0) chunks.push({ target: { kind: "credit" }, date: payment.date, ...(payment.at ? { at: payment.at } : {}), currency, amount: -left });
    }

    for (const capacity of capacities) {
      if (capacity.target.kind === "invoice") coveredByInvoice.set(capacity.target.invoiceId, capacity.covered);
      // ما بقي من الرصيد الافتتاحي — بدلو الأساس (رقمٌ واحد لا يمزج العملات).
      else if (capacity.target.kind === "opening" && currency === CLINIC_BASE_CURRENCY) openingRemaining = capacity.total - capacity.covered;
    }
  }
  return { chunks, coveredByInvoice, openingRemaining };
}

/**
 * يقسم مبلغًا على بنود الفاتورة بنسبة صافي كل بند (الباقي الأكبر) — المجموع = المبلغ
 * حرفيًّا، والإشارة محفوظة (الاسترداد يُقسم بالسالب). فاتورة بلا بنودٍ موجبة تعيد
 * جزءًا واحدًا بلا طبيب ولا تخصص.
 */
export function splitAcrossLines(lines: AttributionLine[], amount: number): { line: AttributionLine | null; amount: number }[] {
  const weights = lines.map((line) => Math.max(0, line.netMinor));
  const gross = weights.reduce((sum, weight) => sum + weight, 0);
  if (gross <= 0 || amount === 0) return [{ line: null, amount }];
  const sign = amount < 0 ? -1 : 1;
  const absolute = Math.abs(amount);
  let assigned = 0;
  const parts = weights.map((weight, index) => {
    const exact = (weight * absolute) / gross;
    const floor = Math.floor(exact);
    assigned += floor;
    return { index, floor, remainder: exact - floor };
  });
  let left = absolute - assigned;
  for (const part of [...parts].sort((a, b) => b.remainder - a.remainder || a.index - b.index)) {
    if (left <= 0) break;
    part.floor += 1;
    left -= 1;
  }
  return parts
    .filter((part) => part.floor > 0)
    .map((part) => ({ line: lines[part.index], amount: sign * part.floor }));
}

/** مفتاح الإسناد لبند: طبيبه، أو تخصصه، أو خدمته — و`null` حين يغيب. */
export type AttributionKey<K> = (line: AttributionLine) => K | null;

export interface AttributedTotals<K> {
  /** لكل مفتاح × عملة: المحصّل في المدى. */
  collected: Map<K | null, Record<Currency, number>>;
  /** لكل مفتاح × عملة: المتبقي غير المسدَّد حتى نهاية المدى. */
  remaining: Map<K | null, Record<Currency, number>>;
  /** التحصيل الذي لم يُنسب لبند: رصيد افتتاحي أو دفعات مقدَّمة غير موزّعة. */
  unattributedCollected: Record<Currency, number>;
  /** المتبقي من الرصيد الافتتاحي (دلو الأساس) — لا طبيب له. */
  openingRemaining: number;
}

function bump<K>(map: Map<K | null, Record<Currency, number>>, key: K | null, currency: Currency, amount: number) {
  const record = map.get(key) ?? { YER: 0, SAR: 0, USD: 0 };
  record[currency] += amount;
  map.set(key, record);
}

/**
 * يجمع تحصيل المدى [from, to] والمتبقي بنهاية `to` لكل مفتاح إسناد — لمريضٍ واحد.
 * مجموع المفاتيح + غير المنسوب = إجمالي تحصيل المريض في المدى (بلا تكرار).
 */
export interface CollectedPart<K> {
  key: K | null;
  currency: Currency;
  amount: number;
  date: string;
  at?: string;
  /** سدّد رصيدًا افتتاحيًّا أو بقي رصيدًا دائنًا — لا بند له. */
  unattributed: boolean;
}

/**
 * (RPT-SPEC) كل جزءٍ محصَّل في المدى بمفتاح بنده ولحظة دفعته — لمن يحلّ شيئًا بوقت
 * الحدث نفسه (نسبة المواد كما يحلّها محرّك العمولات). مجموعها = `attributeByKey().collected`.
 */
export function collectedParts<K>(
  input: AttributionInput,
  from: string,
  to: string,
  keyOf: AttributionKey<K>,
  precomputed?: CollectionChunk[],
  invoices?: Map<number, AttributionInvoice>,
): CollectedPart<K>[] {
  const chunks = precomputed ?? attributeCollections(input, to).chunks;
  const invoiceById = invoices ?? new Map(input.invoices.map((invoice) => [invoice.id, invoice]));
  const parts: CollectedPart<K>[] = [];
  for (const chunk of chunks) {
    if (chunk.synthetic || chunk.date < from || chunk.date > to) continue;
    const base = { currency: chunk.currency, date: chunk.date, ...(chunk.at ? { at: chunk.at } : {}) };
    if (chunk.target.kind !== "invoice") {
      parts.push({ ...base, key: null, amount: chunk.amount, unattributed: true });
      continue;
    }
    const invoice = invoiceById.get(chunk.target.invoiceId);
    if (!invoice) continue;
    for (const part of splitAcrossLines(invoice.lines, chunk.amount)) {
      parts.push({ ...base, key: part.line ? keyOf(part.line) : null, amount: part.amount, unattributed: false });
    }
  }
  return parts;
}

export function attributeByKey<K>(
  input: AttributionInput,
  from: string,
  to: string,
  keyOf: AttributionKey<K>,
): AttributedTotals<K> {
  const { chunks, coveredByInvoice, openingRemaining } = attributeCollections(input, to);
  const invoiceById = new Map(input.invoices.map((invoice) => [invoice.id, invoice]));
  const collected = new Map<K | null, Record<Currency, number>>();
  const remaining = new Map<K | null, Record<Currency, number>>();
  const unattributedCollected: Record<Currency, number> = { YER: 0, SAR: 0, USD: 0 };

  for (const part of collectedParts(input, from, to, keyOf, chunks, invoiceById)) {
    if (part.unattributed) unattributedCollected[part.currency] += part.amount;
    else bump(collected, part.key, part.currency, part.amount);
  }

  for (const invoice of input.invoices) {
    if (invoice.date > to || invoice.netMinor <= 0) continue;
    const open = invoice.netMinor - (coveredByInvoice.get(invoice.id) ?? 0);
    if (open <= 0) continue;
    for (const part of splitAcrossLines(invoice.lines, open)) {
      bump(remaining, part.line ? keyOf(part.line) : null, invoice.currency, part.amount);
    }
  }
  return { collected, remaining, unattributedCollected, openingRemaining };
}
