"use client";
import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import {
  MINOR_UNITS,
  formatMoney,
  parseAmount,
  toInputAmount,
  type Currency,
} from "@/lib/money";
import {
  valuationSnapshot,
  type SupplierInvoiceRevision,
} from "@/lib/inventory-domain/procurement";
import { proportionalCostMinor } from "@/lib/inventory-domain/treatment-cost";
import { decimalRatio, quantityAtoms } from "@/lib/inventory-domain/quantities";
import type { SupplierFinanceView } from "@/lib/inventory-domain/supplier-transport";
import type { readProcurementWorkbench } from "@/lib/inventory-domain/procurement-store";
import { effectiveOrderReceipts } from "./effectiveReceipts";
import { useSupplierCommand } from "./useSupplierCommand";
import styles from "./inventory.module.css";
type Workbench = Awaited<ReturnType<typeof readProcurementWorkbench>>;
type Invoice = SupplierFinanceView["invoices"][number];
const errors: Record<string, [string, string]> = {
  supplier_invoice_intent_pending: [
    "للفاتورة عملية محفوظة غير محسومة. استرد نتيجتها أو أوقفها صراحة قبل بدء عملية جديدة؛ يمكنك متابعة فاتورة أخرى.",
    "This invoice has an unresolved saved operation. Recover or explicitly stop it before starting another; independent invoices remain available.",
  ],
  duplicate_document: [
    "هذا الرقم مرتبط بفاتورة أخرى للمورد في السنة نفسها. راجع المستند الأصلي؛ تبقى العملية محفوظة حتى إيقافها صراحة.",
    "This supplier number is already claimed in the same year. Review the original source; the saved operation remains held until explicitly stopped.",
  ],
  invoice_not_matched: [
    "راجع كميات الفاتورة وأسعارها وتخصيصها للاستلام المقبول، ثم احفظ إصدارًا مطابقًا قبل الترحيل.",
    "Review invoice quantities, prices and accepted receipt allocations; save a matched revision before posting.",
  ],
  rate_precision_unsupported: [
    "سعر التقييم المثبت لا يمكن ترحيله بدقة إلى الحسابات. راجع مصدر السعر واحفظ إصدارًا دقيقًا؛ لن يُقرّب السعر تلقائيًا.",
    "The frozen FX rate cannot be represented exactly in finance. Review its source and save an exact revision; the rate will not be rounded automatically.",
  ],
  valuation_mismatch: [
    "لا يطابق التقييم المثبت إجمالي الفاتورة. راجع الإجمالي ومصدر التقييم واحفظ إصدارًا جديدًا.",
    "The frozen valuation does not match the invoice total. Review its total and valuation source, then save a new revision.",
  ],
  supplier_unavailable: [
    "المورد غير نشط حاليًا. راجع سجله قبل ترحيل دين جديد.",
    "The supplier is currently inactive. Review its record before posting new debt.",
  ],
  invoice_cancelled: [
    "الفاتورة ملغاة ماليًا ولا يمكن ترحيلها من جديد. يمكنك استرداد نتيجة العملية الأصلية فقط.",
    "This invoice is financially cancelled and cannot be posted again. Its original acknowledgement remains recoverable.",
  ],

  supplier_reauthentication_required: [
    "سجّل الدخول من جديد لتأكيد هوية الترحيل. تبقى العمليات المحفوظة كما هي.",
    "Sign in again to verify posting identity. Saved operations stay unchanged.",
  ],
  supplier_saved_authority_mismatch: [
    "هذه العملية من هوية أو نسخة استعادة سابقة. تبقى محفوظة للمراجعة؛ يمكن بدء عملية مستقلة.",
    "This operation belongs to an earlier identity or restore epoch. It remains saved for review; independent work can continue.",
  ],
  invoice_payment_reversal_required: [
    "للفاتورة دفعات قائمة. اعكس الدفعات من مسارها المخوّل قبل إلغاء الفاتورة.",
    "Existing payments must be voided through their authorized flow before invoice cancellation.",
  ],
  supplier_storage_unavailable: [
    "تعذّر حفظ العملية بأمان. لم يبدأ طلب جديد؛ أعد تحميل الصفحة دون مسح بيانات المتصفح.",
    "The operation could not be saved safely. Reload without clearing browser data.",
  ],
  schema_not_ready: [
    "إعداد هوية وترحيل فواتير الموردين غير مكتمل. راجع مسؤول النظام.",
    "Supplier identity and posting setup is incomplete. Contact the system administrator.",
  ],
  idempotency_conflict: [
    "لا يطابق الطلب محتواه المحفوظ. احتفظ بالعملية وراجع المستند.",
    "The request does not match its saved content. Preserve the operation and review the document.",
  ],
  stale_version: [
    "تغيّر إصدار الفاتورة. أوقف العملية المحفوظة صراحة إن لم تُنفذ، ثم راجع الإصدار الحالي.",
    "The invoice revision changed. Explicitly stop the saved operation if uncommitted, then review the current revision.",
  ],
  stale_order: [
    "تغيّر أمر الشراء. راجع المطابقة مع الإصدار الحالي قبل الترحيل.",
    "The purchase order changed. Review matching against its current revision before posting.",
  ],
  operation_forbidden: [
    "لا توجد صلاحية حالية لإدارة فواتير الموردين.",
    "Current supplier-management permission is required.",
  ],
};
function message(code: string, en: boolean) {
  return (
    errors[code]?.[en ? 1 : 0] ??
    (en
      ? "The result is unconfirmed or the invoice needs review. Retry the exact saved operation, or explicitly stop it after review. Do not clear browser data."
      : "النتيجة غير مؤكدة أو تحتاج الفاتورة إلى مراجعة. أعد تأكيد العملية نفسها أو أوقفها صراحة بعد المراجعة. لا تمسح بيانات المتصفح.")
  );
}
const field =
  "w-full min-w-0 rounded border border-blue-200 bg-white px-3 py-2 text-sm";
