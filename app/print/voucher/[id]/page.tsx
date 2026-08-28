import { notFound } from "next/navigation";
import { getExpense, getSettingsSafe, printCount } from "@/lib/db";
import { EXPENSE_CATEGORY_LABEL } from "@/lib/expenses";
import { CURRENCY_LABEL, formatMoney, isCurrency } from "@/lib/money";
import { friendlyDateLong, friendlyTime } from "@/lib/reminders";
import { PrintHeader, PrintFooter } from "@/components/PrintHeader";
import { PrintButton, ReprintMark } from "@/components/PrintButton";
import { canHandleMoney } from "@/lib/roles";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/** سند الصرف — ربع ورقة A4، بنفس مقاس سند القبض ليُحفظا معًا في ملف واحد. */
export default async function VoucherPage({ params }: { params: Promise<{ id: string }> }) {
  // الطبيب لا يرى السندات والفواتير: صفحة الطباعة بابٌ خلفي إلى المال لو تُركت
  // مفتوحة لكل من يملك جلسة.
  const session = await requireSession();
  if (!session || !canHandleMoney(session.role)) notFound();

  const { id: rawId } = await params;
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) notFound();

  const [expense, settings] = await Promise.all([getExpense(id), getSettingsSafe()]);
  const printed = await printCount("voucher", id);
  if (!expense) notFound();

  const base = isCurrency(settings["finance.base_currency"])
    ? settings["finance.base_currency"] : "YER";
  const stamped = new Date(expense.createdAt);
  const dateText = `${stamped.getFullYear()}-${String(stamped.getMonth() + 1).padStart(2, "0")}-${String(stamped.getDate()).padStart(2, "0")}`;

  return (
    <>
      <PrintButton docType="voucher" docId={id} />
      <ReprintMark printed={printed > 0} />
      <div className="sheet sheet-a6">
        <PrintHeader settings={settings} title="سند صرف" compact />

        <div className="line">
          <span>رقم السند</span>
          <span className="num" dir="ltr">{expense.voucherNumber}</span>
        </div>
        <div className="line">
          <span>التاريخ</span>
          <span>
            {friendlyDateLong(dateText)} ·{" "}
            {friendlyTime(`${String(stamped.getHours()).padStart(2, "0")}:${String(stamped.getMinutes()).padStart(2, "0")}`)}
          </span>
        </div>
        <div className="rule-light" />

        <div className="line">
          <span>صُرف إلى</span>
          <span style={{ fontWeight: 700 }}>{expense.partyName ?? expense.payeeText}</span>
        </div>
        <div className="line">
          <span>البند</span>
          <span>{EXPENSE_CATEGORY_LABEL[expense.category]}</span>
        </div>

        <p className="amount-box">{formatMoney(expense.amountMinor, expense.currency)}</p>

        {expense.currency !== base ? (
          <>
            <div className="line">
              <span>العملة</span>
              <span>{CURRENCY_LABEL[expense.currency]}</span>
            </div>
            <div className="line">
              <span>سعر الصرف يوم الصرف</span>
              <span className="num" dir="ltr">{expense.exchangeRate}</span>
            </div>
            <div className="line line-strong">
              <span>المكافئ</span>
              <span>{formatMoney(expense.baseAmountMinor, base)}</span>
            </div>
          </>
        ) : null}

        {expense.note ? (
          <>
            <div className="rule-light" />
            <p className="footer-note">{expense.note}</p>
          </>
        ) : null}

        <div className="sign-row">
          <span>الصارف: {expense.createdBy ?? "—"}</span>
          <span>المستلم: ................</span>
        </div>

        <PrintFooter settings={settings} />
      </div>
    </>
  );
}
