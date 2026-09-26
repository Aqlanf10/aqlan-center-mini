import { notFound } from "next/navigation";
import { getParty, getSettingsSafe, partyStatement } from "@/lib/db";
import { EXPENSE_CATEGORY_LABEL, PARTY_KIND_LABEL } from "@/lib/expenses";
import { CURRENCY_LABEL, formatMoney } from "@/lib/money";
import { friendlyDateLong } from "@/lib/reminders";
import { PrintHeader, PrintFooter } from "@/components/PrintHeader";
import { PrintButton } from "@/components/PrintButton";
import { canViewMoney } from "@/lib/roles";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * كشف حساب جهة — مختبر أو مورّد (أو طبيب لسندات صرف عمولته).
 *
 * الورقة التي تُسلَّم لصاحب المختبر آخر الشهر: كل التزامٍ بتاريخه وما سُدّد منه
 * وما بقي، وكل سند صرفٍ برقمه — ثم الإجمالي لكل عملةٍ بسطرها، وسطرا توقيع
 * للطرفين. لا رقمٌ واحد يمزج الريال بالسعودي بالدولار.
 */
export default async function PartyStatementPrintPage({ params }: { params: Promise<{ id: string }> }) {
  // صفحة الطباعة بابٌ خلفي إلى المال لو تُركت مفتوحة لكل من يملك جلسة.
  const session = await requireSession();
  if (!session || !canViewMoney(session.role)) notFound();

  const { id: rawId } = await params;
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) notFound();

  const [party, statement, settings] = await Promise.all([
    getParty(id), partyStatement(id), getSettingsSafe(),
  ]);
  if (!party) notFound();

  const { payables, expenses, totals } = statement;
  // الأقدم أولًا في الورقة: الكشف يُقرأ كدفترٍ من أوّله إلى رصيده.
  const payablesAsc = [...payables].reverse();
  const expensesAsc = [...expenses].reverse();

  return (
    <>
      <PrintButton />
      <div className="sheet sheet-a4">
        <PrintHeader settings={settings} title="كشف حساب جهة" />

        <div className="line">
          <span>الجهة</span>
          <span style={{ fontWeight: 700 }}>{party.name} — {PARTY_KIND_LABEL[party.kind]}</span>
        </div>
        {party.phone ? (
          <div className="line">
            <span>الهاتف</span>
            <span className="num" dir="ltr">{party.phone}</span>
          </div>
        ) : null}
        <div className="rule" />

        <p style={{ fontSize: "10pt", fontWeight: 700, margin: "2mm 0" }}>الالتزامات (فواتير وأعمال)</p>
        <table className="items">
          <thead>
            <tr>
              <th>التاريخ</th><th>البيان</th><th className="num">المبلغ</th>
              <th className="num">المسدَّد</th><th className="num">المتبقي</th>
            </tr>
          </thead>
          <tbody>
            {payablesAsc.length === 0 ? (
              <tr><td colSpan={5}>لا التزامات مسجّلة</td></tr>
            ) : payablesAsc.map((row) => (
              <tr key={row.id}>
                <td>{friendlyDateLong(row.createdAt.slice(0, 10))}</td>
                <td>
                  {row.description}
                  {row.labOrderId ? " (أمر مختبر)" : ""}
                  {row.dueDate ? ` — يستحق ${friendlyDateLong(row.dueDate)}` : ""}
                </td>
                <td className="num">{formatMoney(row.amountMinor, row.currency)}</td>
                <td className="num">{formatMoney(row.settledMinor, row.currency)}</td>
                <td className="num">{formatMoney(row.remainingMinor, row.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <p style={{ fontSize: "10pt", fontWeight: 700, margin: "5mm 0 2mm" }}>سندات الصرف</p>
        <table className="items">
          <thead>
            <tr>
              <th>السند</th><th>التاريخ</th><th>البند</th><th className="num">المبلغ</th>
            </tr>
          </thead>
          <tbody>
            {expensesAsc.length === 0 ? (
              <tr><td colSpan={4}>لم يُصرف شيء</td></tr>
            ) : expensesAsc.map((row) => (
              <tr key={row.id}>
                <td dir="ltr">{row.voucherNumber}</td>
                <td>{friendlyDateLong(row.createdAt.slice(0, 10))}</td>
                <td>
                  {row.reversalOfId !== null ? "إبطال سند" : EXPENSE_CATEGORY_LABEL[row.category] ?? row.category}
                  {row.payableId === null && row.reversalOfId === null ? " — على الحساب" : ""}
                </td>
                <td className="num">{formatMoney(row.amountMinor, row.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div style={{ marginTop: "5mm" }}>
          {totals.length === 0 ? (
            <div className="line line-strong"><span>الحساب</span><span>لا حركات</span></div>
          ) : totals.map((bucket) => (
            <div key={bucket.currency} style={{ marginBottom: totals.length > 1 ? "3mm" : 0 }}>
              {totals.length > 1 ? (
                <p style={{ fontSize: "10pt", fontWeight: 700, margin: "2mm 0" }}>
                  {CURRENCY_LABEL[bucket.currency]}
                </p>
              ) : null}
              <div className="line">
                <span>إجمالي الالتزامات</span>
                <span className="num">{formatMoney(bucket.owedMinor, bucket.currency)}</span>
              </div>
              <div className="line">
                <span>المسدَّد من الالتزامات</span>
                <span className="num">{formatMoney(bucket.settledMinor, bucket.currency)}</span>
              </div>
              <div className="line">
                <span>المصروف فعلًا بهذه العملة</span>
                <span className="num">{formatMoney(bucket.paidMinor, bucket.currency)}</span>
              </div>
              {bucket.unlinkedPaidMinor !== 0 ? (
                <div className="line">
                  <span>منه دفعات على الحساب (غير مربوطة بفاتورة)</span>
                  <span className="num">{formatMoney(bucket.unlinkedPaidMinor, bucket.currency)}</span>
                </div>
              ) : null}
              <div className="line line-strong">
                <span>المتبقي علينا</span>
                <span className="num">{formatMoney(bucket.remainingMinor, bucket.currency)}</span>
              </div>
            </div>
          ))}
        </div>

        <p className="footer-note" style={{ marginTop: "4mm" }}>
          المسدَّد والمتبقي بعملة الالتزام نفسه وبسعر صرف يوم الدفع — لا يتغيّر بتغيّر سعر اليوم.
        </p>

        <div className="sign-row">
          <span>عن العيادة: ................</span>
          <span>عن {PARTY_KIND_LABEL[party.kind]}: ................</span>
        </div>

        <PrintFooter settings={settings} />
      </div>
    </>
  );
}
