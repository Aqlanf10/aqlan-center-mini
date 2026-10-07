import { notFound } from "next/navigation";
import { CLINIC_TIME_ZONE, commissionDetailReport, commissionReport, getParty, getSettingsSafe, type CommissionDetailLineView } from "@/lib/db";
import { resolveCommissionViewer } from "@/lib/commission-access";
import { mergeCommissionBalances } from "@/lib/commission-balance";
import { CURRENCIES, formatMoney, isCurrency, type Currency } from "@/lib/money";
import { RULE_SOURCE_LABEL } from "@/lib/commission";
import { SPECIALTY_LABEL } from "@/lib/cases";
import { friendlyDateLong } from "@/lib/reminders";
import { clinicDateString } from "@/lib/schedule";
import { PrintFooter, PrintHeader } from "@/components/PrintHeader";
import { PrintButton } from "@/components/PrintButton";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
/* بداية محايدة للرصيد التراكمي — كما في `/api/finance/commissions` حرفيًّا. */
const COMMISSION_BALANCE_EPOCH = "1970-01-01";
type SearchValue = string | string[] | undefined;

/* ورقة A4 أفقية مسمّاة: الأعمدة الإحدى عشرة لا تتّسع لورقةٍ رأسية بلا قصّ. والترويسة
   تتكرّر على كل صفحة (`report-table`)، والسطر لا ينقسم بين صفحتين، وكل صفحة مرقّمة
   «ن / المجموع» كما في ملف المريض. وعلى شاشة الهاتف يمرّر الكشف داخل نفسه بدل أن تتمرّر
   الصفحة كلها أفقيًّا. */
const STATEMENT_PRINT_STYLES = `
  .cs-sheet .cs-table td.num, .cs-sheet .cs-table th { white-space: nowrap; }
  .cs-sheet .cs-group-row td { text-align: right; }
  .cs-summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(70mm, 1fr)); gap: 3mm; margin-top: 3mm; }
  .cs-summary > section { border: 1px solid #aaa; padding: 2mm 3mm; break-inside: avoid; }
  .cs-summary h3 { font-size: 9pt; font-weight: 800; margin: 0 0 1mm; }
  @media screen and (max-width: 600px) {
    .cs-sheet { width: 100%; min-height: 0; overflow-x: auto; }
    .cs-sheet .cs-table { min-width: 270mm; }
    .cs-sheet .report-meta { grid-template-columns: minmax(0, 1fr); }
  }
  @media print {
    @page commission-statement {
      size: A4 landscape;
      margin: 8mm 8mm 14mm;
      @bottom-center {
        content: counter(page) " / " counter(pages);
        direction: ltr;
        font: 8pt Arial, sans-serif;
        color: #475569;
      }
    }
    .cs-sheet { page: commission-statement; }
  }
`;

interface Totals { amount: number; base: number; accrued: number; earned: number }
const emptyTotals = (): Totals => ({ amount: 0, base: 0, accrued: 0, earned: 0 });
function add(totals: Totals, line: CommissionDetailLineView): void {
  totals.amount += line.amountMinor;
  totals.base += line.baseMinor;
  totals.accrued += line.accruedMinor;
  totals.earned += line.earnedMinor;
}

/** مفتاح المجموعة من ربط المحرّك نفسه — حالة، وإلا خطة، وإلا «بلا ربط». لا ربط يُخترع. */
function groupKeyOf(line: CommissionDetailLineView): string {
  if (line.caseId !== null) return `case:${line.caseId}`;
  if (line.planId !== null) return `plan:${line.planId}`;
  return "none";
}

function groupLabelOf(line: CommissionDetailLineView): string {
  if (line.caseId !== null) {
    const specialty = line.caseSpecialty
      ? Object.hasOwn(SPECIALTY_LABEL, line.caseSpecialty)
        ? SPECIALTY_LABEL[line.caseSpecialty as keyof typeof SPECIALTY_LABEL]
        : line.caseSpecialty
      : null;
    return `الحالة: ${line.caseTitle ?? `#${line.caseId}`}${specialty ? ` — ${specialty}` : ""} · المريض: ${line.patientName}`;
  }
  if (line.planId !== null) return `خطة علاج بلا حالة: ${line.planTitle ?? `#${line.planId}`} · المريض: ${line.patientName}`;
  return "أعمال بلا حالة ولا خطة مربوطة";
}

