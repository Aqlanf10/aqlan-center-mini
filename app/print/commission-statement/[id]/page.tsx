import { notFound } from "next/navigation";
import { CLINIC_TIME_ZONE, commissionDetailReport, getSettingsSafe } from "@/lib/db";
import { resolveCommissionViewer } from "@/lib/commission-access";
import { CURRENCIES, formatMoney, isCurrency, type Currency } from "@/lib/money";
import { RULE_SOURCE_LABEL } from "@/lib/commission";
import { friendlyDateLong } from "@/lib/reminders";
import { clinicDateString } from "@/lib/schedule";
import { PrintFooter, PrintHeader } from "@/components/PrintHeader";
import { PrintButton } from "@/components/PrintButton";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
type SearchValue = string | string[] | undefined;

/**
 * (COMM-DETAIL-1) كشف عمولة طبيب للطباعة — سطرًا سطرًا من المحرّك نفسه.
 *
 * الترويسة من الإعدادات (اسم المركز والطبيب المسؤول وتخصصه ومؤهله) لا من الكود. والطبيب
 * الشخصيّ لا يطبع إلا كشفه؛ المدير والمحاسب لأي طبيب. كل عملةٍ بإجماليها — لا خلط.
 */
export default async function CommissionStatementPrintPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, SearchValue>>;
}) {
  const session = await requireSession();
  if (!session) notFound();
  const viewer = await resolveCommissionViewer(session);
  if (viewer.kind === "denied") notFound();

  const doctorId = Number((await params).id);
  if (!Number.isInteger(doctorId) || doctorId <= 0) notFound();
  if (viewer.kind === "own" && viewer.partyId !== doctorId) notFound();

  const query = await searchParams;
  const pick = (key: string) => (typeof query[key] === "string" ? (query[key] as string) : "");
  const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
  const rawFrom = DATE_PATTERN.test(pick("from")) ? pick("from") : `${today.slice(0, 7)}-01`;
  const rawTo = DATE_PATTERN.test(pick("to")) ? pick("to") : today;
  const [from, to] = rawFrom <= rawTo ? [rawFrom, rawTo] : [rawTo, rawFrom];
  const currency: Currency | null = isCurrency(pick("currency")) ? (pick("currency") as Currency) : null;
  const specialty = /^[a-z_]{1,40}$/.test(pick("specialty")) ? pick("specialty") : null;

  const [report, settings] = await Promise.all([
    commissionDetailReport(from, to, { doctorId, currency, category: specialty }),
    getSettingsSafe(),
  ]);
  const doctorName = report.lines[0]?.doctorName ?? report.rows[0]?.doctorName ?? `#${doctorId}`;
  const totals = new Map<Currency, { accrued: number; earned: number; lab: number; material: number }>();
  for (const line of report.lines) {
    const total = totals.get(line.currency) ?? { accrued: 0, earned: 0, lab: 0, material: 0 };
    total.accrued += line.accruedMinor;
    total.earned += line.earnedMinor;
    if (line.labDeducted) total.lab += line.labCostMinor;
    if (line.materialDeducted) total.material += line.materialCostMinor;
    totals.set(line.currency, total);
  }
  /* عملةٌ صُرف فيها للطبيب في الفترة بلا عملٍ محسوب تظهر أيضًا — بصفرٍ على الفواتير ومصروفها كما هو. */
  const doctorRows = report.rows.filter((entry) => entry.doctorId === doctorId);
  const shownCurrencies = CURRENCIES.filter((code) => totals.has(code) || doctorRows.some((entry) => entry.currency === code));
  const generatedAt = new Intl.DateTimeFormat("ar-YE", {
    timeZone: CLINIC_TIME_ZONE, dateStyle: "medium", timeStyle: "short",
  }).format(new Date());

  return (
    <>
      <PrintButton />
      <div className="sheet sheet-a4" dir="rtl">
        <PrintHeader settings={settings} title="كشف عمولة طبيب" />
        <div className="line"><span>الطبيب</span><span style={{ fontWeight: 700 }}>{doctorName}</span></div>
        <div className="line"><span>الفترة</span><span>{friendlyDateLong(from)} ← {friendlyDateLong(to)}</span></div>
        <div className="rule" />
        <table className="items">
          <thead>
            <tr>
              <th>التاريخ</th><th>المريض</th><th>الفاتورة</th><th>الخدمة</th><th>التخصص / الحالة</th>
              <th>الحصة</th><th>مختبر</th><th>مواد</th><th>نسبة الفاتورة</th><th>مصدرها</th><th>على الفاتورة</th><th>المستحق (ونسبته)</th>
            </tr>
          </thead>
          <tbody>
            {report.lines.length === 0 ? (
              <tr><td colSpan={12} style={{ textAlign: "center" }}>لا أعمال محسوبة في هذه الفترة.</td></tr>
            ) : report.lines.map((line) => (
              <tr key={`${line.invoiceId}-${line.serviceId ?? line.serviceName}-${line.caseId ?? ""}-${line.planId ?? ""}`}>
                <td className="num">{line.clinicDate}</td>
                <td>{line.patientName}</td>
                <td className="num">{line.invoiceNumber ?? `#${line.invoiceId}`}</td>
                <td>{line.serviceName ?? "—"}</td>
                <td>{[line.categoryLabel, line.caseTitle ?? line.planTitle].filter(Boolean).join(" · ") || "—"}</td>
                <td className="num">{formatMoney(line.amountMinor, line.currency)}</td>
                <td className="num">{line.labDeducted ? formatMoney(line.labCostMinor, line.currency) : "—"}</td>
                <td className="num">{line.materialDeducted ? formatMoney(line.materialCostMinor, line.currency) : "—"}</td>
                <td className="num">{line.percent}٪</td>
                <td>{line.ruleSourceLabel}</td>
                <td className="num">{formatMoney(line.accruedMinor, line.currency)}</td>
                <td className="num">
                  {formatMoney(line.earnedMinor, line.currency)}
                  {/* المستحق يُحسب بنسبة وقت كل دفعة: تُعرض النسب التي أنتجته فعلًا حين تختلف عن نسبة الفاتورة. */}
                  {line.earnedParts.some((part) => part.percent !== line.percent) ? (
                    <div style={{ fontSize: "8pt" }}>
                      {line.earnedParts.map((part, index) => (
                        <div key={index}>
                          {formatMoney(part.earnedMinor, line.currency)} بنسبة {part.percent}٪
                          {part.ruleSources.length ? ` (${part.ruleSources.map((source) => RULE_SOURCE_LABEL[source]).join("، ")})` : ""}
                        </div>
                      ))}
                    </div>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="rule" />
        {shownCurrencies.map((code) => {
          const total = totals.get(code) ?? { accrued: 0, earned: 0, lab: 0, material: 0 };
          const row = doctorRows.find((entry) => entry.currency === code);
          return (
            <div key={code}>
              <div className="line"><span>الإجمالي على الفواتير ({code})</span><span className="num">{formatMoney(total.accrued, code)}</span></div>
              <div className="line"><span>المستحق على المحصّل ({code})</span><span className="num" style={{ fontWeight: 700 }}>{formatMoney(total.earned, code)}</span></div>
              {row ? (
                <div className="line"><span>المصروف له في الفترة ({code})</span><span className="num">{formatMoney(row.paidMinor, code)}</span></div>
              ) : null}
            </div>
          );
        })}
        <p className="footer-note">
          المستحق يُحسب على المحصّل الفعلي بنسبة وقت كل دفعة، بعد خصم المختبر والمواد حيث تنصّ سياسة الطبيب.
          صدر في {generatedAt} — {session.username}
        </p>
        <div className="line" style={{ marginTop: "12mm" }}>
          <span>توقيع الطبيب ____________</span><span>المحاسب ____________</span><span>المدير ____________</span>
        </div>
        <PrintFooter settings={settings} />
      </div>
    </>
  );
}
