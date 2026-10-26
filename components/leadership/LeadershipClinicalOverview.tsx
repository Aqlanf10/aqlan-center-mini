"use client";

import { useState } from "react";
import { CURRENCY_LABEL, formatMoney } from "@/lib/money";
import {
  decodeLeadershipClinical, leadershipClinicalHref, leadershipClinicalUrl,
  type ClinicalMetric, type ClinicalRow, type LeadershipClinicalPreset, type LeadershipClinicalRead, type LeadershipClinicalSource,
} from "@/lib/leadership-clinical";
import { SourceState, leadershipTime } from "./LeadershipOverview";
import { useLeadershipRead } from "./useLeadershipRead";
import { decodeLeadershipPulse, leadershipPlanHref, type LeadershipPulse } from "@/lib/leadership-pulse";
import styles from "./leadership.module.css";

const SOURCES: { id: LeadershipClinicalSource | "care"; label: string }[] = [
  { id: "care", label: "العمل المتبقي الآن" },
  { id: "unscheduled-treatment", label: "علاج ينتظر الجدولة" },
  { id: "plan-intelligence", label: "متابعة خطط الفترة" },
  { id: "provider-utilization", label: "أداء الأطباء" },
];
const PRESETS: { id: LeadershipClinicalPreset; label: string }[] = [
  { id: "today", label: "اليوم" }, { id: "this_week", label: "هذا الأسبوع" },
  { id: "this_month", label: "هذا الشهر" }, { id: "prev_month", label: "الشهر السابق" },
];
const LABELS: Record<string, string> = {
  plans: "خطط بلا موعد قادم للمريض", patients: "مرضى يحتاجون مراجعة الجدولة", items: "بنود علاج معلّقة",
  created: "خطط بدأت في الفترة", active: "جارية الآن", completed: "مكتملة الآن", stopped: "متوقفة الآن",
  doctors: "أطباء لهم سجلات في الفترة", appointments: "مواعيد الفترة", visits: "زيارات الفترة", "chair-minutes": "دقائق كرسي موثّقة",
};

export function LeadershipClinicalOverview() {
  const [source, setSource] = useState<LeadershipClinicalSource | "care">("care");
  return <section className={styles.stack} data-testid="leadership-clinical">
    <div className={styles.sectionHeading}><div><p className={styles.eyebrow}>قراءة إدارية · كل مصدر بنطاقه</p><h2>العلاج المتبقي وأداء الأطباء</h2></div></div>
    <nav className={styles.pillGroup} aria-label="مصادر العلاج والأطباء">{SOURCES.map(item => <button type="button" key={item.id} aria-pressed={source === item.id} onClick={() => setSource(item.id)}>{item.label}</button>)}</nav>
    {source === "care" ? <LeadershipCareOverview /> : <ClinicalReportSource key={source} source={source} />}
  </section>;
}

function ClinicalReportSource({ source }: { source: LeadershipClinicalSource }) {
  const [preset, setPreset] = useState<LeadershipClinicalPreset>("this_month");
  const read = useLeadershipRead(leadershipClinicalUrl(source, preset), value => decodeLeadershipClinical(value, source));
  return <div className={styles.stack}>
    <button type="button" className={styles.smallButton} onClick={read.refresh} disabled={read.loading}>تحديث المصدر</button>
    {source !== "unscheduled-treatment" && <div className={styles.pillGroup} role="group" aria-label="فترة العلاج والأطباء">{PRESETS.map(item => <button type="button" key={item.id} aria-pressed={preset === item.id} onClick={() => setPreset(item.id)}>{item.label}</button>)}</div>}
    <p className={styles.sourceLine}>{source === "unscheduled-treatment" ? "كل الخطط الجارية الآن التي لها بنود معلّقة ولا موعد محجوز قادم للمريض؛ مستقلة عن يوم التشغيل والفترة المالية." : "فترة مستقلة عن يوم التشغيل والمالية؛ التواريخ الفعلية تظهر بعد التحقق من المصدر."}</p>
    <SourceState {...read} onRetry={read.refresh} />
    {read.data && <LeadershipClinicalReadout read={read.data} />}
  </div>;
}

