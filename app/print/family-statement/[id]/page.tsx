import { notFound } from "next/navigation";
import { CLINIC_TIME_ZONE, getSettingsSafe } from "@/lib/db";
import { CURRENCIES, CURRENCY_LABEL, formatMoney, type Currency } from "@/lib/money";
import { friendlyDateLong } from "@/lib/reminders";
import { clinicDateString } from "@/lib/schedule";
import { buildFamilyView } from "@/lib/family-view";
import { PrintHeader, PrintFooter } from "@/components/PrintHeader";
import { PrintButton } from "@/components/PrintButton";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

function balanceCell(minor: number | undefined, currency: Currency): string {
  if (!minor) return "—";
  return minor > 0 ? formatMoney(minor, currency) : `له ${formatMoney(-minor, currency)}`;
}

/**
 * (PAT-4) كشف العائلة — للاطلاع، لا سند.
 *
 * الأفراد ورصيد كلٍّ منهم بكل عملة (المحرّك الكانوني نفسه لكشف حساب المريض) ومجموعٌ لكل عملةٍ على
 * حدة. لمن يرى المال وحده: من يطبع كشف حساب المريض (المدير والاستقبال والكاشير والمحاسب)، والطبيب
 * بصلاحية «مدفوعات مرضاي» لمن يفتح ملفه من الأفراد. الضامن معلومةٌ — السداد يُسجَّل على حساب كل فرد.
 */
export default async function FamilyStatementPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) notFound();
  const { id: rawId } = await params;
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) notFound();

  const [result, settings] = await Promise.all([buildFamilyView(session, id), getSettingsSafe()]);
  if (!result.ok || !result.view.canSeeMoney) notFound();
  const family = result.view;
  const currencies = CURRENCIES.filter((currency) =>
    family.members.some((member) => member.balances?.some((line) => line.currency === currency)));
  const totalOf = (currency: Currency) => family.totals?.find((line) => line.currency === currency)?.balanceMinor;
  const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
  const g = family.guarantor;
  const guarantor = g.kind === "none" ? "—"
    : g.hidden ? "ضامنٌ من مرضى آخرين"
      : `${g.name ?? ""}${g.patientNumber ? ` (ملف ${g.patientNumber})` : ""}${g.phone ? ` — ${g.phone}` : ""}`;

  return (
    <>
      <PrintButton />
      <div className="sheet sheet-a4">
        <PrintHeader settings={settings} title="كشف حساب العائلة" />

        <div className="line"><span>العائلة</span><span style={{ fontWeight: 700 }}>{family.name}</span></div>
        <div className="line"><span>الضامن</span><span>{guarantor}</span></div>
        <div className="line"><span>التاريخ</span><span>{friendlyDateLong(today)}</span></div>
        <div className="rule" />

        <table className="items">
          <thead>
            <tr>
              <th>الفرد</th><th>رقم الملف</th><th>الصلة</th>
              {currencies.map((currency) => <th key={currency} className="num">{CURRENCY_LABEL[currency]}</th>)}
            </tr>
          </thead>
          <tbody>
            {family.members.length === 0 ? (
              <tr><td colSpan={3 + currencies.length}>لا أفراد في هذه العائلة</td></tr>
            ) : family.members.map((member) => (
              <tr key={member.id}>
                <td>{member.fullName}</td>
                <td dir="ltr">{member.patientNumber}</td>
                <td>{member.roleLabel}</td>
                {currencies.map((currency) => (
                  <td key={currency} className="num">
                    {balanceCell(member.balances?.find((line) => line.currency === currency)?.balanceMinor, currency)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>

        <div style={{ marginTop: "5mm" }}>
          {currencies.length === 0 ? (
            <div className="line line-strong"><span>المجموع</span><span>لا أرصدة قائمة</span></div>
          ) : currencies.map((currency) => {
            const total = totalOf(currency) ?? 0;
            return (
              <div className="line line-strong" key={currency}>
                <span>المجموع — {CURRENCY_LABEL[currency]}</span>
                <span className="num">{total === 0 ? "مسدّد" : total > 0 ? formatMoney(total, currency) : `للعائلة ${formatMoney(-total, currency)}`}</span>
              </div>
            );
          })}
        </div>

        <p className="footer-note" style={{ marginTop: "4mm" }}>
          كشفٌ للاطلاع: حساب كل فردٍ مستقل، والسداد يُسجَّل على حساب الفرد نفسه. كل عملةٍ بمجموعها — لا تحويل بين العملات.
        </p>

        <PrintFooter settings={settings} />
      </div>
    </>
  );
}
