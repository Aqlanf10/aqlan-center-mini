"use client";
import { useState, type ReactNode } from "react";
import { Icon, type IconName } from "../Icon";
import { decodeLeadershipPulse, leadershipVisitHref, leadershipWaitingMinutes, type LeadershipPulse, type PulseRow } from "@/lib/leadership-pulse";
import { decodeLabBacklog, labBacklogAge, labBacklogNextAction, labBacklogPatientHref } from "@/lib/lab-backlog";
import { LAB_STATUS_LABEL } from "@/lib/lab";
import { useLeadershipRead } from "./useLeadershipRead";
import styles from "./leadership.module.css";

export type LeadershipSection = "overview" | "reviews" | "lab" | "team" | "finance";
export const leadershipTime = (value: string, timeZone: string) => new Intl.DateTimeFormat("ar-YE", { timeZone, dateStyle: "short", timeStyle: "short" }).format(new Date(value));
const status: Record<string, string> = { waiting: "في صالة الانتظار", called: "نودي ولم يجلس", in_chair: "على الكرسي", planned: "مخططة", in_progress: "قيد التنفيذ", blocked: "متوقفة" };
const action: Record<string, string> = { create: "إنشاء", update: "تعديل", status: "تغيير الحالة", assign: "إسناد", comment: "تعليق", checklist: "قائمة العمل", visibility: "تغيير الخصوصية", link: "ربط سجل", unlink: "فك ربط" };
export function SourceState({ loading, error, stale, onRetry }: { loading: boolean; error: string | null; stale: boolean; onRetry: () => void }) {
 return <>{loading && <p className={styles.sourceState} role="status">جارٍ التحقق من المصدر…</p>}
  {error && <div className={styles.error} role="alert">{error} <button type="button" onClick={onRetry}>إعادة التحقق</button></div>}
  {stale && !loading && !error && <p className={styles.stale} role="status">قد تكون البيانات تغيّرت. حدّث القراءة قبل اتخاذ قرار.</p>}</>;
}
export function MetricCard({ label, value, detail, icon, onClick, attention = false }: { label: string; value: number | null; detail: string; icon: IconName; onClick: () => void; attention?: boolean }) {
 return <button type="button" className={`${styles.metric} ${attention ? styles.metricAttention : ""}`} onClick={onClick}>
  <span className={styles.metricTop}><span>{label}</span><Icon name={icon} className="h-5 w-5" /></span>
  <strong>{value === null ? "—" : value.toLocaleString("en")}</strong><span className={styles.metricDetail}>{detail}</span>
 </button>;
}
function SectionHeading({ eyebrow, title, children }: { eyebrow: string; title: string; children?: ReactNode }) {
 return <div className={styles.sectionHeading}><div><p className={styles.eyebrow}>{eyebrow}</p><h2>{title}</h2></div>{children}</div>;
}
function TaskRow({ row, data }: { row: PulseRow; data: LeadershipPulse }) {
 const overdue = row.dueAt !== null && Date.parse(row.dueAt) < Date.parse(data.asOf);
 return <li className={styles.evidenceRow}>
  <div className={styles.rowTitle}><strong>#{row.id} · {row.title}</strong><span className={overdue ? styles.attention : styles.status}>{overdue ? "تجاوز الاستحقاق" : status[row.status]}</span></div>
  <p>المسؤول المسند: <b>{row.assignee ?? "غير مسند"}</b> · الاستحقاق: {row.dueAt ? leadershipTime(row.dueAt, data.timeZone) : "غير محدد"}</p>
  <p className={styles.muted}>آخر إجراء: {row.latestAction ? `${action[row.latestAction.action] ?? row.latestAction.action} · ${row.latestAction.actor} · ${leadershipTime(row.latestAction.at, data.timeZone)}` : "لا يوجد حدث مسجل؛ آخر تحديث: " + leadershipTime(row.eventAt, data.timeZone)}</p>
  <p className={styles.nextAction}>الخطوة التالية: {row.status === "blocked" ? "راجع سبب التوقف في سجل المهمة." : overdue ? "راجع التقدم والموعد مع المسؤول المسند." : "راجع تفاصيل المهمة والعمل المتبقي."}</p>
 </li>;
}
export function LeadershipTasks({ compact = false }: { compact?: boolean }) {
 const [page, setPage] = useState(0);
 const read = useLeadershipRead(`/api/executive/pulse?view=tasks&page=${page}`, v => decodeLeadershipPulse(v, "tasks", null));
 return <section className={styles.panel} data-testid="leadership-tasks">
  <SectionHeading eyebrow="المهام المفتوحة الآن · حسب صلاحيتك" title="مسؤولية واضحة، ومتابعة موثّقة"><a className={styles.textLink} href="/hr?tab=tasks">فتح المهام</a></SectionHeading>
  <SourceState {...read} onRetry={read.refresh} />
  {read.data && <><p className={styles.sourceLine}>{read.data.counts.open} مفتوحة · {read.data.counts.overdue} تجاوزت الاستحقاق · {read.data.counts.blocked} متوقفة · قراءة {leadershipTime(read.data.asOf, read.data.timeZone)}</p>
   <ul className={styles.evidenceList}>{read.data.items.slice(0, compact ? 3 : 10).map(row => <TaskRow key={row.id} row={row} data={read.data!} />)}</ul>
   {read.data.total === 0 && <p className={styles.empty}>لا مهام مفتوحة ظاهرة لك. المهام الخاصة بغيرك لا تظهر هنا.</p>}
   {!compact && read.data.total > 10 && <div className={styles.pagination}><button type="button" disabled={read.data.page === 0} onClick={() => setPage(read.data!.page - 1)}>السابق</button><span>{read.data.page + 1} / {Math.ceil(read.data.total / 10)}</span><button type="button" disabled={!read.data.hasMore} onClick={() => setPage(read.data!.page + 1)}>التالي</button></div>}
   {compact && read.data.total > 3 && <p className={styles.sourceLine}>أول 3 مهام حسب الاستحقاق والتوقف؛ القائمة الكاملة في قسم الفريق.</p>}
  </>}
  <p className={styles.footnote}>آخر من سجّل إجراءً ليس بالضرورة المسؤول المسند. تأخر المهمة إشارة للمراجعة، لا حكم على الموظف.</p>
  <button type="button" className={styles.smallButton} onClick={read.refresh} disabled={read.loading}>تحديث المهام</button>
 </section>;
}
export function LeadershipOverview({ onSection }: { onSection: (section: LeadershipSection) => void }) {
 const [day, setDay] = useState("");
 const [page, setPage] = useState(0);
 const [expanded, setExpanded] = useState(false);
 const selectedDay = day;
 const daily = useLeadershipRead(`/api/executive/pulse?view=day&page=${page}${selectedDay ? `&day=${selectedDay}` : ""}`, v => decodeLeadershipPulse(v, "day", selectedDay || null));
 const labs = useLeadershipRead("/api/lab/backlog?filter=all&page=0", v => decodeLabBacklog(v, "all"));
 // Empty day means server clinic-today at each read; paging pins the displayed cohort explicitly.
 const currentDay = selectedDay || daily.data?.day || "";
 return <div data-testid="leadership-overview">
  <div className={styles.toolbar}>
   <div><p className={styles.eyebrow}>تشغيل العيادة</p><label className={styles.dayLabel}>يوم الوصول والمواعيد<input type="date" value={currentDay} onChange={e => { setPage(0); setDay(e.target.value); }} /></label></div>
   <p className={styles.toolbarNote}>الحالة الحالية لسجلات اليوم المختار<br /><span>المعامل والمهام: كل المفتوح الآن، بلا تقييد بهذا اليوم</span></p>
   <button type="button" className={styles.smallButton} disabled={daily.loading} onClick={() => { setDay(""); setPage(0); daily.refresh(); }}>اليوم</button>
   <button type="button" className={styles.primaryButton} disabled={daily.loading || labs.loading} onClick={() => { setPage(0); daily.refresh(); labs.refresh(); }}>تحديث التشغيل والمعمل</button>
  </div>
  <div className={styles.metrics}>
   <MetricCard label="في صالة الانتظار" value={daily.data?.counts.waiting ?? null} detail="حضروا ولم يُنادَ عليهم" icon="clock" onClick={() => document.getElementById("leadership-day-queue")?.scrollIntoView({ block: "start" })} attention={(daily.data?.counts.waiting ?? 0) > 0} />
   <MetricCard label="زيارات لم تنتهِ" value={daily.data?.total ?? null} detail="انتظار + نداء + على الكرسي" icon="tooth" onClick={() => document.getElementById("leadership-day-queue")?.scrollIntoView({ block: "start" })} />
   <MetricCard label="وصلت ولم تُركّب" value={labs.data?.counts.awaitingFitting ?? null} detail="طلبات معمل مفتوحة من كل الأيام" icon="flask" onClick={() => onSection("lab")} attention={(labs.data?.counts.awaitingFitting ?? 0) > 0} />
   <MetricCard label="متأخرة عند المعمل" value={labs.data?.counts.overdue ?? null} detail="تجاوزت يوم الوصول المتوقع المسجّل" icon="calendar" onClick={() => onSection("lab")} attention={(labs.data?.counts.overdue ?? 0) > 0} />
  </div>
  <div className={styles.overviewGrid}>
   <section className={styles.panel} id="leadership-day-queue" data-testid="leadership-day-queue">
    <SectionHeading eyebrow="اليوم المختار · الأولوية للمنتظرين" title="ما الذي يحتاج تدخّلًا؟"><button type="button" className={styles.textLink} onClick={() => { setExpanded(!expanded); setPage(0); }}>{expanded ? "عرض مختصر" : "عرض قائمة الزيارات"}</button></SectionHeading>
    <SourceState {...daily} onRetry={daily.refresh} />
    {daily.data && <><p className={styles.sourceLine}>{daily.data.day} · {daily.data.counts.appointments} موعدًا · {daily.data.counts.done} زيارة منتهية · قراءة {leadershipTime(daily.data.asOf, daily.data.timeZone)}</p>
     <ul className={styles.evidenceList}>{daily.data.items.slice(0, expanded ? 10 : 5).map(row => <li key={row.id} className={styles.evidenceRow}>
      <div className={styles.rowTitle}><a className={styles.patientLink} href={leadershipVisitHref(row)}>{row.title}</a><span className={styles.status}>{status[row.status]}</span></div>
      <p>الوصول: {leadershipTime(row.eventAt, daily.data!.timeZone)} · الطبيب المسجّل: {row.doctorName ?? "غير محدد"}</p>
      {row.status === "waiting" && <p className={styles.nextAction}>وقت الانتظار عند القراءة: {leadershipWaitingMinutes(row.eventAt, daily.data!.asOf) === null ? "غير معروف؛ راجع وقت الوصول المسجّل" : `${leadershipWaitingMinutes(row.eventAt, daily.data!.asOf)} دقيقة`}</p>}
     </li>)}</ul>
     {daily.data.total === 0 && <p className={styles.empty}>لا زيارات مفتوحة ضمن يوم الوصول المختار.</p>}
     {!expanded && daily.data.total > 5 && <p className={styles.sourceLine}>أول 5 من {daily.data.total} زيارة مفتوحة. افتح قائمة الزيارات لاستعراض جميع سجلات اليوم المختار.</p>}
     {expanded && daily.data.total > 10 && <div className={styles.pagination}><button type="button" disabled={daily.data.page === 0} onClick={() => { setDay(daily.data!.day); setPage(daily.data!.page - 1); }}>السابق</button><span>{daily.data.page + 1} / {Math.ceil(daily.data.total / 10)}</span><button type="button" disabled={!daily.data.hasMore} onClick={() => { setDay(daily.data!.day); setPage(daily.data!.page + 1); }}>التالي</button></div>}
     <div className={styles.inlineLinks}><a href="/">شاشة تشغيل اليوم الحالي</a><a href={`/appointments?date=${daily.data.day}`}>مواعيد {daily.data.day}</a><button type="button" onClick={() => onSection("reviews")}>مراجعة عدم الحضور والإحالات</button></div>
    </>}
    <p className={styles.footnote}>وقت الانتظار لا يحدد المتسبب. الطبيب المسجّل سياق علاجي، وليس إسناد متابعة.</p>
   </section>
   <section className={styles.panel} data-testid="leadership-lab-preview">
    <SectionHeading eyebrow="كل الأيام · الطلبات المفتوحة الآن" title="متابعة التركيبات والمعمل"><button type="button" className={styles.textLink} onClick={() => onSection("lab")}>عرض المتابعة</button></SectionHeading>
    <SourceState {...labs} onRetry={labs.refresh} />
    {labs.data && <><p className={styles.sourceLine}>{labs.data.counts.patients} مريض · {labs.data.counts.orders} طلب · قراءة {leadershipTime(labs.data.asOf, labs.data.timeZone)}</p>
     <ul className={styles.evidenceList}>{labs.data.items.slice(0, 3).map(item => {
      const age = labBacklogAge(item, labs.data!.today, labs.data!.timeZone);
      return <li key={item.id} className={styles.evidenceRow}><div className={styles.rowTitle}><a className={styles.patientLink} href={labBacklogPatientHref(item.patientId)}>{item.patientName}</a><span className={styles.status}>{item.status === "received" ? "وصل ولم يُركّب" : LAB_STATUS_LABEL[item.status]}</span></div>
       <p>طلب #{item.id} · {item.workType} · {item.labName}</p><p className={styles.muted}>{age.label}: {age.days === null ? "المدة غير معروفة" : `${age.days} يوم`}</p><p className={styles.nextAction}>{labBacklogNextAction(item.status)}</p></li>;
     })}</ul>
     {labs.data.total === 0 && <p className={styles.empty}>لا طلبات معمل مفتوحة مسجّلة.</p>}
     {labs.data.total > 3 && <p className={styles.sourceLine}>عرض أول 3 من {labs.data.total} طلب؛ جميع الحالات والتفاصيل في متابعة المعمل.</p>}
    </>}
   </section>
  </div>
  <LeadershipTasks compact />
  <nav className={styles.moduleLinks} aria-label="مصادر الإدارة"><a href="/appointments">المواعيد وأوقات الأطباء</a><a href="/waiting-list">انتظار موعد شاغر</a><a href="/requests">طلبات الحجز</a><a href="/inventory">المخزون والمشتريات</a><a href="/reports">التقارير</a><a href="/settings/audit">سجل الإجراءات</a></nav>
 </div>;
}