export function SupplierFinancePanel({
  data,
  locale,
  legacyPending,
  onChanged,
}: {
  data: Workbench;
  locale: "ar" | "en";
  legacyPending: boolean;
  onChanged: () => void;
}) {
  const en = locale === "en",
    t = (ar: string, english: string) => (en ? english : ar);
  const [orderId, setOrderId] = useState(data.orders[0]?.id ?? ""),
    [generation, setGeneration] = useState(0),
    [view, setView] = useState<{
      orderId: string;
      data: SupplierFinanceView;
    } | null>(null),
    [error, setError] = useState("");
  const [confirmation, setConfirmation] = useState<{
      invoice: Invoice;
      action: "post" | "cancel";
    } | null>(null),
    [reason, setReason] = useState(""),
    [editing, setEditing] = useState<string | null>(null),
    [notice, setNotice] = useState("");
  const current = view?.orderId === orderId ? view.data : null;
  const commands = useSupplierCommand(current?.authority ?? null, () => {
    setNotice(
      t(
        "تم تأكيد نتيجة العملية. راجع المستحق وحالة الفاتورة أدناه.",
        "Operation outcome confirmed. Review the payable and invoice status below.",
      ),
    );
    setGeneration((x) => x + 1);
    onChanged();
  });
  useEffect(() => {
    if (!orderId) return;
    let active = true;
    const controller = new AbortController();
    fetch(
      `/api/inventory/procurement?view=supplier-finance&orderId=${encodeURIComponent(orderId)}`,
      { cache: "no-store", signal: controller.signal },
    )
      .then(async (r) => {
        const body = await r.json();
        if (!r.ok) throw new Error(body.code ?? "supplier_result_uncertain");
        if (active) { setError(""); setView({ orderId, data: body }); }
      })
      .catch((e) => {
        if (active) {
          setView(null);
          setError(
            e instanceof Error ? e.message : "supplier_result_uncertain",
          );
        }
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [orderId, generation]);
  const pendingFor = (id: string) =>
    commands.saved.some((s) => s.intent.input.invoiceId === id);
  const busy = commands.busy || !commands.ready;
  return (
    <section className={styles.panel} data-testid="supplier-finance-panel">
      <h2 className={styles.panelHeading}>
        {t("ترحيل فواتير الموردين", "Supplier invoice posting")}
      </h2>
      <div className="space-y-4 p-4">
        <p className={styles.caption}>
          {t(
            "المطابقة تراجع المستند. الترحيل يثبت مستحقًا للمورد دون دفع أو تغيير للمخزون. الإلغاء المالي يحتفظ بالاستلام والكميات.",
            "Matching reviews the document. Posting creates the supplier payable without payment or stock changes. Financial cancellation retains receipts and quantities.",
          )}
        </p>
        {legacyPending ? (
          <p
            className={`${styles.note} rounded border border-orange-200 bg-orange-50`}
            data-testid="supplier-legacy-preserved"
          >
            {t(
              "توجد عملية قديمة غير مؤكدة، وما زالت محفوظة في قسم الاسترداد. يمكنك متابعة فاتورة مستقلة هنا دون حذفها أو تغيير مفتاحها.",
              "An older unresolved operation remains saved in recovery. You can continue an independent invoice here without deleting or changing it.",
            )}
          </p>
        ) : null}
        <label className="block text-sm font-semibold">
          {t("أمر الشراء للفواتير", "Invoice purchase order")}
          <select
            className={field}
            aria-label={t("أمر الشراء للفواتير", "Invoice purchase order")}
            value={orderId}
            disabled={commands.busy}
            onChange={(e) => {
              setOrderId(e.target.value);
              setConfirmation(null);
              setEditing(null);
            }}
          >
            {data.orders.map((o) => (
              <option key={o.id} value={o.id}>
                {data.suppliers.find((s) => s.id === o.document.supplierPartyId)
                  ?.name ?? `#${o.document.supplierPartyId}`}{" "}
                · {o.document.currency} · {o.id.slice(0, 8)}
              </option>
            ))}
          </select>
        </label>
        {error || commands.error ? (
          <div
            role="alert"
            className="rounded border border-orange-200 bg-orange-50 p-3 text-sm"
          >
            {message(error || commands.error, en)}
            {(error || commands.error) ===
            "supplier_reauthentication_required" ? (
              <Link href="/login" className="ms-2 underline">
                {t("تسجيل الدخول", "Sign in")}
              </Link>
            ) : null}
          </div>
        ) : null}
        {notice ? (
          <p role="status" className="text-sm text-green-800">
            {notice}
          </p>
        ) : null}
        {commands.saved.length ? (
          <section
            aria-label={t("عمليات ترحيل محفوظة", "Saved supplier operations")}
            className="space-y-3"
          >
            {commands.saved.map((s) => (
              <article
                key={s.intent.nonce}
                className="rounded border border-orange-200 bg-orange-50 p-3 text-sm"
                data-testid="supplier-saved-intent"
              >
                <p className="font-semibold">
                  {t("عملية محفوظة غير مؤكدة", "Saved unconfirmed operation")} ·{" "}
                  {s.intent.action === "post"
                    ? t("ترحيل", "Post")
                    : s.intent.action === "cancel"
                      ? t("إلغاء", "Cancel")
                      : t("مراجعة", "Revise")}
                </p>
                <p className="break-all">{s.intent.input.invoiceId}</p>
                <p>{s.intent.input.reason}</p>
                {s.intent.authority.executionEpochId !==
                current?.authority.executionEpochId ? (
                  <div>
                    <p>{message("supplier_saved_authority_mismatch", en)}</p>
                    <button
                      type="button"
                      className={styles.button}
                      disabled={busy}
                      onClick={() => void commands.retry(s)}
                    >
                      {t(
                        "التحقق من النتيجة الأصلية فقط",
                        "Check original result only",
                      )}
                    </button>
                  </div>
                ) : (
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      type="button"
                      className={styles.button}
                      disabled={busy}
                      onClick={() => void commands.retry(s)}
                    >
                      {t("إعادة تأكيد العملية نفسها", "Retry saved operation")}
                    </button>
                    <button
                      type="button"
                      className={styles.button}
                      disabled={busy}
                      onClick={() => {
                        const reason = window.prompt(
                          t(
                            "سبب إيقاف العملية غير المنفذة؛ إن نُفذت فستُعرض نتيجتها الأصلية.",
                            "Reason to stop an uncommitted operation; if committed, its original result will be returned.",
                          ),
                        );
                        if (reason && reason.trim().length >= 3)
                          void commands.retire(s, reason);
                      }}
                    >
                      {t(
                        "إيقاف العملية غير المنفذة",
                        "Stop uncommitted operation",
                      )}
                    </button>
                  </div>
                )}
              </article>
            ))}
          </section>
        ) : null}
        {!current && !error ? (
          <p role="status">{t("جارٍ قراءة الفواتير…", "Loading invoices…")}</p>
        ) : null}
        {current?.invoices.length === 0 ? (
          <p className={styles.caption}>
            {t(
              "لا توجد فاتورة محفوظة لهذا الأمر بعد. احفظ المطابقة أولًا.",
              "No saved invoice for this order yet. Save its match first.",
            )}
          </p>
        ) : null}
        {current?.invoices.map((invoice) => (
          <article
            key={`${invoice.invoiceId}:${invoice.version}`}
            className={`${styles.item} space-y-3`}
            data-testid="supplier-finance-invoice"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-semibold">
                {invoice.document.invoiceNumber ??
                  t("فاتورة بلا رقم", "Unnumbered invoice")}{" "}
                · {t("إصدار", "Revision")} {invoice.version}
              </h3>
              <span
                className={styles.badge}
                data-state={
                  invoice.status === "unposted" ? "estimated" : "known"
                }
              >
                {invoice.status === "posted"
                  ? t("مستحق مُرحّل", "Payable posted")
                  : invoice.status === "cancelled"
                    ? t("ملغاة ماليًا", "Financially cancelled")
                    : t("غير مُرحّلة", "Not posted")}
              </span>
            </div>
            <p>
              {invoice.native
                ? formatMoney(
                    invoice.native.amountMinor,
                    invoice.native.currency,
                  )
                : t("القيمة غير مكتملة", "Incomplete amount")}
            </p>
            {invoice.numberCompletionEvidence ? (
              <p
                className={styles.caption}
                data-testid="official-number-lineage"
              >
                {t(
                  "استُكمل الرقم الرسمي في الإصدار",
                  "Official number completed in revision",
                )}{" "}
                {invoice.numberCompletionEvidence.version} ·{" "}
                {t("سبب الغياب في الأصل:", "Original missing-number reason:")}{" "}
                {invoice.numberCompletionEvidence.originalMissingReason}
              </p>
            ) : null}
            {invoice.frozenValuation ? (
              <p className={styles.caption}>
                {t("المكافئ المثبت", "Frozen base")}{" "}
                {formatMoney(invoice.frozenValuation.baseAmountMinor, "YER")} ·{" "}
                {t("سعر التقييم", "FX rate")}{" "}
                <bdi>{invoice.frozenValuation.rateToBase}</bdi> ·{" "}
                {invoice.frozenValuation.sourceRef}
              </p>
            ) : null}
            {invoice.payableId ? (
              <div className="space-y-2">
                <p>
                  {t("مستحق المورد", "Supplier payable")}{" "}
                  <bdi>#{invoice.payableId}</bdi> · {t("المسدّد", "Settled")}{" "}
                  {invoice.settledMinor === null
                    ? t("غير متاح", "Unavailable")
                    : formatMoney(
                        invoice.settledMinor,
                        invoice.document.currency,
                      )}{" "}
                  · {t("المتبقي", "Remaining")}{" "}
                  {invoice.effectiveMinor === null ||
                  invoice.settledMinor === null
                    ? t("غير متاح", "Unavailable")
                    : formatMoney(
                        Math.max(
                          0,
                          invoice.effectiveMinor - invoice.settledMinor,
                        ),
                        invoice.document.currency,
                      )}
                </p>
                <Link
                  href={`/finance/parties/${invoice.document.supplierPartyId}`}
                  className="inline-block text-sm font-semibold text-blue-800 underline"
                >
                  {t("كشف المورد والسداد", "Supplier ledger and payment")}
                </Link>
              </div>
            ) : null}
            {invoice.blockedReason ? (
              <p className="text-sm text-orange-900">
                {message(invoice.blockedReason, en)}
              </p>
            ) : null}
            {invoice.match.issues.length ? (
              <p className="text-sm text-orange-900">
                {t(
                  "تحتاج المطابقة إلى مراجعة قبل الترحيل.",
                  "Matching requires review before posting.",
                )}
              </p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className={styles.button}
                disabled={
                  busy || pendingFor(invoice.invoiceId) || !invoice.canRevise
                }
                onClick={() =>
                  setEditing(
                    editing === invoice.invoiceId ? null : invoice.invoiceId,
                  )
                }
              >
                {t("مراجعة الإصدار", "Revise invoice")}
              </button>
              <button
                type="button"
                className={`${styles.button} ${styles.primary}`}
                disabled={
                  busy || pendingFor(invoice.invoiceId) || !invoice.canPost
                }
                onClick={() => {
                  setConfirmation({ invoice, action: "post" });
                  setReason("");
                }}
              >
                {t("ترحيل مستحق المورد", "Post supplier payable")}
              </button>
              <button
                type="button"
                className={styles.button}
                disabled={
                  busy || pendingFor(invoice.invoiceId) || !invoice.canCancel
                }
                onClick={() => {
                  setConfirmation({ invoice, action: "cancel" });
                  setReason("");
                }}
              >
                {t("إلغاء الفاتورة غير المسدّدة", "Cancel unpaid invoice")}
              </button>
            </div>
            {editing === invoice.invoiceId ? (
              <RevisionEditor
                invoice={invoice}
                data={data}
                locale={locale}
                busy={busy || pendingFor(invoice.invoiceId)}
                save={async (document, reason) => {
                  const ok = await commands.start("revise", {
                    invoiceId: invoice.invoiceId,
                    expectedVersion: invoice.version,
                    expectedDigest: invoice.digest,
                    reason,
                    document,
                  });
                  if (ok) setEditing(null);
                }}
              />
            ) : null}
          </article>
        ))}
        {confirmation ? (
          <form
            className="space-y-3 rounded border-2 border-orange-300 bg-orange-50 p-4"
            data-testid="supplier-confirmation"
            onSubmit={async (e) => {
              e.preventDefault();
              if (
                reason.trim().length < 3 ||
                pendingFor(confirmation.invoice.invoiceId)
              )
                return;
              const i = confirmation.invoice;
              const ok = await commands.start(confirmation.action, {
                invoiceId: i.invoiceId,
                expectedVersion: i.version,
                expectedDigest: i.digest,
                reason,
              });
              if (ok) setConfirmation(null);
            }}
          >
            <h3 className="font-semibold">
              {confirmation.action === "post"
                ? t("تأكيد ترحيل المستحق", "Confirm payable posting")
                : t(
                    "تأكيد الإلغاء المالي الكامل",
                    "Confirm full financial cancellation",
                  )}
            </h3>
            <p>
              {t("الفاتورة", "Invoice")}{" "}
              {confirmation.invoice.document.invoiceNumber} ·{" "}
              {confirmation.invoice.native
                ? formatMoney(
                    confirmation.invoice.native.amountMinor,
                    confirmation.invoice.native.currency,
                  )
                : ""}
            </p>
            <p className="text-sm">
              {confirmation.action === "post"
                ? t(
                    "سيُسجل دين المورد مرة واحدة. لا يُسجل دفع أو استلام جديد.",
                    "The supplier debt will be recorded once. No payment or new receipt is created.",
                  )
                : t(
                    "سيُعكس المستحق غير المسدّد بالكامل. تبقى المواد والاستلام محفوظة ولا يُنشأ رد نقدي.",
                    "The unpaid payable will be reversed in full. Stock and receipts stay recorded; no cash refund is created.",
                  )}
            </p>
            <label className="block text-sm">
              {t("سبب العملية", "Operation reason")}
              <textarea
                className={field}
                required
                minLength={3}
                maxLength={2000}
                value={reason}
                disabled={busy}
                onChange={(e) => setReason(e.target.value)}
              />
            </label>
            <div className="flex flex-wrap gap-2">
              <button
                className={`${styles.button} ${styles.primary}`}
                disabled={
                  busy ||
                  reason.trim().length < 3 ||
                  pendingFor(confirmation.invoice.invoiceId)
                }
              >
                {t("تأكيد العملية", "Confirm operation")}
              </button>
              <button
                type="button"
                className={styles.button}
                disabled={commands.busy}
                onClick={() => setConfirmation(null)}
              >
                {t("رجوع", "Back")}
              </button>
            </div>
          </form>
        ) : null}
      </div>
    </section>
  );
}
function RevisionEditor({
  invoice,
  data,
  locale,
  busy,
  save,
}: {
  invoice: Invoice;
  data: Workbench;
  locale: "ar" | "en";
  busy: boolean;
  save: (document: SupplierInvoiceRevision, reason: string) => Promise<void>;
}) {
  const en = locale === "en",
    t = (a: string, b: string) => (en ? b : a),
    original = invoice.document,
    currency = original.currency;
  const currentOrder = data.orders.find(
    (o) => o.id === original.orderId,
  )?.document;
  const receipts = effectiveOrderReceipts(data, original.orderId);
  const [lines, setLines] = useState(
    original.lines.map((l) => ({
      ...l,
      priceInput:
        l.price.state === "missing"
          ? ""
          : toInputAmount(l.price.unitPriceMinor, currency),
      receiptAllocations: [...l.receiptAllocations],
    })),
  );
  const [officialNumber, setOfficialNumber] = useState(
    original.invoiceNumber ?? "",
  );
  const [shipping, setShipping] = useState(
      toInputAmount(original.shippingMinor, currency),
    ),
    [discount, setDiscount] = useState(
      toInputAmount(original.discountMinor, currency),
    ),
    [rate, setRate] = useState(original.valuation?.rateToBase ?? ""),
    [source, setSource] = useState(original.valuation?.sourceRef ?? ""),
    [reason, setReason] = useState(""),
    [error, setError] = useState("");
  const money = (value: string, c: Currency) => {
    const n = parseAmount(value, c);
    const exact = decimalRatio(value);
    if (
      n === null ||
      n < 0 ||
      (exact.numerator * BigInt(MINOR_UNITS[c])) % exact.denominator !== 0n
    )
      throw new Error(
        t("اكتب مبلغًا صحيحًا دون تقريب.", "Enter an exact valid amount."),
      );
    return n;
  };
  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    try {
      if (
        !currentOrder ||
        lines.some(
          (l) =>
            !currentOrder.lines.some((source) => source.id === l.orderLineId),
        )
      )
        throw new Error(
          t(
            "راجع توافق البنود مع أمر الشراء الحالي قبل حفظ الإصدار.",
            "Review invoice line compatibility with the current purchase order before saving.",
          ),
        );
      const next = {
        ...original,
        version: original.version + 1,
        orderVersion: currentOrder.version,
        invoiceNumber:
          original.invoiceNumber ?? (officialNumber.trim() || null),
        missingNumberReason:
          original.invoiceNumber === null && officialNumber.trim()
            ? null
            : original.missingNumberReason,
        shippingMinor: money(shipping, currency),
        discountMinor: money(discount, currency),
        lines: lines.map(({ priceInput, ...l }) => ({
          ...l,
          price: {
            state: "known" as const,
            currency,
            unitPriceMinor: money(priceInput, currency),
            reason: source,
          },
        })),
        valuation: null,
      } as SupplierInvoiceRevision;
      const amountMinor =
        next.lines.reduce(
          (sum, l) =>
            sum +
            proportionalCostMinor(
              l.price.state === "missing" ? 0 : l.price.unitPriceMinor,
              Number(quantityAtoms(l.quantity)),
              1000,
            ),
          0,
        ) +
        next.shippingMinor -
        next.discountMinor;
      if (!Number.isSafeInteger(amountMinor) || amountMinor < 0)
        throw new Error(t("راجع الإجمالي.", "Review the total."));
      const document = {
        ...next,
        valuation: valuationSnapshot({
          purpose: "invoice_valuation",
          currency,
          amountMinor,
          rateToBase: rate,
          capturedAt: new Date().toISOString(),
          sourceRef: source,
        }),
      };
      await save(document, reason);
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : t("راجع البيانات.", "Review the fields."),
      );
    }
  }
  return (
    <form
      className="space-y-3 rounded border border-blue-200 bg-blue-50 p-3"
      data-testid="supplier-revision-form"
      onSubmit={submit}
    >
      <p className="text-sm">
        {t(
          "المورد والعملة والرقم المثبت ثابتة. يمكن استكمال الرقم الرسمي المفقود بإصدار مراجعة مع حفظ الأصل.",
          "Supplier, currency and an established number stay fixed. Complete a missing official number in a reviewed revision while preserving the original.",
        )}
      </p>
      {original.invoiceNumber === null && invoice.canCompleteNumber ? (
        <label className="block text-sm">
          {t("الرقم الرسمي المستكمل", "Complete official invoice number")}
          <input
            className={field}
            value={officialNumber}
            maxLength={120}
            disabled={busy}
            onChange={(e) => setOfficialNumber(e.target.value)}
          />
          <span className={styles.caption}>
            {t("سبب غياب الرقم المحفوظ:", "Preserved missing-number reason:")}{" "}
            {original.missingNumberReason}
          </span>
        </label>
      ) : null}
      {lines.map((l, index) => (
        <fieldset
          key={l.id}
          className="grid min-w-0 gap-2 rounded border border-blue-200 p-3 sm:grid-cols-2"
        >
          <legend className="text-sm">
            {t("البند", "Line")} {index + 1}
          </legend>
          <label className="text-sm">
            {t("الكمية", "Quantity")}
            <input
              className={field}
              required
              disabled={busy}
              value={l.quantity}
              onChange={(e) =>
                setLines((rows) =>
                  rows.map((r) =>
                    r.id === l.id ? { ...r, quantity: e.target.value } : r,
                  ),
                )
              }
            />
          </label>
          <label className="text-sm">
            {t("ثمن الوحدة", "Unit price")} ({currency})
            <input
              className={field}
              required
              disabled={busy}
              value={l.priceInput}
              onChange={(e) =>
                setLines((rows) =>
                  rows.map((r) =>
                    r.id === l.id ? { ...r, priceInput: e.target.value } : r,
                  ),
                )
              }
            />
          </label>
          {l.receiptAllocations.map((a) => (
            <div key={a.id} className="min-w-0 space-y-2 sm:col-span-2">
              <label className="text-sm">
                {t("جزء الاستلام", "Receipt portion")}
                <select
                  className={field}
                  aria-label={t("جزء الاستلام", "Receipt portion")}
                  disabled={busy}
                  value={a.receiptLineId}
                  onChange={(e) =>
                    setLines((rows) =>
                      rows.map((r) =>
                        r.id === l.id
                          ? {
                              ...r,
                              receiptAllocations: r.receiptAllocations.map(
                                (x) =>
                                  x.id === a.id
                                    ? { ...x, receiptLineId: e.target.value }
                                    : x,
                              ),
                            }
                          : r,
                      ),
                    )
                  }
                >
                  {!receipts.some(
                    (r) =>
                      r.id === a.receiptLineId &&
                      r.document.disposition === "accepted",
                  ) ? (
                    <option value={a.receiptLineId} disabled>
                      {t(
                        "تخصيص محفوظ يحتاج مراجعة القبول",
                        "Saved allocation requires acceptance review",
                      )}
                    </option>
                  ) : null}
                  {receipts
                    .filter(
                      (r) =>
                        r.order_id === original.orderId &&
                        r.document.orderLineId === l.orderLineId &&
                        r.document.disposition === "accepted",
                    )
                    .map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.document.lotCode ?? r.id.slice(0, 8)} ·{" "}
                        {r.document.baseQuantity}
                      </option>
                    ))}
                </select>
              </label>
              <label className="text-sm">
                {t("الكمية بوحدة الأساس", "Base quantity")}
                <input
                  className={field}
                  required
                  disabled={busy}
                  value={a.baseQuantity}
                  onChange={(e) =>
                    setLines((rows) =>
                      rows.map((r) =>
                        r.id === l.id
                          ? {
                              ...r,
                              receiptAllocations: r.receiptAllocations.map(
                                (x) =>
                                  x.id === a.id
                                    ? { ...x, baseQuantity: e.target.value }
                                    : x,
                              ),
                            }
                          : r,
                      ),
                    )
                  }
                />
              </label>
              <button
                type="button"
                className={styles.button}
                disabled={busy}
                onClick={() =>
                  setLines((rows) =>
                    rows.map((r) =>
                      r.id === l.id
                        ? {
                            ...r,
                            receiptAllocations: r.receiptAllocations.filter(
                              (x) => x.id !== a.id,
                            ),
                          }
                        : r,
                    ),
                  )
                }
              >
                {t("حذف التخصيص", "Remove allocation")}
              </button>
            </div>
          ))}
          <button
            type="button"
            className={styles.button}
            disabled={busy}
            onClick={() => {
              const receipt = receipts.find(
                (r) =>
                  r.order_id === original.orderId &&
                  r.document.orderLineId === l.orderLineId &&
                  r.document.disposition === "accepted",
              );
              if (receipt)
                setLines((rows) =>
                  rows.map((r) =>
                    r.id === l.id
                      ? {
                          ...r,
                          receiptAllocations: [
                            ...r.receiptAllocations,
                            {
                              id: crypto.randomUUID(),
                              invoiceLineId: l.id,
                              receiptLineId: receipt.id,
                              baseQuantity: "",
                            },
                          ],
                        }
                      : r,
                  ),
                );
            }}
          >
            {t("إضافة تخصيص مقبول", "Add accepted allocation")}
          </button>
        </fieldset>
      ))}
      <div className="grid gap-3 sm:grid-cols-2">
        {[
          [t("الشحن", "Shipping"), shipping, setShipping],
          [t("الخصم", "Discount"), discount, setDiscount],
          [t("سعر التقييم إلى اليمني", "FX rate to YER"), rate, setRate],
          [t("مصدر التقييم", "Valuation source"), source, setSource],
        ].map(([label, value, set]) => (
          <label key={label as string} className="text-sm">
            {label as string}
            <input
              className={field}
              required
              disabled={busy}
              value={value as string}
              onChange={(e) => (set as (v: string) => void)(e.target.value)}
            />
          </label>
        ))}
      </div>
      <label className="block text-sm">
        {t("سبب المراجعة", "Revision reason")}
        <textarea
          className={field}
          required
          minLength={3}
          value={reason}
          disabled={busy}
          onChange={(e) => setReason(e.target.value)}
        />
      </label>
      <button
        className={`${styles.button} ${styles.primary}`}
        disabled={busy || reason.trim().length < 3}
      >
        {t("حفظ الإصدار الجديد", "Save new revision")}
      </button>
      {error ? (
        <p role="alert" className="text-sm text-red-800">
          {error}
        </p>
      ) : null}
    </form>
  );
}