function LeadershipCareOverview() {
  const [page, setPage] = useState(0);
  const read = useLeadershipRead(`/api/executive/pulse?view=care&page=${page}`, value => decodeLeadershipPulse(value, "care", null));
  return <section className={styles.stack} data-testid="leadership-care">
    <div className={styles.sectionHeading}><h3 className={styles.recordHeading}>كل الخطط الجارية والعمل المتبقي</h3><button type="button" className={styles.smallButton} disabled={read.loading} onClick={read.refresh}>تحديث العمل المتبقي</button></div>
    <p className={styles.sourceLine}>كل الخطط بحالة جارية الآن، من جميع تواريخ البدء، سواء وُجد موعد قادم أم لم يوجد. مستقلة عن يوم الوصول والفترة المالية.</p>
    <SourceState {...read} onRetry={read.refresh} />
    {read.data && <><LeadershipCareReadout read={read.data} />
      {read.data.total > 10 && <nav className={styles.pagination} aria-label="صفحات الخطط الجارية"><button type="button" disabled={read.data.page === 0} onClick={() => setPage(read.data!.page - 1)}>الخطط السابقة</button><span>{read.data.page + 1} / {Math.ceil(read.data.total / 10)}</span><button type="button" disabled={!read.data.hasMore} onClick={() => setPage(read.data!.page + 1)}>الخطط التالية</button></nav>}
    </>}
  </section>;
}

export function LeadershipCareReadout({ read }: { read: LeadershipPulse }) {
  const cards = [{ key: "activePlans", label: "كل الخطط الجارية" }, { key: "pendingPlans", label: "خطط فيها عمل متبقٍ" }, { key: "pendingItems", label: "بنود علاج لم تكتمل" }, { key: "patients", label: "مرضى لهم خطط جارية" }];
  return <div className={styles.stack}>
    <p className={styles.sourceLine}>قراءة {leadershipTime(read.asOf, read.timeZone)} · كل الخطط الجارية الآن · المنطقة الزمنية <bdi>{read.timeZone}</bdi></p>
    <div className={styles.metrics}>{cards.map(card => <a key={card.key} className={styles.metric} href="#leadership-care-plans"><span className={styles.metricTop}>{card.label}</span><strong>{read.counts[card.key].toLocaleString("en")}</strong><span className={styles.metricDetail}>كل التواريخ · الحالة الحالية عند القراءة</span><span className={styles.textLink}>تفاصيل الخطط الجارية</span></a>)}</div>
    <section className={styles.panel} id="leadership-care-plans"><h3 className={styles.recordHeading}>الخطط الأصلية للمراجعة</h3>
      <p className={styles.sourceLine}>{read.counts.plannedItems} بنود مخططة · {read.counts.inProgressItems} قيد التنفيذ · {read.counts.withoutPendingItems} خطط جارية بلا بنود معلّقة. الأعداد كاملة؛ تعرض الصفحة {read.items.length} من {read.total} خطة.</p>
      {read.total === 0 ? <p className={styles.empty}>لا خطط بحالة جارية في المصدر الآن.</p> : <ul className={styles.evidenceList}>{read.items.map(row => <li key={row.id} className={styles.evidenceRow}>
        <div className={styles.rowTitle}><a className={styles.patientLink} href={leadershipPlanHref(row)}>{row.patientName} · {row.title}</a><span className={row.pendingItems ? styles.attention : styles.status}>{row.pendingItems} بنود معلّقة</span></div>
        <p>خطة #{row.id} · بدأت <bdi>{row.startDate}</bdi> · الطبيب الرئيسي المسجّل: {row.doctorName ?? "غير محدد"}</p>
        <p>{row.plannedItems} مخططة · {row.inProgressItems} قيد التنفيذ</p><p className={styles.nextAction}>{row.pendingItems ? "راجع البنود والجلسات في الخطة الأصلية." : "لا بنود معلّقة، لكن الخطة ما زالت جارية؛ راجع حالتها من المصدر."}</p>
      </li>)}</ul>}
      <p className={styles.footnote}>العمل المتبقي هو عدد بنود «مخطط/قيد التنفيذ» في الخطط الجارية، وليس عدد الجلسات أو المرضى. المنتهية والملغاة لا تدخل؛ الخطط المتوقفة والمكتملة خارج هذا النطاق. الطبيب الرئيسي سياق علاجي وليس مسؤول متابعة مسندًا. لا موعد استحقاق مفترض ولا حكم بالتأخر، ولا قيمة مالية محسوبة هنا.</p>
    </section>
  </div>;
}

