"use client";

import { Fragment, useEffect, useState, type ReactNode } from "react";
import { PageHeader } from "@/components/PageHeader";
import { useClinicName } from "@/components/SettingsProvider";
import { useSession } from "@/components/SessionProvider";
import { CURRENCIES, formatAmount, isCurrency, type Currency } from "@/lib/money";
import { clinicDateString } from "@/lib/schedule";
import { isDailyClinicReportDate } from "@/lib/daily-clinic-report-model";
import type { DailyClinicReport, DailyClinicReceipt, DailyCurrencyAmounts } from "@/lib/daily-clinic-report-types";
import type { DailyClinicExpenseRecipient } from "@/lib/daily-clinic-expense-report";
import styles from "./daily-clinic-report.module.css";

const TITLE = "كشف إقفال اليوم السريري والمالي";
const LOAD_ERROR = "تعذّر إعداد كشف إقفال اليوم. أعد المحاولة.";
const CURRENCY_NAME: Record<Currency, string> = { YER: "يمني", SAR: "سعودي", USD: "دولار" };
type PrintScope = "summary" | "full";

function Money({ minor, currency }: { minor: number | null; currency: Currency | null }) {
  if (minor === null || !Number.isSafeInteger(minor) || !isCurrency(currency)) {
    return <span className={styles.unknown}>غير معلوم</span>;
  }
  return <bdi className={styles.amount} dir="ltr" data-minor={minor} data-currency={currency}>{formatAmount(minor, currency)}</bdi>;
}

function AmountCells({ amounts }: { amounts: DailyCurrencyAmounts }) {
  return <>{CURRENCIES.map((currency) => <td key={currency}><Money minor={amounts[currency]} currency={currency} /></td>)}</>;
}

function CurrencyHeaders({ prefix }: { prefix: string }) {
  return <>{CURRENCIES.map((currency) => <th key={currency} scope="col" aria-label={`${prefix} ${CURRENCY_NAME[currency]} ${currency}`}>
    {CURRENCY_NAME[currency]}<small><bdi>{currency}</bdi></small>
  </th>)}</>;
}

function Timestamp({ value, zone }: { value: string; zone: string }) {
  const instant = new Date(value);
  const label = Number.isFinite(instant.getTime())
    ? new Intl.DateTimeFormat("ar-YE-u-ca-gregory-nu-latn", {
      timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
    }).format(instant) : "وقت غير معلوم";
  return <time dateTime={value} dir="auto">{label}</time>;
}

function TablePanel({ title, note, children, id, className = "" }: { title: string; note?: string; children: ReactNode; id: string; className?: string }) {
  return <section className={`${styles.section} ${className}`} aria-labelledby={`${id}-heading`}>
    <h2 id={`${id}-heading`}>{title}</h2>
    {note ? <p className={styles.note}>{note}</p> : null}
    <div className={styles.tableScroll} tabIndex={0} role="region" aria-label={title}>{children}</div>
  </section>;
}

function SummaryRow({ label, amounts }: { label: string; amounts: DailyCurrencyAmounts }) {
  return <tr><th scope="row">{label}</th><AmountCells amounts={amounts} /></tr>;
}

function PatientIdentity({ patientNumber, patientId }: { patientNumber?: string | null; patientId?: number | null }) {
  if (patientNumber?.trim()) return <small data-patient-number={patientNumber}><bdi dir="ltr">{patientNumber}</bdi></small>;
  if (patientId !== null && patientId !== undefined) return <small data-patient-reference={patientId}>مرجع المريض الداخلي: <bdi dir="ltr">#{patientId}</bdi></small>;
  return patientId === null ? <small>زائر بلا ملف مرتبط</small> : null;
}