/**
 * (COMM-DETAIL-1 · COMM-STMT) كشف عمولة طبيب للطباعة — حسب الحالة، سطرًا سطرًا من المحرّك نفسه.
 *
 * لا حساب هنا: كل رقمٍ في السطر من `commissionDetailReport`، ومجاميع الحالة والعملة جمعٌ
 * لتلك الأرقام نفسها، والمصروف ونتيجة الفترة والرصيد التراكمي من `commissionReport` مدموجًا
 * بـ`mergeCommissionBalances` كما تفعل شاشة العمولات. كل عملةٍ بمجاميعها — لا إجمالي يخلطها.
 *
 * الترويسة من الإعدادات. والطبيب الشخصيّ لا يطبع إلا كشفه؛ المدير والمحاسب لأي طبيب — ورقمٌ
 * ليس جهة طبيب لا يُطبع له كشفٌ فارغ بل 404.
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
  const doctor = await getParty(doctorId);
  if (!doctor || doctor.kind !== "doctor") notFound();

  const query = await searchParams;
  const pick = (key: string) => (typeof query[key] === "string" ? (query[key] as string) : "");
  const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
  const rawFrom = DATE_PATTERN.test(pick("from")) ? pick("from") : `${today.slice(0, 7)}-01`;
  const rawTo = DATE_PATTERN.test(pick("to")) ? pick("to") : today;
  const [from, to] = rawFrom <= rawTo ? [rawFrom, rawTo] : [rawTo, rawFrom];
  const currency: Currency | null = isCurrency(pick("currency")) ? (pick("currency") as Currency) : null;
  const specialty = /^[a-z_]{1,40}$/.test(pick("specialty")) ? pick("specialty") : null;

  const [report, cumulativeRows, settings] = await Promise.all([
    commissionDetailReport(from, to, { doctorId, currency, category: specialty }),
    /* المصروف والرصيد لا يقسّمهما المصدر حسب التخصص — فلا يُطلبان مع مرشّح التخصص. */
    specialty === null && from !== COMMISSION_BALANCE_EPOCH ? commissionReport(COMMISSION_BALANCE_EPOCH, to) : Promise.resolve(null),
    getSettingsSafe(),
  ]);
  const lines = report.lines;

  /* صفوف المحرّك لهذا الطبيب: الفترة مدموجةً برصيدها التراكمي حتى نهاية الكشف. */
  const accountRows = specialty === null
    ? mergeCommissionBalances(
      report.rows,
      (cumulativeRows ?? report.rows).filter((row) =>
        row.doctorId === doctorId && (currency === null || row.currency === currency)),
    ).filter((row) => row.doctorId === doctorId)
    : [];

  const groups: Array<{ key: string; label: string; lines: CommissionDetailLineView[] }> = [];
  for (const line of lines) {
    const key = groupKeyOf(line);
    let group = groups.find((entry) => entry.key === key);
    if (!group) {
      group = { key, label: groupLabelOf(line), lines: [] };
      groups.push(group);
    }
    group.lines.push(line);
  }

  const lineTotals = new Map<Currency, Totals>();
  for (const line of lines) {
    const total = lineTotals.get(line.currency) ?? emptyTotals();
    add(total, line);
    lineTotals.set(line.currency, total);
  }
  const shownCurrencies = CURRENCIES.filter((code) =>
    lineTotals.has(code) || accountRows.some((row) => row.currency === code));

  const generatedAt = new Intl.DateTimeFormat("ar-YE", {
    timeZone: CLINIC_TIME_ZONE, dateStyle: "medium", timeStyle: "short",
  }).format(new Date());
  const filterLabel = [
    currency ? `العملة: ${currency}` : null,
    specialty ? `التخصص: ${specialty === "none" ? "بلا تخصص" : specialty}` : null,
  ].filter(Boolean).join(" · ");

  return (
    <>
      <style>{STATEMENT_PRINT_STYLES}</style>
      <PrintButton />
      <div className="sheet sheet-report sheet-report-landscape cs-sheet" dir="rtl">
        <PrintHeader settings={settings} title="كشف عمولة طبيب حسب الحالة" />
        <div className="report-meta">
          <div className="line"><span>الطبيب المنفّذ</span><span style={{ fontWeight: 700 }}>{doctor.name}</span></div>
          <div className="line"><span>الفترة</span><span>{friendlyDateLong(from)} ← {friendlyDateLong(to)}</span></div>
          {filterLabel ? <div className="line"><span>المرشّحات</span><span>{filterLabel}</span></div> : null}
          <div className="line"><span>عدد الأعمال</span><span className="num">{lines.length}</span></div>
        </div>
        <table className="items report-table cs-table" data-statement-table>
          <thead>
            <tr>
              <th>التاريخ</th><th>المريض</th><th>الفاتورة</th><th>العمل المنفّذ</th>
              <th>قيمة العمل</th><th>خصم مختبر / مواد</th><th>أساس العمولة</th><th>النسبة ومصدرها</th>
              <th>على الفاتورة</th><th>تحصيل الفاتورة</th><th>المستحق على المحصّل</th>
            </tr>
          </thead>
          <tbody>
            {lines.length === 0 ? (
              <tr><td colSpan={11} className="report-empty" data-statement-empty>لا أعمال محسوبة لهذا الطبيب في هذه الفترة.</td></tr>
            ) : groups.flatMap((group) => {
              const subtotals = new Map<Currency, Totals>();
              for (const line of group.lines) {
                const total = subtotals.get(line.currency) ?? emptyTotals();
                add(total, line);
                subtotals.set(line.currency, total);
              }
              return [
                <tr key={`g-${group.key}`} className="report-group-row cs-group-row" data-case-group={group.key}>
                  <td colSpan={11}>{group.label}</td>
                </tr>,
                ...group.lines.map((line, index) => (
                  <tr
                    key={`${group.key}-${line.invoiceId}-${line.serviceId ?? line.serviceName}-${index}`}
                    data-statement-line
                    data-invoice={line.invoiceId}
                    data-invoice-number={line.invoiceNumber ?? `#${line.invoiceId}`}
                    data-currency={line.currency}
                    data-amount={line.amountMinor}
                    data-base={line.baseMinor}
                    data-accrued={line.accruedMinor}
                    data-earned={line.earnedMinor}
                  >
                    <td className="num">{line.clinicDate}</td>
                    <td>{line.patientName}</td>
                    <td className="num">{line.invoiceNumber ?? `#${line.invoiceId}`}</td>
                    <td>{line.serviceName ?? "—"}{line.categoryLabel ? ` · ${line.categoryLabel}` : ""}</td>
                    <td className="num">{formatMoney(line.amountMinor, line.currency)}</td>
                    <td className="num">
                      {line.labDeducted ? <div>مختبر {formatMoney(line.labCostMinor, line.currency)}</div> : null}
                      {line.materialDeducted ? <div>مواد {formatMoney(line.materialCostMinor, line.currency)}</div> : null}
                      {!line.labDeducted && !line.materialDeducted ? "—" : null}
                    </td>
                    <td className="num">{formatMoney(line.baseMinor, line.currency)}</td>
                    <td>{line.percent}٪ · {line.ruleSourceLabel}</td>
                    <td className="num">{formatMoney(line.accruedMinor, line.currency)}</td>
                    <td className="num">
                      {formatMoney(Math.min(line.invoiceCoveredMinor, line.invoiceNetMinor), line.currency)} من {formatMoney(line.invoiceNetMinor, line.currency)}
                    </td>
                    <td className="num" style={{ fontWeight: 700 }}>
                      {formatMoney(line.earnedMinor, line.currency)}
                      {line.basis === "invoiced" ? <div style={{ fontWeight: 400 }}>على المفوتر</div> : null}
                      {/* المستحق يُحسب بنسبة وقت كل دفعة: تُعرض النسب التي أنتجته حين تختلف عن نسبة الفاتورة. */}
                      {line.earnedParts.some((part) => part.percent !== line.percent) ? (
                        <div style={{ fontWeight: 400 }}>
                          {line.earnedParts.map((part, partIndex) => (
                            <div key={partIndex}>
                              {formatMoney(part.earnedMinor, line.currency)} بنسبة {part.percent}٪
                              {part.ruleSources.length ? ` (${part.ruleSources.map((source) => RULE_SOURCE_LABEL[source]).join("، ")})` : ""}
                            </div>
                          ))}
                        </div>
                      ) : null}
                    </td>
                  </tr>
                )),
                ...CURRENCIES.filter((code) => subtotals.has(code)).map((code) => {
                  const total = subtotals.get(code)!;
                  return (
                    <tr key={`s-${group.key}-${code}`} className="report-subtotal-row" data-case-subtotal={group.key}
                      data-currency={code} data-accrued={total.accrued} data-earned={total.earned}>
                      <td colSpan={4}>مجموع {group.key === "none" ? "الأعمال بلا ربط" : "الحالة"} ({code})</td>
                      <td className="num">{formatMoney(total.amount, code)}</td>
                      <td />
                      <td className="num">{formatMoney(total.base, code)}</td>
                      <td />
                      <td className="num">{formatMoney(total.accrued, code)}</td>
                      <td />
                      <td className="num">{formatMoney(total.earned, code)}</td>
                    </tr>
                  );
                }),
              ];
            })}
          </tbody>
        </table>

        <div className="cs-summary">
          {shownCurrencies.map((code) => {
            const total = lineTotals.get(code) ?? emptyTotals();
            const row = accountRows.find((entry) => entry.currency === code);
            const accrued = row?.accruedMinor ?? total.accrued;
            const earned = row?.earnedMinor ?? total.earned;
            return (
              <section key={code} data-currency-summary={code}
                data-accrued={accrued} data-earned={earned}
                {...(row ? {
                  "data-net-earned": row.netEarnedMinor, "data-paid": row.paidMinor,
                  "data-period-due": row.dueMinor, "data-balance": row.balanceMinor,
                } : {})}>
                <h3>ملخّص {code}</h3>
                <div className="line"><span>قيمة الأعمال المنسوبة للطبيب</span><span className="num">{formatMoney(total.amount, code)}</span></div>
                <div className="line"><span>أساس العمولة بعد الخصومات</span><span className="num">{formatMoney(total.base, code)}</span></div>
                <div className="line"><span>العمولة على الفواتير</span><span className="num">{formatMoney(accrued, code)}</span></div>
                <div className="line line-strong"><span>المستحق على المحصّل</span><span className="num">{formatMoney(earned, code)}</span></div>
                {row ? (
                  <>
                    {row.materialRateApplied ? (
                      <>
                        <div className="line"><span>خصم إهلاك المواد</span><span className="num">{formatMoney(row.materialRateCostMinor, code)}</span></div>
                        <div className="line"><span>صافي المستحق</span><span className="num">{formatMoney(row.netEarnedMinor, code)}</span></div>
                      </>
                    ) : null}
                    <div className="line" data-paid-row><span>المصروف له في الفترة (سندات صرف العمولة)</span><span className="num">{formatMoney(row.paidMinor, code)}</span></div>
                    <div className="line">
                      <span>نتيجة الفترة</span>
                      <span className="num">
                        {row.dueMinor > 0 ? `له ${formatMoney(row.dueMinor, code)}`
                          : row.dueMinor < 0 ? `زيادة مصروفة ${formatMoney(-row.dueMinor, code)}` : "لا شيء"}
                      </span>
                    </div>
                    <div className="line line-strong">
                      <span>
                        {row.balanceMinor > 0 ? `الرصيد التراكمي له حتى ${to}`
                          : row.balanceMinor < 0 ? `مديونية على الطبيب للمركز حتى ${to}` : `الرصيد التراكمي حتى ${to}`}
                      </span>
                      <span className="num">{row.balanceMinor === 0 ? "مسدّد" : formatMoney(Math.abs(row.balanceMinor), code)}</span>
                    </div>
                  </>
                ) : null}
              </section>
            );
          })}
        </div>
        {specialty !== null ? (
          <p className="footer-note" data-scope-note>
            مرشّح التخصص يحصر الأعمال ومجاميعها. أمّا المصروف للطبيب ونتيجة الفترة والرصيد فلا يقسّمها المصدر حسب التخصص،
            فلا تُعرض هنا — اطبع الكشف بلا تخصص لرؤيتها.
          </p>
        ) : null}
        <div className="report-notes">
          <ul>
            <li>قيمة العمل: حصة الطبيب من بند الفاتورة قبل أي خصم.</li>
            <li>أساس العمولة: قيمة العمل بعد خصم المختبر والمواد حسب سياسة الطبيب وقت الفاتورة.</li>
            <li>على الفاتورة: الأساس × نسبة وقت الفاتورة — ما يستحقه لو حُصّلت الفاتورة كاملة.</li>
            <li>المستحق على المحصّل: بقدر ما دُفع فعلًا من الفاتورة، وبنسبة وقت كل دفعة. «على المفوتر» حين تنصّ سياسة الطبيب على المفوتر.</li>
            <li>المصروف من سندات صرف العمولة في الفترة. كل عملة بمجاميعها، ولا تُجمع عملتان.</li>
          </ul>
        </div>
        <p className="footer-note">صدر في {generatedAt} — {session.username}</p>
        <div className="line" style={{ marginTop: "10mm" }}>
          <span>توقيع الطبيب ____________</span><span>المحاسب ____________</span><span>المدير ____________</span>
        </div>
        <PrintFooter settings={settings} />
      </div>
    </>
  );
}
