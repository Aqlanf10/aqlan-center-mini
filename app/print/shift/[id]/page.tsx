import { notFound } from "next/navigation";
import { CLINIC_TIME_ZONE, getSettingsSafe, getShift, shiftDrawerBreakdown } from "@/lib/db";
import { CURRENCIES, formatMoney, type Currency } from "@/lib/money";
import { friendlyDateLong, friendlyTime } from "@/lib/reminders";
import { clinicDateString } from "@/lib/schedule";
import { PrintHeader, PrintFooter } from "@/components/PrintHeader";
import { PrintButton } from "@/components/PrintButton";
import { canHandleMoney } from "@/lib/roles";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * (P1-3) تقرير إقفال الوردية (Z) — ورقة واحدة تُوقَّع وتُحفظ مع نقد اليوم.
 *
 * لكل عملة: الافتتاحي، المقبوض نقدًا، المردود نقدًا، سندات الصرف، المتوقَّع في الدرج،
 * المعدود، والفرق (عجز/زيادة) وسببه. والتحويلات تُعرض منفصلةً لأنها لا تدخل الدرج.
 * المتوقَّع هو المحفوظ لحظة الإقفال؛ وللورديات الأقدم من حفظه يُحسب بالقاعدة نفسها
 * ويُوسَم «محسوب».
 */
function clockOf(iso: string): { date: string; time: string } {
  const stamp = new Date(iso);
  const date = clinicDateString(stamp, CLINIC_TIME_ZONE);
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone: CLINIC_TIME_ZONE, hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(stamp);
  return { date: friendlyDateLong(date), time: friendlyTime(time) };
}

export default async function ShiftCloseReportPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session || !canHandleMoney(session.role)) notFound();

  const { id: rawId } = await params;
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) notFound();

  const [shift, settings] = await Promise.all([getShift(id), getSettingsSafe()]);
  if (!shift) notFound();
  const drawer = await shiftDrawerBreakdown(shift);
  const expected = shift.expected;
  const opened = clockOf(shift.openedAt);
  const closed = shift.closedAt ? clockOf(shift.closedAt) : null;
  const used = CURRENCIES.filter((currency) =>
    shift.opening[currency] !== 0 || drawer.cashIn[currency] !== 0 || drawer.cashRefunds[currency] !== 0
    || drawer.spent[currency] !== 0 || drawer.nonCashIn[currency] !== 0
    || (shift.counted?.[currency] ?? 0) !== 0 || expected[currency] !== 0);
  const currencies: Currency[] = used.length > 0 ? used : ["YER"];

  return (
    <>
      <PrintButton />
      <div className="sheet sheet-a5">
        <PrintHeader settings={settings} title={`تقرير إقفال الوردية (Z) — رقم ${shift.id}`} compact />

        <div className="line"><span>فُتحت</span><span>{opened.date} · {opened.time} — {shift.openedBy}</span></div>
        <div className="line">
          <span>أُقفلت</span>
          <span>{closed ? `${closed.date} · ${closed.time} — ${shift.closedBy ?? "—"}` : "مفتوحة — لم تُقفل بعد"}</span>
        </div>
        {shift.expectedSource === "computed" && shift.status === "closed" ? (
          <p className="footer-note">وردية أُقفلت قبل حفظ المتوقَّع: المتوقَّع والفرق محسوبان بالقاعدة نفسها.</p>
        ) : null}
        <div className="rule-light" />

        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "11px" }}>
          <thead>
            <tr>
              <th style={{ textAlign: "right" }}>البند</th>
              {currencies.map((currency) => <th key={currency} style={{ textAlign: "left" }}>{currency}</th>)}
            </tr>
          </thead>
          <tbody>
            {([
              ["الرصيد الافتتاحي", shift.opening],
              ["+ المقبوض نقدًا", drawer.cashIn],
              ["− المردود نقدًا", drawer.cashRefunds],
              ["− سندات الصرف", drawer.spent],
            ] as Array<[string, Record<Currency, number>]>).map(([label, values]) => (
              <tr key={label}>
                <td>{label}</td>
                {currencies.map((currency) => (
                  <td key={currency} style={{ textAlign: "left" }} dir="ltr">{formatMoney(values[currency], currency)}</td>
                ))}
              </tr>
            ))}
            <tr style={{ fontWeight: 700, borderTop: "1px solid #999" }}>
              <td>= المتوقَّع في الدرج</td>
              {currencies.map((currency) => (
                <td key={currency} style={{ textAlign: "left" }} dir="ltr">{formatMoney(expected[currency], currency)}</td>
              ))}
            </tr>
            <tr>
              <td>المعدود فعلًا</td>
              {currencies.map((currency) => (
                <td key={currency} style={{ textAlign: "left" }} dir="ltr">
                  {shift.counted ? formatMoney(shift.counted[currency], currency) : "—"}
                </td>
              ))}
            </tr>
            <tr style={{ fontWeight: 700 }}>
              <td>الفرق (المعدود − المتوقَّع)</td>
              {currencies.map((currency) => {
                const value = shift.difference?.[currency];
                return (
                  <td key={currency} style={{ textAlign: "left" }}>
                    {value === undefined || value === null ? "—"
                      : value === 0 ? "مطابق"
                        : `${value < 0 ? "عجز" : "زيادة"} ${formatMoney(Math.abs(value), currency)}`}
                  </td>
                );
              })}
            </tr>
            <tr>
              <td>تحويلات (خارج الدرج)</td>
              {currencies.map((currency) => (
                <td key={currency} style={{ textAlign: "left" }} dir="ltr">
                  {formatMoney(drawer.nonCashIn[currency] - drawer.nonCashRefunds[currency], currency)}
                </td>
              ))}
            </tr>
          </tbody>
        </table>

        {shift.differenceReason ? (
          <>
            <div className="rule-light" />
            <p className="footer-note">سبب الفرق: {shift.differenceReason}</p>
          </>
        ) : null}
        {shift.note ? <p className="footer-note">ملاحظة الإقفال: {shift.note}</p> : null}

        <div className="sign-row">
          <span>أمين الصندوق: ................</span>
          <span>المراجع: ................</span>
        </div>

        <PrintFooter settings={settings} />
      </div>
    </>
  );
}
