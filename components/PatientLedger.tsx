"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CURRENCIES,
  CURRENCY_LABEL,
  balanceText,
  formatAmount,
  formatMoney,
  isCurrency,
  parseAmount,
  type Balance,
  type Currency,
} from "@/lib/money";
import { useSetting } from "./SettingsProvider";
import { useSession } from "./SessionProvider";
import { isAdmin } from "@/lib/roles";
import { friendlyDateLong } from "@/lib/reminders";

/**
 * حساب المريض: الرصيد والفواتير والدفعات، وإنشاء فاتورة وقبض دفعة.
 *
 * الرصيد فوق كل شيء لأنه السؤال الذي يُسأل على الباب. وتحته سببه — الفواتير
 * والدفعات — لأن رقمًا بلا تفصيل يُجادَل عليه ولا يُثبَت.
 */

interface Service { id: number; name: string; category: string | null; priceMinor: number }
interface InvoiceItem { id: number; description: string; quantity: number; unitPriceMinor: number; totalMinor: number }
interface Invoice {
  id: number; invoiceNumber: string; status: "open" | "paid" | "cancelled";
  totalMinor: number; discountMinor: number; note: string | null; createdAt: string; items: InvoiceItem[];
}
interface Payment {
  id: number; receiptNumber: string; invoiceId: number | null; kind: "payment" | "refund";
  amountMinor: number; currency: Currency; exchangeRate: number; baseAmountMinor: number;
  method: string; note: string | null; createdAt: string;
}
interface OpeningBalance {
  patientId: number; amountMinor: number; asOfDate: string; note: string | null;
}
interface Ledger {
  invoices: Invoice[]; payments: Payment[]; opening: OpeningBalance | null;
  balance: Balance; baseCurrency: Currency;
}

const STATUS_LABEL: Record<Invoice["status"], string> = {
  open: "مفتوحة", paid: "مسدّدة", cancelled: "ملغاة",
};