function Recipient({ recipient }: { recipient: DailyClinicExpenseRecipient }) {
  return <>
    <strong>{recipient.displayName}</strong>
    <small>{recipient.partyId !== null ? <>جهة مرتبطة <bdi dir="ltr" data-recipient-party-id={recipient.partyId}>#{recipient.partyId}</bdi></> : recipient.nameSource === "recorded_text" ? "اسم نصّي مسجّل؛ الهوية غير موثّقة" : "المستفيد غير معلوم"}</small>
    {recipient.recordedPayeeText && recipient.partyId !== null ? <small>المستفيد كما سُجّل: {recipient.recordedPayeeText}</small> : null}
  </>;
}

/** Receipt display requires an explicit document/opening target. Canonical
 * unallocated account fallback is not evidence of an agreed target currency. */
function ReceiptSettlement({ receipt }: { receipt: DailyClinicReceipt }) {
  const explicitTarget = receipt.invoiceId !== null || receipt.planId !== null || receipt.openingCurrency !== null;
  if (!explicitTarget) return <span>غير معلوم: لا يوجد هدف تسوية محدد</span>;
  // The stored rate is YER per tender unit. It describes the target conversion
  // only for a differing tender settled into an explicitly linked YER target.
  const recordedTargetConversion = receipt.tenderCurrency !== receipt.settlementCurrency && receipt.settlementCurrency === "YER";
  return <>
    <Money minor={receipt.signedSettlementMinor} currency={receipt.settlementCurrency} /><small><bdi>{receipt.settlementCurrency}</bdi></small>
    {recordedTargetConversion ? <small data-receipt-conversion>سعر الصرف المسجّل للهدف: <bdi dir="ltr">1 {receipt.tenderCurrency} = {receipt.exchangeRate} YER</bdi></small> : null}
  </>;
}

function ReceiptTable({ receipts, zone, title, id }: { receipts: DailyClinicReceipt[]; zone: string; title: string; id: string }) {
  return <TablePanel id={id} title={title} note="حركات مسجّلة في اليوم المحدد. التحويل يظهر فقط لهدف مالي صريح بعملة مختلفة؛ الحركة العكسية قد تكون تصحيح تسجيل وليست إثبات رد نقدي.">
    <table className={`${styles.detailsTable} ${styles.receiptTable}`} data-testid={id}>
      <thead><tr><th scope="col">السند / الوقت</th><th scope="col">المريض</th><th scope="col">الحركة / الوسيلة</th><th scope="col">المبلغ الأصلي</th><th scope="col">الهدف المسجّل</th><th scope="col">تسوية الهدف الصريح</th></tr></thead>
      <tbody>{receipts.length === 0 ? <tr><td colSpan={6}>لا توجد حركات مسجّلة لهذه الفئة في اليوم المحدد.</td></tr> : receipts.map((receipt) => <tr key={receipt.id} data-receipt-id={receipt.id}>
        <th scope="row"><bdi dir="ltr" className={styles.documentNumber}>{receipt.receiptNumber}</bdi><small className={styles.referenceOnly}>#{receipt.id}</small><small><Timestamp value={receipt.at} zone={zone} /></small></th>
        <td>{receipt.patientName}<PatientIdentity patientId={receipt.patientId} /></td>
        <td>{receipt.kind === "refund" ? "حركة عكسية / تصحيح مسجّل" : "تحصيل مسجّل"}<small>{receipt.method === "cash" ? "نقد" : receipt.method === "transfer" ? "تحويل" : receipt.method}</small>{receipt.reversalOfId !== null ? <small>عكس السند<span className={styles.referenceOnly}> #{receipt.reversalOfId}</span></small> : null}</td>
        <td><Money minor={receipt.kind === "refund" ? -receipt.tenderMinor : receipt.tenderMinor} currency={receipt.tenderCurrency} /><small><bdi>{receipt.tenderCurrency}</bdi></small></td>
        <td>{receipt.invoiceId !== null ? <small>فاتورة<span className={styles.referenceOnly}> #{receipt.invoiceId}</span></small> : null}{receipt.planId !== null ? <small>خطة<span className={styles.referenceOnly}> #{receipt.planId}</span></small> : null}{receipt.openingCurrency !== null ? <small>رصيد افتتاحي {receipt.openingCurrency}</small> : null}{receipt.invoiceId === null && receipt.planId === null && receipt.openingCurrency === null ? "غير مربوط بوثيقة محددة" : null}</td>
        <td data-receipt-settlement><ReceiptSettlement receipt={receipt} /></td>
      </tr>)}</tbody>
    </table>
  </TablePanel>;
}

/** All records remain on screen. Print scope only separates reference detail
 * from the complete day activity; money is never recomputed. */
export function DailyClinicReportBody({ report, clinicName, printScope = "summary" }: { report: DailyClinicReport; clinicName: string; printScope?: PrintScope }) {
  const { totals, expenses, clinicTimeZone: zone } = report;
  const attendeeByKey = new Map(report.attendees.map((patient) => [patient.key, patient] as const));
  const patientNumberById = new Map(report.attendees.flatMap((patient) => patient.patientId === null ? [] : [[patient.patientId, patient.patientNumber] as const]));
  // Presentation selection only: never recalculate a balance or round money.
  // The grouped A4 layout reserves width for up to fourteen formatted glyphs.
  const needsCurrencyPanels = [
    totals.agreement, totals.explicitlySettled, totals.agreementRemaining,
    expenses.totals.outflowMinor, expenses.totals.reversalMinor, expenses.totals.netOutflowMinor,
    ...report.attendees.flatMap((row) => [row.agreement, row.explicitlySettled, row.agreementRemaining]),
    ...expenses.recipientTotals.flatMap((row) => [row.totals.outflowMinor, row.totals.reversalMinor, row.totals.netOutflowMinor]),
  ].some((amounts) => CURRENCIES.some((currency) => formatAmount(amounts[currency], currency).length > 14));
  return <div data-testid="daily-clinic-result" data-report-date={report.date} data-print-scope={printScope} className={styles.result}>
    <header className={styles.paperHeading}>
      <p className={styles.clinicName}>{clinicName}</p>
      <h2>{TITLE}</h2>
      <p>يوم الحضور: <bdi data-testid="daily-clinic-result-date">{report.date}</bdi> · توقيت العيادة: <bdi>{zone}</bdi></p>
      <p>أُعد في: <Timestamp value={report.generatedAt} zone={zone} /></p>
      <p data-testid="daily-clinic-print-scope">نطاق الطباعة: {printScope === "full" ? "كشف اليوم مع ملحق المراجع الكامل" : "ملخص كشف اليوم: جميع المراجعين والأعمال والتحصيل والصرف والإجماليات؛ دون ملحق تفاصيل الاتفاقات والحسابات"}</p>
    </header>
    <div className={styles.basis} data-testid="daily-clinic-basis">
      <strong>الحضور والأعمال: اليوم المختار. الاتفاقات والأرصدة: حالتها الحالية عند إعداد الكشف.</strong>
      <p>المريض مرة واحدة ولو تعددت زياراته. التوثيق المعتمد قبل <Timestamp value={report.selectedDayCutoff} zone={zone} /> (الحد غير مشمول). الأرصدة ليست لقطة تاريخية؛ المتبقي بعد السداد المربوط يختلف عن مديونية المريض. الدفعات غير المربوطة لا تُنسب إلى اتفاق. تفاصيل الاتفاقات وحسابات المراجعين ومراجع الدفعات في ملحق المراجع عند اختيار الطباعة الكاملة؛ المديونية والرصيد الدائن الحاليان ضمن إجماليات هذا الكشف.</p>
    </div>
    <dl className={styles.counts} aria-label="أعداد الحضور والتوثيق">
      {[
        ["المراجعون دون تكرار", totals.attendeesCount], ["الزيارات", totals.visitsCount],
        ["زيارات موثّقة قبل الحد", totals.signedVisitsCount], ["زيارات تنتظر التوقيع", totals.pendingVisitsCount],
        ["زيارات وُثّقت بعد الحد", totals.lateSignedVisitsCount], ["سطور توثيق بلا قيمة مستقلة", totals.unvaluedWorkCount],
      ].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
    </dl>

    <TablePanel id="daily-clinic-attendees" className={needsCurrencyPanels ? styles.groupedCurrencyPrintHidden : undefined} title="المراجعون واتفاقات العمل المرتبطة" note="كل صف مراجع واحد. الإجماليات الحالية تخص الاتفاقات الموثّقة المرتبطة بعمل اليوم فقط. الخطة المستبعدة أو القيمة غير المعروفة لا تتحول إلى اتفاق بقيمة صفر. المبالغ بثلاث عملات مستقلة.">
      <table className={styles.attendeeTable} data-testid="daily-clinic-attendees">
        <colgroup><col className={styles.patientColumn} /><col className={styles.workColumn} />{Array.from({ length: 9 }, (_, i) => <col key={i} />)}</colgroup>
        <thead>
          <tr><th scope="col" rowSpan={2}>المراجع</th><th scope="col" rowSpan={2}>الزيارات / العمل</th><th scope="colgroup" colSpan={3}>الاتفاق المرتبط بعمل اليوم</th><th scope="colgroup" colSpan={3}>المسدّد المربوط بالاتفاق حتى الآن</th><th scope="colgroup" colSpan={3}>المتبقي بعد السداد المربوط</th></tr>
          <tr><CurrencyHeaders prefix="الاتفاق" /><CurrencyHeaders prefix="المسدّد" /><CurrencyHeaders prefix="المتبقي" /></tr>
        </thead>
        <tbody>{report.attendees.length === 0 ? <tr><td colSpan={11}>لم يُسجّل حضور في هذا اليوم. حركات الصندوق وسندات الصرف، إن وجدت، تظهر منفصلة أدناه.</td></tr> : report.attendees.map((patient) => <tr key={patient.key} data-patient-key={patient.key}>
          <th scope="row">{patient.patientName}<PatientIdentity patientNumber={patient.patientNumber} patientId={patient.patientId} />{patient.agreementIds.length === 0 ? <small>لا اتفاق موثّق مرتبط؛ الأصفار لا تعني أن حساب المريض بلا دين.</small> : null}</th>
          <td>{patient.workSummary || "لا عمل موقّع موثّق قبل حد اليوم"}<small className={styles.referenceOnly}>{patient.visitsCount} زيارة · {patient.signedVisitsCount} موقّعة · {patient.pendingVisitsCount} بانتظار التوقيع</small>{patient.pendingVisitsCount > 0 ? <small className={styles.unknown} data-pending-patient={patient.key}>زيارات بانتظار التوقيع: {patient.pendingVisitsCount}</small> : null}{patient.lateSignedVisitsCount > 0 ? <small className={styles.unknown}>توثيق بعد الحد: {patient.lateSignedVisitsCount}</small> : null}{patient.excludedAgreementCount > 0 ? <small className={styles.unknown}>اتفاقات مستبعدة: {patient.excludedAgreementCount}؛ التفاصيل في الملحق الكامل</small> : null}<small className={styles.referenceOnly}>مراجع الزيارات: {patient.visitIds.join("، ")}</small></td>
          <AmountCells amounts={patient.agreement} /><AmountCells amounts={patient.explicitlySettled} /><AmountCells amounts={patient.agreementRemaining} />
        </tr>)}</tbody>
        <tfoot><tr data-testid="daily-clinic-attendee-totals"><th scope="row" colSpan={2}>إجمالي الاتفاقات المعتمدة دون تكرار</th><AmountCells amounts={totals.agreement} /><AmountCells amounts={totals.explicitlySettled} /><AmountCells amounts={totals.agreementRemaining} /></tr></tfoot>
      </table>
    </TablePanel>

    {needsCurrencyPanels ? <section className={`${styles.section} ${styles.currencyPrintAppendix}`} data-testid="daily-clinic-currency-panels">
      <h2>اتفاقات المراجعين: تفصيل الطباعة حسب العملة</h2>
      <p className={styles.note}>الأرقام الطويلة تُطبع كاملة في لوحات مستقلة لكل عملة، بالقيم نفسها دون اختصار أو تصغير مفرط.</p>
      {CURRENCIES.map((currency) => <div className={styles.currencyPanel} key={currency}>
        <h3>{CURRENCY_NAME[currency]} · <bdi>{currency}</bdi></h3>
        <table data-panel-currency={currency}><thead><tr><th scope="col">المراجع / العمل</th><th scope="col">الاتفاق <bdi>{currency}</bdi></th><th scope="col">المسدّد المربوط <bdi>{currency}</bdi></th><th scope="col">المتبقي بعد السداد المربوط <bdi>{currency}</bdi></th></tr></thead>
          <tbody>{report.attendees.map((patient) => <tr key={patient.key}><th scope="row">{patient.patientName}<PatientIdentity patientNumber={patient.patientNumber} patientId={patient.patientId} /><small>{patient.workSummary || "لا عمل موقّع موثّق قبل حد اليوم"}</small><small className={styles.referenceOnly}>{patient.visitsCount} زيارة · {patient.signedVisitsCount} موقّعة · {patient.pendingVisitsCount} بانتظار التوقيع</small>{patient.pendingVisitsCount > 0 ? <small className={styles.unknown} data-pending-patient={patient.key}>زيارات بانتظار التوقيع: {patient.pendingVisitsCount}</small> : null}<small>توثيق بعد الحد: {patient.lateSignedVisitsCount} · اتفاقات مستبعدة: {patient.excludedAgreementCount}</small><small className={styles.referenceOnly}>مراجع الزيارات: {patient.visitIds.join("، ")}</small>{patient.agreementIds.length === 0 ? <small>لا اتفاق موثّق مرتبط؛ الأصفار لا تعني أن حساب المريض بلا دين.</small> : null}</th>
            <td><Money minor={patient.agreement[currency]} currency={currency} /></td><td><Money minor={patient.explicitlySettled[currency]} currency={currency} /></td><td><Money minor={patient.agreementRemaining[currency]} currency={currency} /></td></tr>)}</tbody>
          <tfoot><tr><th scope="row">الإجمالي دون تكرار</th><td><Money minor={totals.agreement[currency]} currency={currency} /></td><td><Money minor={totals.explicitlySettled[currency]} currency={currency} /></td><td><Money minor={totals.agreementRemaining[currency]} currency={currency} /></td></tr></tfoot>
        </table>
      </div>)}
    </section> : null}

    <TablePanel id="daily-clinic-account-position" title="موقف حساب كل مراجع الآن: المديونية والرصيد الدائن" note="أرصدة الحساب الحالية عند إعداد الكشف، وتشمل تاريخ الحساب كله والدفعات غير المربوطة. مديونية الحساب تختلف عن المتبقي بعد السداد المربوط بالاتفاق. المديونية والرصيد الدائن معروضان منفصلين لكل عملة، دون مقاصة بينهما أو بين العملات. تفاصيل الافتتاحي والفواتير والتسويات في الملحق الكامل.">
      <table className={styles.accountPositionTable} data-testid="daily-clinic-account-position">
        <thead>
          <tr><th scope="col" rowSpan={2}>المراجع</th><th scope="colgroup" colSpan={3}>مديونية الحساب الآن</th><th scope="colgroup" colSpan={3}>الرصيد الدائن الآن</th></tr>
          <tr><CurrencyHeaders prefix="مديونية الحساب الحالية" /><CurrencyHeaders prefix="الرصيد الدائن الحالي" /></tr>
        </thead>
        <tbody>{report.currentAccounts.length === 0 ? <tr><td colSpan={7}>لا حسابات مرضى مرتبطة بالحضور. الزائر بلا ملف مرتبط لا يُفترض أن رصيده صفر.</td></tr> : report.currentAccounts.map((account) => <tr key={account.patientId} data-account-patient={account.patientId}>
          <th scope="row">{account.patientName}<PatientIdentity patientNumber={patientNumberById.get(account.patientId)} patientId={account.patientId} /></th>
          {CURRENCIES.map((currency) => <td key={`receivable-${currency}`}><Money minor={account.byCurrency[currency].receivableMinor} currency={currency} /></td>)}
          {CURRENCIES.map((currency) => <td key={`credit-${currency}`}><Money minor={account.byCurrency[currency].creditMinor} currency={currency} /></td>)}
        </tr>)}</tbody>
        <tfoot><tr><th scope="row">إجمالي الحسابات دون تكرار</th><AmountCells amounts={totals.currentReceivable} /><AmountCells amounts={totals.currentCredit} /></tr></tfoot>
      </table>
    </TablePanel>

    <TablePanel id="daily-clinic-work" title="السجلات الحالية للأعمال الموقّعة قبل حد اليوم" note="القيمة المعروفة هي سعر الإجراء المسجّل قبل خصومات الفاتورة، أو قيمة بند خطة مكتمل بسعره المسجّل. ليست إيرادًا صافيًا أو إثبات تحصيل. الجلسة المشمولة بلا قيمة قابلة للتقييم تظهر كمجهولة، ولا يوزع مبلغ الاتفاق عليها تخمينيًا. قد يوثّق الإجراء وسجل التخصص العمل نفسه؛ هذه سطور أدلة لا عدد إجراءات مستقلًا، وأسماؤها وروابطها حالية وليست لقطة تاريخية.">
      <table className={styles.detailsTable} data-testid="daily-clinic-work"><thead><tr><th scope="col">المراجع / الزيارة</th><th scope="col">العمل / الكمية</th><th scope="col">المنفّذ / السن</th><th scope="col">التوثيق / المصدر</th><th scope="col">الارتباط / التصنيف</th><th scope="col">القيمة / أساسها</th></tr></thead>
        <tbody>{report.work.length === 0 ? <tr><td colSpan={6}>لا أعمال موقّعة مؤهلة قبل حد اليوم. الزيارات المعلّقة والتوثيق المتأخر موضّحان في جدول الحضور.</td></tr> : report.work.map((work) => <tr key={work.key} data-work-key={work.key}>
          <th scope="row">{work.patientName}<PatientIdentity patientNumber={attendeeByKey.get(work.patientKey)?.patientNumber} patientId={attendeeByKey.get(work.patientKey)?.patientId} /><small className={styles.referenceOnly}>زيارة #{work.visitId}</small></th><td>{work.description}<small>الكمية: {work.quantity}</small></td><td>{work.doctorName ?? "المنفّذ غير مسجّل"}<small>السن: {work.toothCode ?? "غير محدد"}</small></td>
          <td><Timestamp value={work.signedAt} zone={zone} /><small>{({ procedure: "إجراء", ortho_adjustment: "جلسة تقويم", endo_visit: "جلسة عصب", clinical_note: "توثيق العمل" })[work.sourceType]}<span className={styles.referenceOnly}> #{work.sourceId}</span></small></td>
          <td>{work.agreementId === null ? "بلا اتفاق موثّق مرتبط" : <>اتفاق<span className={styles.referenceOnly}> #{work.agreementId}</span></>}<small>{({ included: "جلسة مشمولة بالاتفاق", recorded_charge: "سعر إجراء مسجّل", documented_unpriced: "عمل موثّق؛ أساس القيمة موضّح" })[work.classification]}</small></td>
          <td>{work.valuationBasis === "included_in_completed_item" ? <span>محتسبة ضمن البند</span> : <Money minor={work.valueMinor} currency={work.currency} />}{work.currency ? <small><bdi>{work.currency}</bdi></small> : null}<small>{work.valuationBasis === "recorded_procedure_price" ? "سعر الإجراء قبل خصومات الفاتورة" : work.valuationBasis === "completed_plan_item" ? "القيمة المسجّلة لبند خطة مكتمل" : work.valuationBasis === "included_in_completed_item" ? "لا تكرر قيمة البند" : "لا أساس تسعير معتمد"}</small>{work.unvaluedReason ? <small className={styles.unknown}>{work.unvaluedReason}</small> : null}</td>
        </tr>)}</tbody>
      </table>
    </TablePanel>

    <ReceiptTable id="daily-clinic-attendee-receipts" title="حركات تحصيل اليوم للمراجعين الحاضرين" receipts={report.receipts.filter((receipt) => receipt.attendee)} zone={zone} />
    <ReceiptTable id="daily-clinic-other-receipts" title="حركات تحصيل اليوم لغير الحاضرين" receipts={report.receipts.filter((receipt) => !receipt.attendee)} zone={zone} />

    <TablePanel id="daily-clinic-expenses" title="سندات الصرف والمستفيد المسجّل" note="نطاق هذا القسم سندات صرف العيادة المسجّلة في اليوم. لا يمثل مصروفات الاستحقاق أو كل حركة نقدية. تسويات الذمم تفصيل للسند نفسه ولا تُضاف إلى مبلغ السند مرة ثانية.">
      <table className={styles.detailsTable} data-testid="daily-clinic-expenses"><thead><tr><th scope="col">السند / الوقت</th><th scope="col">المستفيد</th><th scope="col">التصنيف / الحركة</th><th scope="col">المبلغ الأصلي</th><th scope="col">الغرض / تسوية الذمم</th><th scope="col">مرجع العكس</th></tr></thead>
        <tbody>{expenses.movements.length === 0 ? <tr><td colSpan={6}>لا سندات صرف مسجّلة في اليوم المحدد.</td></tr> : expenses.movements.map((movement) => <tr key={movement.id} data-expense-id={movement.id}>
          <th scope="row"><bdi dir="ltr" className={styles.documentNumber}>{movement.voucherNumber}</bdi><small><span className={styles.referenceOnly}>#{movement.id} · </span><Timestamp value={movement.createdAt} zone={zone} /></small></th><td><Recipient recipient={movement.recipient} /></td>
          <td>{movement.categoryLabel}<small>{({ outflow: "صرف مسجّل", reversal: "عكس سند", negative_adjustment: "تعديل سالب مسجّل", zero: "حركة صفرية مسجّلة" })[movement.kind]}</small></td>
          <td><Money minor={movement.amountMinor} currency={movement.currency} /><small><bdi>{movement.currency}</bdi></small></td>
          <td>{movement.note ? <p>{movement.note}</p> : null}{movement.payableId !== null ? <small>ذمة<span className={styles.referenceOnly}> #{movement.payableId}</span> · {movement.payableSourceType === "opening" ? "افتتاحية" : movement.payableSourceType === "operational" ? "تشغيلية" : "الغرض غير معلوم"}</small> : null}{movement.allocations.map((allocation) => <small key={allocation.payableId}>ذمة<span className={styles.referenceOnly}> #{allocation.payableId}</span> ({allocation.sourceType === "opening" ? "افتتاحية" : allocation.sourceType === "operational" ? "تشغيلية" : "نوع غير معلوم"}): <Money minor={allocation.paidMinor} currency={movement.currency} /> {movement.currency}؛ تسوية <Money minor={allocation.settledMinor} currency={allocation.payableCurrency} /> {allocation.payableCurrency}</small>)}{movement.payableId === null && movement.allocations.length === 0 ? <small>لا ذمة محددة مرتبطة</small> : null}{movement.unallocatedMinor !== null ? <small>المتبقي غير الموزع من السند: <Money minor={movement.unallocatedMinor} currency={movement.currency} /> {movement.currency}</small> : null}</td>
          <td>{movement.reversalOfId !== null ? <><bdi dir="ltr" className={styles.documentNumber}>{movement.originalVoucherNumber ?? "السند"}</bdi><span className={styles.referenceOnly}> #{movement.reversalOfId}</span></> : "لا يوجد"}</td>
        </tr>)}</tbody>
      </table>
    </TablePanel>
    {expenses.caveats.length ? <aside className={styles.warning}><h3>حدود قراءة سندات الصرف</h3><ul>{expenses.caveats.map((caveat, index) => <li key={index}>{caveat}</li>)}</ul></aside> : null}

    <TablePanel id="daily-clinic-recipients" className={needsCurrencyPanels ? styles.groupedCurrencyPrintHidden : undefined} title="إجماليات الصرف حسب المستفيد" note="الجهات المرتبطة تُجمع بمعرّف الجهة الثابت؛ الأسماء النصّية تبقى أسماء مسجّلة دون استنتاج الهوية. الصرف والعكس والصافي في عملة السند الأصلية.">
      <table className={styles.attendeeTable} data-testid="daily-clinic-recipients"><colgroup><col className={styles.recipientColumn} /><col className={styles.countColumn} />{Array.from({ length: 9 }, (_, i) => <col key={i} />)}</colgroup><thead><tr><th scope="col" rowSpan={2}>المستفيد / أسماء السندات</th><th scope="col" rowSpan={2}>عدد السندات</th><th scope="colgroup" colSpan={3}>الصرف الموجب</th><th scope="colgroup" colSpan={3}>العكس والتعديل السالب</th><th scope="colgroup" colSpan={3}>صافي الصرف المسجّل</th></tr><tr><CurrencyHeaders prefix="الصرف" /><CurrencyHeaders prefix="العكس" /><CurrencyHeaders prefix="الصافي" /></tr></thead>
        <tbody>{expenses.recipientTotals.length === 0 ? <tr><td colSpan={11}>لا مستفيدين في سندات هذا اليوم.</td></tr> : expenses.recipientTotals.map((row) => <tr key={row.recipient.key}>
          <th scope="row"><Recipient recipient={row.recipient} />{row.recordedPayeeTexts.length ? <small>الأسماء المسجّلة: {row.recordedPayeeTexts.join("؛ ")}</small> : null}</th><td>{row.totals.voucherCount}<small>عكس: {row.totals.reversalCount} · تعديل سالب: {row.totals.negativeAdjustmentCount}</small></td><AmountCells amounts={row.totals.outflowMinor} /><AmountCells amounts={row.totals.reversalMinor} /><AmountCells amounts={row.totals.netOutflowMinor} />
        </tr>)}</tbody><tfoot><tr><th scope="row">كل السندات</th><td>{expenses.totals.voucherCount}</td><AmountCells amounts={expenses.totals.outflowMinor} /><AmountCells amounts={expenses.totals.reversalMinor} /><AmountCells amounts={expenses.totals.netOutflowMinor} /></tr></tfoot>
      </table>
    </TablePanel>

    {needsCurrencyPanels ? <section className={`${styles.section} ${styles.currencyPrintAppendix}`} data-testid="daily-clinic-recipient-currency-panels">
      <h2>المستفيدون: تفصيل الطباعة حسب العملة</h2>
      {CURRENCIES.map((currency) => <div className={styles.currencyPanel} key={currency}>
        <h3>{CURRENCY_NAME[currency]} · <bdi>{currency}</bdi></h3>
        <table><thead><tr><th scope="col">المستفيد</th><th scope="col">الصرف الموجب <bdi>{currency}</bdi></th><th scope="col">العكس والتعديل السالب <bdi>{currency}</bdi></th><th scope="col">صافي الصرف المسجّل <bdi>{currency}</bdi></th></tr></thead>
          <tbody>{expenses.recipientTotals.map((row) => <tr key={row.recipient.key}><th scope="row"><Recipient recipient={row.recipient} /><small>سندات: {row.totals.voucherCount} · عكس: {row.totals.reversalCount} · تعديل سالب: {row.totals.negativeAdjustmentCount}</small>{row.recordedPayeeTexts.length ? <small>{row.recordedPayeeTexts.join("؛ ")}</small> : null}</th>
            <td><Money minor={row.totals.outflowMinor[currency]} currency={currency} /></td><td><Money minor={row.totals.reversalMinor[currency]} currency={currency} /></td><td><Money minor={row.totals.netOutflowMinor[currency]} currency={currency} /></td></tr>)}</tbody>
          <tfoot><tr><th scope="row">كل السندات</th><td><Money minor={expenses.totals.outflowMinor[currency]} currency={currency} /></td><td><Money minor={expenses.totals.reversalMinor[currency]} currency={currency} /></td><td><Money minor={expenses.totals.netOutflowMinor[currency]} currency={currency} /></td></tr></tfoot>
        </table>
      </div>)}
    </section> : null}

    <TablePanel id="daily-clinic-reconciliation" title="تفصيل الحركات للمراجعة" note="مبالغ السندات الأصلية والعكس ووسيلة الدفع والأرصدة الدائنة، لمن يحتاج المطابقة التفصيلية. هذه الأرقام من المصدر نفسه ولا تُجمع مع صافيها مرة ثانية.">
      <table className={styles.summaryTable} data-testid="daily-clinic-reconciliation"><thead><tr><th scope="col">البند التفصيلي</th><CurrencyHeaders prefix="التفصيل" /></tr></thead><tbody>
        <SummaryRow label="سندات التحصيل الأصلية المسجّلة اليوم" amounts={totals.nativeReceipts} />
        <SummaryRow label="عكس التحصيل والتصحيحات المسجّلة اليوم" amounts={totals.nativeReversals} />
        <SummaryRow label="صافي التحصيل: وسيلة النقد" amounts={totals.nativeCashNetRecorded} />
        <SummaryRow label="صافي التحصيل: وسيلة التحويل" amounts={totals.nativeTransferNetRecorded} />
        <SummaryRow label="سندات الصرف الموجبة اليوم" amounts={expenses.totals.outflowMinor} />
        <SummaryRow label="عكس الصرف والتعديلات السالبة اليوم" amounts={expenses.totals.reversalMinor} />
        <SummaryRow label="الرصيد الدائن الحالي للمراجعين" amounts={totals.currentCredit} />
      </tbody></table>
    </TablePanel>

    {report.warnings.length ? <aside className={styles.warning} aria-label="تنبيهات اكتمال البيانات"><h2>ملاحظات المراجعة</h2><ul>{report.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></aside> : null}

    <TablePanel id="daily-clinic-close-summary" title="خلاصة اليوم" note="التحصيل والصرف لليوم بكل العيادة؛ الاتفاقات والمديونية للمراجعين الحاضرين. كل عملة مستقلة، وهذه الخلاصة ليست حساب ربح.">
      <table className={styles.summaryTable} data-testid="daily-clinic-close-summary"><thead><tr><th scope="col">البند</th><CurrencyHeaders prefix="القيمة" /></tr></thead><tbody>
        <SummaryRow label="الاتفاقات المعتمدة المرتبطة بعمل اليوم، الآن" amounts={totals.agreement} />
        <SummaryRow label="المسدّد المربوط بتلك الاتفاقات، الآن" amounts={totals.explicitlySettled} />
        <SummaryRow label="المتبقي بعد السداد المربوط بتلك الاتفاقات، الآن" amounts={totals.agreementRemaining} />
        <SummaryRow label="مجموع جزئي للقيمة المسجّلة المعروفة للأعمال المكتملة" amounts={totals.knownCompletedValue} />
        <SummaryRow label="صافي حركات التحصيل المسجّلة اليوم" amounts={totals.nativeNetRecorded} />
        <SummaryRow label="صافي سندات الصرف المسجّلة اليوم" amounts={expenses.totals.netOutflowMinor} />
        <SummaryRow label="مديونية حسابات المراجعين الحالية" amounts={totals.currentReceivable} />
      </tbody></table>
    </TablePanel>
    <section className={`${styles.referenceOnly} ${styles.referenceAppendix}`} aria-labelledby="daily-clinic-reference-heading" data-testid="daily-clinic-reference-appendix">
      <h2 id="daily-clinic-reference-heading">ملحق المراجع: الاتفاقات والحسابات الحالية</h2>
      <p className={styles.note}>هذا الملحق يكمّل كشف اليوم بتفاصيل الاتفاقات المرتبطة وحسابات المراجعين الحالية. يشمل تاريخ الحساب كله، وليس حركات اليوم وحدها. الأرقام المرجعية في سطور الكشف تظهر أيضًا في الطباعة الكاملة.</p>
      <TablePanel id="daily-clinic-agreements" title="مرجع الاتفاقات وحالتها الحالية" note="المدفوع هنا من الربط الصريح بالاتفاق أو فاتورته فقط؛ لا توزيع تخميني لدفعات غير مربوطة، ولا إضافة لفاتورة القسط إلى أصل الاتفاق.">
        <table className={styles.detailsTable}><thead><tr><th scope="col">المريض / الاتفاق</th><th scope="col">الحالة / الاعتماد</th><th scope="col">العملة</th><th scope="col">أصل الاتفاق</th><th scope="col">السداد المربوط</th><th scope="col">المتبقي بعد السداد المربوط</th><th scope="col">زيادة التسوية</th><th scope="col">مراجع الربط</th></tr></thead>
          <tbody>{report.agreements.length === 0 ? <tr><td colSpan={8}>لا اتفاقات مرتبطة موثّقة لهذه المجموعة.</td></tr> : report.agreements.map((agreement) => <tr key={agreement.id}>
            <th scope="row">{agreement.patientName}<small>#{agreement.id} · {agreement.title}</small></th>
            <td>{agreement.status}<small>{agreement.includedInTotals ? "داخل الإجمالي" : `مستبعد: ${agreement.excludedReason ?? "غير معتمد"}`}</small>{agreement.consentAt ? <small>الموافقة: <Timestamp value={agreement.consentAt} zone={zone} /></small> : <small>الموافقة غير مسجّلة</small>}</td>
            <td><bdi>{agreement.currency}</bdi></td><td><Money minor={agreement.principalMinor} currency={agreement.currency} /></td><td><Money minor={agreement.explicitlySettledMinor} currency={agreement.currency} /></td><td><Money minor={agreement.remainingMinor} currency={agreement.currency} /></td><td><Money minor={agreement.excessSettlementMinor} currency={agreement.currency} /></td>
            <td><small>الزيارات: {agreement.linkedVisitIds.join("، ") || "لا يوجد"}</small><small>الدفعات: {agreement.paymentIds.join("، ") || "لا يوجد"}</small></td>
          </tr>)}</tbody>
        </table>
      </TablePanel>

      <section className={styles.section} aria-labelledby="daily-clinic-accounts-heading">
        <h2 id="daily-clinic-accounts-heading">حسابات المراجعين الحالية: المديونية والرصيد الدائن</h2>
        <p className={styles.note}>أرصدة حالية عند إعداد الكشف، تشمل تاريخ حساب المراجع كله. الدفعات غير المربوطة لا تُنسب إلى اتفاق. المديونية منفصلة عن المتبقي بعد السداد المربوط، والرصيد الدائن منفصل عن الدين.</p>
        {CURRENCIES.map((currency) => <div key={currency} className={styles.currencyPanel}>
          <h3><bdi>{currency}</bdi></h3>
          <div className={styles.tableScroll} tabIndex={0} role="region" aria-label={`حسابات المراجعين ${currency}`}>
            <table className={styles.detailsTable} data-account-currency={currency}><thead><tr><th scope="col">المريض</th><th scope="col">الافتتاحي</th><th scope="col">المفوتر</th><th scope="col">التسويات</th><th scope="col">المديونية الآن</th><th scope="col">رصيد دائن الآن</th><th scope="col">دفعات غير مربوطة</th></tr></thead>
              <tbody>{report.currentAccounts.length === 0 ? <tr><td colSpan={7}>لا حسابات مرضى مرتبطة بالحضور.</td></tr> : report.currentAccounts.map((account) => <tr key={account.patientId}>
                <th scope="row">{account.patientName}<PatientIdentity patientId={account.patientId} /></th>
                <td><Money minor={account.byCurrency[currency].openingMinor} currency={currency} /></td><td><Money minor={account.byCurrency[currency].billedMinor} currency={currency} /></td><td><Money minor={account.byCurrency[currency].collectedMinor} currency={currency} /></td><td><Money minor={account.byCurrency[currency].receivableMinor} currency={currency} /></td><td><Money minor={account.byCurrency[currency].creditMinor} currency={currency} /></td><td>{account.unallocatedPaymentIds.join("، ") || "لا يوجد"}<small>المراجع تخص الحساب بجميع عملاته</small></td>
              </tr>)}</tbody><tfoot><tr><th scope="row" colSpan={4}>إجمالي الحسابات دون تكرار</th><td><Money minor={totals.currentReceivable[currency]} currency={currency} /></td><td><Money minor={totals.currentCredit[currency]} currency={currency} /></td><td> </td></tr></tfoot>
            </table>
          </div>
        </div>)}
      </section>
    </section>
    <p className={styles.endNote} data-testid="daily-clinic-end">{printScope === "full" ? "نهاية الكشف الكامل" : "نهاية ملخص كشف اليوم؛ ملحق المراجع غير مشمول بالطباعة"} · {totals.attendeesCount} مراجع · {report.work.length} سطر توثيق عمل · {report.receipts.length} حركة تحصيل · {expenses.movements.length} سند صرف. سطور توثيق بلا قيمة مستقلة: {totals.unvaluedWorkCount}. لا يُعدّ هذا المجموع الجزئي إيرادًا كاملًا لليوم، ولا تجمع سطور التوثيق كعدد إجراءات مستقلة.</p>
  </div>;
}

export function DailyClinicReportView({ initialDate, clinicTimeZone }: { initialDate: string; clinicTimeZone: string }) {
  const clinicName = useClinicName();
  const session = useSession();
  const allowed = session?.role === "admin";
  const principal = session ? JSON.stringify([session.username, session.role]) : "anonymous";
  const [authorization, setAuthorization] = useState({ principal, generation: 0 });
  if (authorization.principal !== principal) {
    // Render-observed generation retires A's result before effects, including
    // A → denied/null/B → A round trips with the same date and retry counter.
    setAuthorization({ principal, generation: authorization.generation + 1 });
  }
  const currentAuthorization = authorization.principal === principal;
  const [date, setDate] = useState(initialDate);
  const [printScope, setPrintScope] = useState<PrintScope>("summary");
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState<{ key: string; report: DailyClinicReport } | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const valid = isDailyClinicReportDate(date);
  // Include retries as well as dates. Refresh hides even a same-day result
  // in the state-change commit, before the next request's passive effect.
  const key = `${principal}:${authorization.generation}:${date}:${attempt}`;
  const report = allowed && currentAuthorization && valid && loaded?.key === key ? loaded.report : null;
  const error = allowed && currentAuthorization && valid && failure?.key === key ? failure.message : null;
  const loading = allowed && valid && !report && !error;

  useEffect(() => {
    if (!allowed || !isDailyClinicReportDate(date)) return;
    let active = true;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`/api/reports/daily-clinic?date=${encodeURIComponent(date)}`, { cache: "no-store", signal: controller.signal });
        if (!active) return;
        if (!response.ok) throw new Error(response.status === 401 ? "انتهت الجلسة. سجّل الدخول من جديد." : response.status === 403 ? "كشف إقفال اليوم متاح للمدير فقط." : LOAD_ERROR);
        const payload: DailyClinicReport = await response.json();
        if (!active) return;
        if (payload?.date !== date || payload?.clinicTimeZone !== clinicTimeZone) throw new Error("وصل كشف لا يطابق اليوم أو توقيت العيادة المطلوب.");
        if (!Array.isArray(payload.attendees) || !Array.isArray(payload.work) || !Array.isArray(payload.receipts)
          || !Array.isArray(payload.agreements) || !Array.isArray(payload.currentAccounts) || !Array.isArray(payload.warnings)
          || !Array.isArray(payload.expenses?.movements) || !Array.isArray(payload.expenses?.recipientTotals)
          || !payload.totals || !payload.expenses.totals || payload.expenses.date !== date) throw new Error(LOAD_ERROR);
        setLoaded({ key, report: payload });
        setFailure(null);
      } catch (error) {
        if (!active) return;
        const message = error instanceof Error && [LOAD_ERROR, "انتهت الجلسة. سجّل الدخول من جديد.", "كشف إقفال اليوم متاح للمدير فقط.", "وصل كشف لا يطابق اليوم أو توقيت العيادة المطلوب."].includes(error.message) ? error.message : LOAD_ERROR;
        setLoaded(null);
        setFailure({ key, message });
      }
    })();
    return () => { active = false; controller.abort(); };
  }, [allowed, clinicTimeZone, date, key]);

  return <article className={styles.report} data-testid="daily-clinic-report" data-print-scope={printScope} dir="rtl">
    <div className={styles.screenOnly}>
      <PageHeader title={TITLE} subtitle="حضور اليوم، الأعمال الموثّقة، والقراءة المالية المفصولة حسب العملة" back={{ href: "/reports", label: "مركز التقارير" }}>
        {report ? <button type="button" data-testid="daily-clinic-print" className={styles.primaryButton} onClick={() => window.print()}>{printScope === "full" ? "طباعة الكشف الكامل" : "طباعة ملخص كشف اليوم"}</button> : null}
      </PageHeader>
      {allowed ? <div className={styles.controls}>
        <label htmlFor="daily-clinic-date">يوم الحضور<input id="daily-clinic-date" type="date" value={date} onChange={(event) => { setDate(event.target.value); setAttempt((value) => value + 1); }} /></label>
        <button type="button" className={styles.button} onClick={() => { setDate(clinicDateString(new Date(), clinicTimeZone)); setAttempt((value) => value + 1); }}>اليوم بتوقيت العيادة</button>
        <button type="button" className={styles.button} disabled={!valid || loading} onClick={() => setAttempt((value) => value + 1)}>تحديث الكشف</button>
        <label htmlFor="daily-clinic-print-scope">نطاق الطباعة<select id="daily-clinic-print-scope" aria-label="نطاق الطباعة" value={printScope} onChange={(event) => setPrintScope(event.target.value === "full" ? "full" : "summary")}><option value="summary">ملخص كشف اليوم</option><option value="full">كشف اليوم مع الملحق الكامل</option></select></label>
        <span className={styles.note}>التوقيت: <bdi>{clinicTimeZone}</bdi> · الورق: A4 أفقي</span>
        <p className={styles.printScopeHint}>ملخص كشف اليوم يطبع جميع المراجعين والأعمال وحركات التحصيل وسندات الصرف والإجماليات. الطباعة الكاملة تضيف تفاصيل الاتفاقات والحسابات ومراجع الربط. جميع التفاصيل ظاهرة على الشاشة في الخيارين.</p>
      </div> : null}
    </div>
    {!allowed ? <p role="alert" className={styles.warning}>كشف إقفال اليوم متاح للمدير فقط.</p> : null}
    {allowed && !valid ? <p role="alert" className={styles.warning}>اختر تاريخًا صحيحًا؛ لا يوجد كشف صالح للعرض أو الطباعة.</p> : null}
    {loading ? <p role="status" className={styles.status}>جارٍ إعداد كشف إقفال اليوم…</p> : null}
    {error ? <div role="alert" className={styles.warning}>{error}<button type="button" className={`${styles.button} ${styles.screenOnly}`} onClick={() => setAttempt((value) => value + 1)}>أعد المحاولة</button></div> : null}
    {report ? <Fragment key={key}><DailyClinicReportBody report={report} clinicName={clinicName} printScope={printScope} /></Fragment> : <p className={styles.printOnly}>لا يوجد كشف محمّل صالح لليوم المحدد. لم تُطبع أي نتيجة سابقة.</p>}
  </article>;
}