function metricScope(read: LeadershipClinicalRead): string {
  return read.report === "unscheduled-treatment" ? "كل المفتوح المطابق الآن · لقطة حالية"
    : read.report === "plan-intelligence" ? `خطط بدأت ${read.from} إلى ${read.to} · حالتها الآن`
    : `${read.from} إلى ${read.to} · سجلات الفترة`;
}
function Metric({ metric, read }: { metric: ClinicalMetric; read: LeadershipClinicalRead }) {
  const money = "minor" in metric;
  const label = money ? `${read.report === "unscheduled-treatment" ? "قيمة البنود المعلّقة" : "القيمة المتبقية لخطط الفترة"} · ${CURRENCY_LABEL[metric.currency]}` : LABELS[metric.key];
  return <a className={money ? styles.amountCard : styles.metric} href={leadershipClinicalHref(read)}>
    <span className={styles.metricTop}>{label}</span>
    {money ? <p className={styles.amountValue}><bdi>{formatMoney(metric.minor, metric.currency)}</bdi></p> : <strong><bdi>{metric.count.toLocaleString("en")}</bdi></strong>}
    <span className={styles.metricDetail}>{metricScope(read)}{money ? " · قيمة علاج، ليست مديونية أو تحصيلًا" : ""}</span>
    <span className={styles.textLink}>عرض تفاصيل المصدر</span>
  </a>;
}
function PendingRow({ row }: { row: ClinicalRow }) {
  return <li className={styles.evidenceRow}><div className={styles.rowTitle}><a className={styles.patientLink} href={`/patients/${row.patientId}`}>{row.patientName}</a><span className={styles.status}>{row.pendingItems} بنود معلّقة</span></div>
    <p>{row.planTitle} · الطبيب الرئيسي المسجّل: {row.doctorName}</p>
    <p>بدء الخطة: <bdi>{row.startDate}</bdi> · آخر زيارة: <bdi>{row.lastVisit || "لا زيارة مسجّلة"}</bdi></p>
    <p className={styles.nextAction}>راجع الخطة في ملف المريض ثم الحجز المناسب؛ لا تثبت هذه القائمة رفض العلاج أو مسؤولية موظف.</p>
  </li>;
}
function DoctorRow({ row, read }: { row: ClinicalRow; read: LeadershipClinicalRead }) {
  return <li className={styles.evidenceRow}><div className={styles.rowTitle}><a className={styles.patientLink} href={leadershipClinicalHref(read, Number(row.doctorId))}>{row.doctorName}</a><span className={styles.status}>{row.visits} زيارات</span></div>
    <p>{row.appointments} مواعيد · {row.attended} حضروا · {row.noShow} لم يحضروا</p>
    <p>دقائق الكرسي الموثّقة: {row.chairMinutes} · متوسط الزيارة: {row.avgVisitMinutes === null ? "غير معروف؛ لا وقتين صالحين" : `${row.avgVisitMinutes} دقيقة`}</p>
    <p>الإنتاج من بنود الفواتير: <bdi>{row.productionText}</bdi></p><p>المحصّل من أعماله: <bdi>{row.collectedText}</bdi></p>
  </li>;
}

