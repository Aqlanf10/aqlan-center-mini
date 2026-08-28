import { notFound } from "next/navigation";

import { requireRole } from "@/lib/auth/guards";
import { getI18n } from "@/i18n/server";
import { formatZonedDateTime } from "@/lib/datetime";
import { formatMoney } from "@/lib/money";
import { PrintButton } from "@/components/print/print-button";
import { PrintMasthead, SignatureRow } from "@/components/print/print-masthead";
import { getVoucherById } from "@/server/finance/reports";
import { recordVoucherPrintAction } from "@/server/finance/voucher-actions";

export const dynamic = "force-dynamic";

export default async function ReceiptPrintPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireRole(["ADMIN", "RECEPTION"], "/finance/receipts");
  const { locale, dict } = await getI18n();
  const { id } = await params;

  const voucher = await getVoucherById(id);
  if (!voucher) {
    notFound();
  }

  // Print audit (reprint-safe, no sensitive data).
  await recordVoucherPrintAction(voucher.id, voucher.status === "REVERSED");

  const isReceipt = voucher.type === "RECEIPT";
  const title = isReceipt ? dict.print.receiptVoucher : dict.print.paymentVoucher;

  const partyName =
    voucher.partyType === "PATIENT"
      ? `${voucher.patientName ?? ""} (${voucher.patientFileNumber ?? ""})`
      : voucher.partyType === "DOCTOR"
        ? (voucher.doctorName ?? "")
        : (voucher.otherPartyName ?? "");

  return (
    <div className="pb-24">
      <div className="print-sheet print-sheet--a5 mx-auto border shadow-sm">
        <PrintMasthead subtitle={title} />

        <div className="mt-4 space-y-3 text-sm">
          <div className="flex items-center justify-between">
            <p className="font-semibold">{title}</p>
            <p className="font-mono text-xs" dir="ltr">
              {dict.print.voucherNumber}: {voucher.voucherNumber}
            </p>
          </div>

          <Row label={dict.print.date} value={formatZonedDateTime(voucher.voucherDate, locale)} />
          <Row label={dict.print.party} value={partyName} />
          {voucher.expenseCategoryAr ? (
            <Row
              label={dict.financeVouchers.fields.expenseCategory}
              value={locale === "ar" ? voucher.expenseCategoryAr : voucher.expenseCategoryEn ?? ""}
            />
          ) : null}
          <div className="flex items-center justify-between border-y py-2 text-base font-bold">
            <span>{dict.print.amount}</span>
            <span dir="ltr">
              {formatMoney(
                Math.round(parseFloat(voucher.amount) * 100),
                voucher.currency,
                locale
              )}
            </span>
          </div>
          <Row
            label={dict.print.paymentMethod}
            value={dict.financeVouchers.paymentMethods[voucher.paymentMethod]}
          />
          {voucher.description ? (
            <Row label={dict.print.description} value={voucher.description} />
          ) : null}
          {voucher.reference ? <Row label={dict.print.reference} value={voucher.reference} /> : null}
          <Row label={dict.print.issuedBy} value={voucher.createdByName ?? ""} />

          {voucher.status === "REVERSED" ? (
            <p className="rounded border border-black bg-black/5 p-2 text-center text-xs font-semibold">
              {dict.print.reversalNote}
              {voucher.reversalReason ? ` — ${voucher.reversalReason}` : ""}
            </p>
          ) : null}
        </div>

        <SignatureRow
          labels={{
            recipient: dict.print.signatureRecipient,
            accountant: dict.print.signatureAccountant,
            approval: dict.print.signatureApproval,
          }}
        />
      </div>

      <p className="print-hide text-muted-foreground mt-3 text-center text-xs">
        {dict.print.printHint}
      </p>
      <PrintButton />
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <span className="text-black/60">{label}</span>
      <span className="text-end font-medium">{value}</span>
    </div>
  );
}