export function PatientLedger({ patientId }: { patientId: number }) {
  const baseSetting = useSetting("finance.base_currency");
  const fallbackBase: Currency = isCurrency(baseSetting) ? baseSetting : "YER";

  const [ledger, setLedger] = useState<Ledger | null>(null);
  const [services, setServices] = useState<Service[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"none" | "invoice" | "payment" | "opening">("none");
  const [lastReceiptId, setLastReceiptId] = useState<number | null>(null);
  const session = useSession();
  const admin = isAdmin(session?.role);

  const base = ledger?.baseCurrency ?? fallbackBase;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [ledgerResponse, servicesResponse] = await Promise.all([
        fetch(`/api/patients/${patientId}/ledger`, { cache: "no-store" }),
        fetch("/api/services", { cache: "no-store" }),
      ]);
      const payload = await ledgerResponse.json();
      if (!ledgerResponse.ok) throw new Error(payload?.message ?? "تعذّر التحميل.");
      setLedger(payload as Ledger);
      if (servicesResponse.ok) setServices(await servicesResponse.json());
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "تعذّر التحميل.");
    } finally {
      setLoading(false);
    }
  }, [patientId]);

  useEffect(() => { void load(); }, [load]);

  const send = useCallback(async (run: () => Promise<Response>) => {
    if (busy) return null;
    setBusy(true);
    try {
      const response = await run();
      const payload = await response.json().catch(() => null);
      if (!response.ok) { setError(payload?.message ?? "تعذّر التنفيذ."); return null; }
      setError(null);
      await load();
      return payload;
    } catch {
      setError("تعذّر الاتصال بالخادم.");
      return null;
    } finally {
      setBusy(false);
    }
  }, [busy, load]);

  if (loading && !ledger) {
    return <p className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-400">جارٍ التحميل…</p>;
  }

  return (
    <div>
      {error ? (
        <p role="alert" className="mb-3 rounded-xl border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">{error}</p>
      ) : null}

      {ledger ? (
        <div className={`mb-3 rounded-2xl border-2 p-4 text-center ${
          ledger.balance.dueMinor > 0 ? "border-amber-300 bg-amber-50"
            : ledger.balance.dueMinor < 0 ? "border-brand-blue bg-white"
            : "border-emerald-300 bg-emerald-50"
        }`}>
          <p className="text-xl font-extrabold">{balanceText(ledger.balance, base)}</p>
          <p className="mt-1 text-[11px] font-bold text-slate-500">
            مفوتر {formatMoney(ledger.balance.billedMinor, base)} · محصّل {formatMoney(ledger.balance.collectedMinor, base)}
            {ledger.balance.openingMinor > 0
              ? ` · رصيد افتتاحي ${formatMoney(ledger.balance.openingMinor, base)}`
              : ""}
          </p>
        </div>
      ) : null}

      <div className="mb-3 flex flex-wrap gap-1.5">
        <button onClick={() => setMode(mode === "invoice" ? "none" : "invoice")}
          className="rounded-xl bg-navy-800 px-4 py-2 text-xs font-bold text-white">
          {mode === "invoice" ? "إغلاق" : "فاتورة جديدة"}
        </button>
        <button onClick={() => setMode(mode === "payment" ? "none" : "payment")}
          className="rounded-xl bg-brand-orange px-4 py-2 text-xs font-bold text-white">
          {mode === "payment" ? "إغلاق" : "قبض دفعة"}
        </button>
        <a href={`/print/statement/${patientId}`} target="_blank" rel="noopener"
          className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-xs font-bold text-navy-800">
          كشف حساب
        </a>
        {admin ? (
          <button onClick={() => setMode(mode === "opening" ? "none" : "opening")}
            className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-xs font-bold text-navy-800">
            {mode === "opening" ? "إغلاق" : ledger?.opening ? "تعديل الرصيد الافتتاحي" : "رصيد افتتاحي"}
          </button>
        ) : null}
      </div>

      {lastReceiptId ? (
        <div className="mb-3 rounded-2xl border border-emerald-300 bg-emerald-50 p-3 text-center">
          <p className="mb-2 text-sm font-bold text-emerald-800">سُجّلت الدفعة.</p>
          <a href={`/print/receipt/${lastReceiptId}`} target="_blank" rel="noopener"
            onClick={() => setLastReceiptId(null)}
            className="inline-block rounded-xl bg-emerald-600 px-4 py-2 text-sm font-bold text-white">
            اطبع السند
          </a>
        </div>
      ) : null}

      {mode === "invoice" ? (
        <InvoiceForm
          patientId={patientId} base={base} services={services} busy={busy}
          onSubmit={async (body) => {
            const created = await send(() => fetch("/api/invoices", {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ patientId, ...body }),
            }));
            if (created) setMode("none");
          }}
        />
      ) : null}

      {mode === "payment" ? (
        <PaymentForm
          base={base} busy={busy} invoices={ledger?.invoices ?? []}
          onSubmit={async (body) => {
            const created = await send(() => fetch("/api/payments", {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ patientId, ...body }),
            })) as { id?: number } | null;
            if (created?.id) { setLastReceiptId(created.id); setMode("none"); }
          }}
        />
      ) : null}

      {mode === "opening" && admin ? (
        <OpeningForm
          base={base} busy={busy} existing={ledger?.opening ?? null}
          onSubmit={async (body) => {
            const saved = await send(() => fetch("/api/opening-balances", {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ patientId, ...body }),
            }));
            if (saved) setMode("none");
          }}
          onClear={async () => {
            const cleared = await send(() => fetch(
              `/api/opening-balances?patientId=${patientId}`, { method: "DELETE" },
            ));
            if (cleared) setMode("none");
          }}
        />
      ) : null}

      <section className="mb-4" aria-label="الفواتير">
        <h3 className="mb-2 text-sm font-bold">الفواتير ({ledger?.invoices.length ?? 0})</h3>
        {!ledger?.invoices.length ? (
          <p className="rounded-2xl border border-slate-200 bg-white p-4 text-center text-sm text-slate-400">لا فواتير.</p>
        ) : (
          <ul className="space-y-2">
            {ledger.invoices.map((invoice) => (
              <li key={invoice.id} className={`rounded-2xl border p-3 ${
                invoice.status === "cancelled" ? "border-slate-200 bg-slate-50 opacity-60" : "border-slate-200 bg-white"
              }`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-extrabold">{invoice.invoiceNumber}</span>
                  <span className="text-[11px] text-slate-500">
                    {friendlyDateLong(invoice.createdAt.slice(0, 10))} · {STATUS_LABEL[invoice.status]}
                  </span>
                </div>
                <ul className="mt-2 space-y-0.5">
                  {invoice.items.map((item) => (
                    <li key={item.id} className="flex justify-between gap-2 text-xs text-slate-600">
                      <span className="truncate">{item.description}{item.quantity > 1 ? ` × ${item.quantity}` : ""}</span>
                      <span className="shrink-0">{formatMoney(item.totalMinor, base)}</span>
                    </li>
                  ))}
                </ul>
                <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-2">
                  <span className="text-sm font-extrabold">
                    {formatMoney(Math.max(0, invoice.totalMinor - invoice.discountMinor), base)}
                    {invoice.discountMinor > 0 ? (
                      <span className="mr-2 text-[11px] font-bold text-emerald-700">
                        خصم {formatMoney(invoice.discountMinor, base)}
                      </span>
                    ) : null}
                  </span>
                  <a href={`/print/invoice/${invoice.id}`} target="_blank" rel="noopener"
                    className="rounded-xl border border-slate-200 px-3 py-1.5 text-xs font-bold text-navy-800">
                    طباعة
                  </a>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="الدفعات">
        <h3 className="mb-2 text-sm font-bold">الدفعات ({ledger?.payments.length ?? 0})</h3>
        {!ledger?.payments.length ? (
          <p className="rounded-2xl border border-slate-200 bg-white p-4 text-center text-sm text-slate-400">لا دفعات.</p>
        ) : (
          <ul className="space-y-2">
            {ledger.payments.map((payment) => (
              <li key={payment.id} className={`flex flex-wrap items-center justify-between gap-2 rounded-2xl border p-3 ${
                payment.kind === "refund" ? "border-red-200 bg-red-50" : "border-slate-200 bg-white"
              }`}>
                <div className="min-w-[8rem] flex-1">
                  <p className="text-sm font-extrabold">
                    {payment.kind === "refund" ? "−" : ""}{formatMoney(payment.amountMinor, payment.currency)}
                    {payment.currency !== base ? (
                      <span className="mr-2 text-[11px] font-normal text-slate-400">
                        = {formatMoney(payment.baseAmountMinor, base)} (سعر {payment.exchangeRate})
                      </span>
                    ) : null}
                  </p>
                  <p className="text-[11px] text-slate-500">
                    {payment.receiptNumber} · {friendlyDateLong(payment.createdAt.slice(0, 10))}
                  </p>
                </div>
                <a href={`/print/receipt/${payment.id}`} target="_blank" rel="noopener"
                  className="rounded-xl border border-slate-200 px-3 py-1.5 text-xs font-bold text-navy-800">
                  السند
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function InvoiceForm({ base, services, busy, onSubmit }: {
  patientId: number;
  base: Currency;
  services: Service[];
  busy: boolean;
  onSubmit: (body: Record<string, unknown>) => void;
}) {
  const [rows, setRows] = useState<{ serviceId: string; description: string; price: string; quantity: string }[]>(
    [{ serviceId: "", description: "", price: "", quantity: "1" }],
  );
  const [discount, setDiscount] = useState("");


  // الحساب هنا بنفس دالة القراءة التي يستعملها الخادم: حسابٌ محلي بقواعد أخرى
  // يعطي رقمًا يخالف ما يُحفَظ، فيفقد المستخدم ثقته بالشاشة كلها.
  const total = useMemo(() => rows.reduce((sum, row) => {
    const service = services.find((item) => String(item.id) === row.serviceId);
    const typed = row.price.trim() ? parseAmount(row.price, base) : null;
    const unit = typed ?? (service ? service.priceMinor : 0);
    const quantity = Math.max(1, Math.round(Number(row.quantity) || 1));
    return sum + unit * quantity;
  }, 0), [rows, services, base]);

  const discountMinor = discount.trim() ? parseAmount(discount, base) ?? 0 : 0;
  const net = Math.max(0, total - discountMinor);

  return (
    <section className="mb-4 rounded-2xl border border-navy-800 bg-white p-4" aria-label="فاتورة جديدة">
      <h3 className="mb-3 text-sm font-bold">فاتورة جديدة</h3>
      {rows.map((row, index) => (
        <div key={index} className="mb-2 flex flex-wrap gap-2">
          <select
            value={row.serviceId}
            onChange={(event) => setRows((current) => current.map((item, i) =>
              i === index ? { ...item, serviceId: event.target.value, price: "" } : item))}
            aria-label="الخدمة"
            className="min-w-[9rem] flex-1 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
          >
            <option value="">— بند يدوي —</option>
            {services.map((service) => (
              <option key={service.id} value={service.id}>
                {service.name} ({formatAmount(service.priceMinor, base)})
              </option>
            ))}
          </select>
          {!row.serviceId ? (
            <input
              value={row.description}
              onChange={(event) => setRows((current) => current.map((item, i) =>
                i === index ? { ...item, description: event.target.value } : item))}
              placeholder="وصف البند"
              aria-label="وصف البند"
              className="min-w-[8rem] flex-1 rounded-xl border border-slate-200 px-3 py-2 text-sm"
            />
          ) : null}
          <input
            value={row.price}
            onChange={(event) => setRows((current) => current.map((item, i) =>
              i === index ? { ...item, price: event.target.value } : item))}
            placeholder="السعر"
            aria-label="السعر"
            inputMode="decimal"
            dir="ltr"
            className="w-24 rounded-xl border border-slate-200 px-3 py-2 text-sm"
          />
          <input
            value={row.quantity}
            onChange={(event) => setRows((current) => current.map((item, i) =>
              i === index ? { ...item, quantity: event.target.value } : item))}
            aria-label="الكمية"
            inputMode="numeric"
            dir="ltr"
            className="w-16 rounded-xl border border-slate-200 px-3 py-2 text-sm"
          />
          {rows.length > 1 ? (
            <button type="button" onClick={() => setRows((current) => current.filter((_, i) => i !== index))}
              className="rounded-xl border border-slate-300 px-3 text-sm font-bold text-slate-500">×</button>
          ) : null}
        </div>
      ))}

      <button type="button"
        onClick={() => setRows((current) => [...current, { serviceId: "", description: "", price: "", quantity: "1" }])}
        className="mb-3 rounded-xl border border-slate-300 px-3 py-1.5 text-xs font-bold text-slate-600">
        + بند آخر
      </button>

      <div className="mb-3 flex flex-wrap items-end gap-2">
        <label className="w-32">
          <span className="mb-1 block text-[11px] font-bold text-slate-500">خصم</span>
          <input value={discount} onChange={(event) => setDiscount(event.target.value)}
            inputMode="decimal" dir="ltr" placeholder="0"
            className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm" />
        </label>
        <p className="flex-1 text-left text-sm font-extrabold">
          الإجمالي: {formatMoney(net, base)}
          {discountMinor > 0 ? <span className="mr-2 text-[11px] font-normal text-slate-400">قبل الخصم {formatMoney(total, base)}</span> : null}
        </p>
      </div>
      {/* الرقم المعتمد يُحسب على الخادم من البنود مهما أرسلت الواجهة؛ وهذا العرض
          يستعمل نفس دالة القراءة فيتطابق معه. */}

      <button
        onClick={() => onSubmit({
          discount,
          items: rows
            .filter((row) => row.serviceId || row.description.trim())
            .map((row) => ({
              serviceId: row.serviceId ? Number(row.serviceId) : undefined,
              description: row.description,
              price: row.price,
              quantity: Number(row.quantity) || 1,
            })),
        })}
        disabled={busy || !rows.some((row) => row.serviceId || row.description.trim())}
        className="w-full rounded-xl bg-navy-800 py-2.5 text-sm font-extrabold text-white disabled:opacity-50"
      >
        احفظ الفاتورة
      </button>
    </section>
  );
}

function PaymentForm({ base, busy, invoices, onSubmit }: {
  base: Currency;
  busy: boolean;
  invoices: Invoice[];
  onSubmit: (body: Record<string, unknown>) => void;
}) {
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState<Currency>(base);
  const [invoiceId, setInvoiceId] = useState("");
  const [kind, setKind] = useState<"payment" | "refund">("payment");
  const [method, setMethod] = useState("cash");

  const openInvoices = invoices.filter((invoice) => invoice.status === "open");

  return (
    <section className="mb-4 rounded-2xl border border-brand-orange bg-white p-4" aria-label="قبض دفعة">
      <h3 className="mb-3 text-sm font-bold">{kind === "refund" ? "استرداد" : "قبض دفعة"}</h3>

      <div className="mb-3 flex flex-wrap gap-2">
        <input value={amount} onChange={(event) => setAmount(event.target.value)}
          placeholder="المبلغ" aria-label="المبلغ" inputMode="decimal" dir="ltr" autoFocus
          className="min-w-[8rem] flex-1 rounded-xl border border-slate-200 px-3 py-2.5 text-base font-bold outline-none focus:border-brand-blue" />
        <select value={currency} onChange={(event) => setCurrency(event.target.value as Currency)}
          aria-label="العملة"
          className="w-36 rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm">
          {CURRENCIES.map((option) => (
            <option key={option} value={option}>{CURRENCY_LABEL[option]}</option>
          ))}
        </select>
      </div>

      {openInvoices.length > 0 ? (
        <label className="mb-3 block">
          <span className="mb-1 block text-[11px] font-bold text-slate-500">على فاتورة (اختياري)</span>
          <select value={invoiceId} onChange={(event) => setInvoiceId(event.target.value)}
            className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm">
            <option value="">— دفعة على الحساب —</option>
            {openInvoices.map((invoice) => (
              <option key={invoice.id} value={invoice.id}>
                {invoice.invoiceNumber} · {formatAmount(Math.max(0, invoice.totalMinor - invoice.discountMinor), base)}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      <div className="mb-3 flex flex-wrap gap-2">
        <div className="flex flex-1 gap-1.5">
          {(["cash", "transfer"] as const).map((option) => (
            <button key={option} type="button" onClick={() => setMethod(option)}
              className={`flex-1 rounded-xl border px-3 py-2 text-xs font-bold ${
                method === option ? "border-brand-blue bg-brand-blue text-white" : "border-slate-200 bg-white text-slate-600"
              }`}>
              {option === "cash" ? "نقدًا" : "تحويل"}
            </button>
          ))}
        </div>
        <button type="button" onClick={() => setKind(kind === "refund" ? "payment" : "refund")}
          className={`rounded-xl border px-3 py-2 text-xs font-bold ${
            kind === "refund" ? "border-red-400 bg-red-50 text-red-700" : "border-slate-200 bg-white text-slate-500"
          }`}>
          {kind === "refund" ? "هذا استرداد" : "استرداد؟"}
        </button>
      </div>

      <button
        onClick={() => onSubmit({ amount, currency, invoiceId: invoiceId || undefined, kind, method })}
        disabled={busy || !amount.trim()}
        className="w-full rounded-xl bg-brand-orange py-2.5 text-sm font-extrabold text-white disabled:opacity-50"
      >
        {kind === "refund" ? "سجّل الاسترداد" : "سجّل الدفعة واطبع السند"}
      </button>
    </section>
  );
}

/**
 * الرصيد الافتتاحي: ما كان على المريض قبل تشغيل النظام.
 *
 * شاشة صغيرة عمدًا وللمدير وحده — تُستعمل أيام إدخال البيانات القديمة ثم لا تكاد
 * تُفتح. والتاريخ حقلٌ لأنه هو ما يُؤرّخ به القيد وعمر الدَّين: «الأول من الشهر»
 * ليس كـ«قبل سنتين» في قائمة المتأخرين.
 */
function OpeningForm({ base, busy, existing, onSubmit, onClear }: {
  base: Currency;
  busy: boolean;
  existing: { amountMinor: number; asOfDate: string; note: string | null } | null;
  onSubmit: (body: Record<string, unknown>) => void;
  onClear: () => void;
}) {
  const [amount, setAmount] = useState(
    existing ? formatAmount(existing.amountMinor, base) : "",
  );
  const [asOfDate, setAsOfDate] = useState(existing?.asOfDate ?? "");
  const [note, setNote] = useState(existing?.note ?? "");

  return (
    <section className="mb-4 rounded-2xl border border-slate-300 bg-white p-4" aria-label="رصيد افتتاحي">
      <h3 className="mb-1 text-sm font-bold">رصيد افتتاحي</h3>
      <p className="mb-3 text-[11px] font-bold leading-5 text-slate-500">
        ما كان على المريض <span className="text-navy-800">قبل</span> بدء العمل بالبرنامج.
        يدخل حسابه ومديونيته، ولا يُحسب إيرادًا لهذه الفترة ولا عمولة عليه.
      </p>

      <div className="mb-3 flex flex-wrap gap-2">
        <input value={amount} onChange={(event) => setAmount(event.target.value)}
          placeholder={`المبلغ (${CURRENCY_LABEL[base]})`} aria-label="المبلغ"
          inputMode="decimal" dir="ltr" autoFocus
          className="min-w-[8rem] flex-1 rounded-xl border border-slate-200 px-3 py-2.5 text-base font-bold outline-none focus:border-brand-blue" />
        <input type="date" value={asOfDate} onChange={(event) => setAsOfDate(event.target.value)}
          aria-label="تاريخ الرصيد"
          className="w-44 rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm" />
      </div>

      <input value={note} onChange={(event) => setNote(event.target.value)}
        placeholder="ملاحظة (اختياري) — مثل: متبقٍ من تقويم بدأ 2024" aria-label="ملاحظة"
        className="mb-3 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-brand-blue" />

      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => onSubmit({ amount, asOfDate: asOfDate || undefined, note: note.trim() || undefined })}
          disabled={busy || !amount.trim()}
          className="flex-1 rounded-xl bg-navy-800 py-2.5 text-sm font-extrabold text-white disabled:opacity-50"
        >
          احفظ الرصيد الافتتاحي
        </button>
        {existing ? (
          <button onClick={onClear} disabled={busy}
            className="rounded-xl border border-red-300 bg-red-50 px-4 py-2.5 text-sm font-bold text-red-700 disabled:opacity-50">
            احذفه
          </button>
        ) : null}
      </div>
    </section>
  );
}