/** Dedicated projection: arbitrary source columns/notes never become side summaries. */
export function LeadershipClinicalReadout({ read }: { read: LeadershipClinicalRead }) {
  const countMetrics = read.metrics.filter(metric => "count" in metric);
  const moneyMetrics = read.metrics.filter(metric => "minor" in metric);
  return <div className={styles.stack}>
    <p className={styles.sourceLine}>{metricScope(read)} · قراءة {leadershipTime(read.generatedAt, read.timeZone)} · المنطقة الزمنية <bdi>{read.timeZone}</bdi></p>
    <div className={styles.metrics}>{countMetrics.map(metric => <Metric key={metric.key} metric={metric} read={read} />)}</div>
    {moneyMetrics.length > 0 && <details className={`${styles.panel} ${styles.recordDetails}`}><summary>قيمة العلاج بحسب العملة · ليست مديونية</summary><div className={styles.amountGrid}>{moneyMetrics.map(metric => <Metric key={metric.key} metric={metric} read={read} />)}</div></details>}
    {read.report === "plan-intelligence" ? <section className={styles.panel}>
      <h3 className={styles.recordHeading}>نطاق خطط الفترة</h3><p className={styles.footnote}>هذه خطط بدأ تاريخها في الفترة المختارة وحالتها الحالية، وليست كل الأعمال المتبقية في العيادة. القيمة المتبقية من مرجع التقرير: قيمة الخطة ناقص قيمة بنود «تمّت» ضمن حد الخطة، وتشمل كل حالات خطط الفترة؛ ليست رصيد المريض.</p>
      <a className={styles.textLink} href={leadershipClinicalHref(read)}>تفصيل الخطط حسب الطبيب والتخصص والعملة</a>
    </section> : <section className={styles.panel}>
      <div className={styles.sectionHeading}><h3 className={styles.recordHeading}>{read.report === "provider-utilization" ? "سجلات الأطباء في الفترة" : "أولوية مراجعة الجدولة"}</h3><a className={styles.textLink} href={leadershipClinicalHref(read)}>فتح التقرير الكامل</a></div>
      <p className={styles.sourceLine}>يعرض {Math.min(10, read.rows.length)} من {read.rows.length} سجلات أعادها المصدر الكامل. يُحمّل هذا التقرير عند فتحه فقط.</p>
      {read.rows.length === 0 ? <p className={styles.empty}>لا سجلات مطابقة في نتيجة المصدر.</p> : <ul className={styles.evidenceList}>{read.rows.slice(0, 10).map((row, index) => read.report === "provider-utilization" ? <DoctorRow key={String(row.doctorId)} row={row} read={read} /> : <PendingRow key={`${row.patientId}-${index}`} row={row} />)}</ul>}
      <p className={styles.footnote}>{read.report === "provider-utilization"
        ? "سجلات المواعيد والزيارات لا تثبت حضور الطبيب الآن. نسبة الاستغلال غير معروفة دون ساعات عمله. الإنتاج من بنوده والتحصيل من مرجع إسناد التحصيل، كل عملة على حدة؛ الشرطة تعني أن المصدر لم يعرض حركة غير صفرية. لا تُنسب مصروفات العيادة إلى طبيب، ولا تُعرض الرواتب أو العمولات هنا."
        : "المصدر يستبعد أي مريض له موعد بحالة محجوز من اليوم فصاعدًا، ولو كان الموعد لعمل آخر؛ لذلك ليست هذه قائمة شاملة بكل علاج غير مجدول. البنود المعلّقة: مخطط أو قيد التنفيذ في خطة جارية. الطبيب الرئيسي سياق علاجي، وليس مسؤول متابعة مسندًا."}</p>
    </section>}
  </div>;
}
