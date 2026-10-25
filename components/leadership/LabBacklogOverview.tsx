"use client";

import { useEffect, useRef, useState } from "react";
import { useSession } from "../SessionProvider";
import styles from "./leadership.module.css";
import { LAB_STATUS_LABEL } from "@/lib/lab";
import { canReadLabBacklog, decodeLabBacklog, LAB_BACKLOG_FILTERS, LAB_BACKLOG_FILTER_LABEL,
  labBacklogAge, labBacklogNextAction, labBacklogPatientHref, type LabBacklogFilter, type LabBacklogItem,
  type LabBacklogSnapshot } from "@/lib/lab-backlog";

const button = styles.smallButton;
const at = (value: string, timeZone: string) => new Intl.DateTimeFormat("ar-YE", { timeZone, dateStyle: "short", timeStyle: "short" }).format(new Date(value));
const taskStatus = { planned: "مخططة", in_progress: "قيد التنفيذ", blocked: "متوقفة" };
const eventLabel: Record<string, string> = { create: "إنشاء الطلب", status_change: "تغيير الحالة", due_date: "تغيير الموعد",
  due_date_change: "تغيير الموعد", quality_check: "فحص المطابقة", accounting_updated: "تحديث محاسبي", accounting_posted: "ترحيل محاسبي", remake: "تسجيل إعادة", marked_for_remake: "تسجيل الحاجة إلى إعادة تصنيع", created_as_remake: "إنشاء طلب إعادة تصنيع" };

/** Separate from the selected-day operational view: old open orders must not disappear. */
export function LabBacklogOverview() {
  const session = useSession();
  if (!session || !canReadLabBacklog(session.role)) return null;
  return <LabBacklogPanel key={`${session.username}:${session.role}`} />;
}
export function LabBacklogPanel() {
  const [filter, setFilter] = useState<LabBacklogFilter>("all");
  const [page, setPage] = useState(0);
  const [revision, setRevision] = useState(0);
  const [stale, setStale] = useState(false);
  const [read, setRead] = useState<{ key: string; data: LabBacklogSnapshot | null; error: string | null }>({ key: "", data: null, error: null });
  const sequence = useRef(0), key = JSON.stringify([filter, page, revision]);
  const data = read.key === key ? read.data : null, error = read.key === key ? read.error : null;
  const loading = !data && !error;
  useEffect(() => {
    const request = ++sequence.current, controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 20000);
    void (async () => {
      try {
        const response = await fetch(`/api/lab/backlog?filter=${filter}&page=${page}`, { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error(response.status === 401 || response.status === 403
          ? "انتهت الجلسة أو تغيّرت الصلاحية. أعد تسجيل الدخول." : "تعذّر التحقق من التراكيب المفتوحة؛ الأعداد غير معروفة.");
        const result = decodeLabBacklog(await response.json(), filter);
        if (!result) throw new Error("تعذّر التحقق من نتيجة القراءة؛ الأعداد غير معروفة.");
        if (request === sequence.current && !controller.signal.aborted) setRead({ key, data: result, error: null });
      } catch (failure) {
        if (request !== sequence.current || controller.signal.aborted && !timedOut) return;
        setRead({ key, data: null, error: timedOut ? "استغرقت القراءة وقتًا طويلًا؛ الأعداد غير معروفة. أعد المحاولة."
          : failure instanceof Error ? failure.message : "تعذّر تحميل المتابعة." });
      } finally { clearTimeout(timeout); }
    })();
    return () => { clearTimeout(timeout); controller.abort(); };
  }, [key, filter, page]);
  useEffect(() => {
    const mark = () => setStale(true), visible = () => { if (document.visibilityState === "visible") mark(); };
    window.addEventListener("focus", mark); window.addEventListener("online", mark); document.addEventListener("visibilitychange", visible);
    return () => { window.removeEventListener("focus", mark); window.removeEventListener("online", mark); document.removeEventListener("visibilitychange", visible); };
  }, []);
  return <section className={styles.panel} aria-labelledby="lab-backlog-title" data-testid="lab-backlog">
    <div className={styles.sectionHeading}>
      <h2 id="lab-backlog-title" className={styles.recordHeading}>متابعة التركيبات والمعمل</h2>
      <button className={button} type="button" disabled={loading} onClick={() => { setStale(false); setRevision(value => value + 1); }}>تحديث متابعة المعمل</button>
    </div>
    <p className="mt-2 text-sm leading-6 text-slate-600">كل الطلبات المفتوحة الآن، مهما كان تاريخها. لا تتأثر بيوم المراجعة أو الفترة المالية، والوصول لا يعني اكتمال التركيب.</p>
    <p className="mt-1 text-xs leading-6 text-slate-500">قراءة للسجلات لا حكم على سبب التأخير أو تقصير شخص. الطبيب المعالج، المسؤول المسند، وآخر من سجّل إجراءً أدوار مختلفة.</p>
    <div className={styles.pillGroup} role="group" aria-label="حالة انتظار المعمل">
      {LAB_BACKLOG_FILTERS.map(value => <button key={value} type="button" aria-pressed={filter === value}
        className={button} onClick={() => { setFilter(value); setPage(0); setStale(false); }}>{LAB_BACKLOG_FILTER_LABEL[value]}</button>)}
    </div>
    <div className="mt-4" aria-busy={loading}>
      {loading && <p role="status">جارٍ التحقق… الأعداد غير معروفة بعد.</p>}
      {error && <p role="alert" className={styles.error}>{error}</p>}
      {data && <>
        <p className="text-xs text-slate-500">لقطة: {at(data.asOf, data.timeZone)} · توقيت العيادة: <bdi>{data.timeZone}</bdi></p>
        {stale && <p role="status" className={styles.stale}>قد تكون السجلات تغيّرت؛ حدّث القراءة قبل اتخاذ قرار.</p>}
        <p className="my-3 text-sm font-bold">{data.counts.patients} مريض · {data.counts.orders} طلب مفتوح: {data.counts.preparing} لم يُرسل · {data.counts.withLab} عند المعمل، منها {data.counts.overdue} متأخرة · {data.counts.awaitingFitting} وصلت ولم تُركّب</p>
        {data.total === 0 ? <p className="py-3 text-sm text-slate-600">لا توجد طلبات مفتوحة تطابق المرشح.</p>
          : <ul className={styles.recordGrid}>{data.items.map(item => <li key={item.id}><LabBacklogOrder item={item} today={data.today} timeZone={data.timeZone} /></li>)}</ul>}
        {data.total > 0 && <nav aria-label="صفحات متابعة المعمل" className="mt-4 flex flex-wrap items-center justify-between gap-2">
          <button type="button" className={button} disabled={data.page === 0} onClick={() => setPage(data.page - 1)}>السابق</button>
          <span className="text-sm">صفحة {data.page + 1} · {data.total} طلب مطابق</span>
          <button type="button" className={button} disabled={!data.hasMore} onClick={() => setPage(data.page + 1)}>التالي</button>
        </nav>}
      </>}
    </div>
    <p className="mt-4 border-t border-slate-100 pt-3 text-xs leading-6 text-slate-500">القائمة تشمل طلبات المعمل المسجّلة فقط. علاج قديم بلا طلب مرتبط يحتاج مراجعة الملف، لا إنشاء تاريخ إرسال أو وصول افتراضي. فتح الملف أو إنجاز مهمة متابعة لا يثبت التركيب ولا يغلق الطلب.</p>
  </section>;
}
export function LabBacklogOrder({ item, today, timeZone }: { item: LabBacklogItem; today: string; timeZone: string }) {
  const age = labBacklogAge(item, today, timeZone);
  return <article className={styles.recordCard} id={`backlog-order-${item.id}`}>
    <div className={styles.sectionHeading}>
      <a className="font-bold text-navy-900 underline" href={labBacklogPatientHref(item.patientId)}>{item.patientName} · {item.patientNumber ?? "دون رقم ملف"}</a>
      <span className={styles.status}>{item.status === "received" ? "وصل إلى العيادة؛ بانتظار المراجعة والتركيب" : LAB_STATUS_LABEL[item.status]}</span>
    </div>
    <p className="mt-2 text-sm">طلب #{item.id} · {item.workType} · الأسنان: <bdi>{item.teeth ?? "غير موثقة"}</bdi> · المعمل: {item.labName}</p>
    <p className="mt-1 text-xs text-slate-600">الطبيب المسجّل: {item.doctorName ?? "غير موثق"} · {age.label}: {age.days === null ? "المدة غير معروفة" : `${age.days} يوم`}</p>
    {item.status !== "needed" && <p className="mt-1 text-xs text-slate-600">الإرسال المسجّل: <bdi>{item.sentDate}</bdi> · الوصول المتوقع المسجّل: <bdi>{item.dueDate}</bdi></p>}
    {item.status === "received" && <p className="mt-1 text-xs text-slate-600">الوصول المسجّل: {item.receivedAt ? at(item.receivedAt, timeZone) : "غير موثق؛ لا نستخدم تاريخ الإرسال بدلًا منه"}</p>}
    <p className="mt-2 text-sm font-bold text-navy-800">الخطوة المقترحة: {labBacklogNextAction(item.status)}</p>
    <details className={styles.recordDetails}>
      <summary className="min-h-11 cursor-pointer py-2 font-bold text-navy-800">سجل الطلب #{item.id} والمسؤولية المسندة</summary>
      {item.latestAction ? <p className="text-xs leading-6">آخر حدث في سجل الطلب: {eventLabel[item.latestAction.action] ?? item.latestAction.action}
        {item.latestAction.toStatus ? ` ← ${LAB_STATUS_LABEL[item.latestAction.toStatus as keyof typeof LAB_STATUS_LABEL] ?? item.latestAction.toStatus}` : ""}
        {` · المسجّل: ${item.latestAction.actor} · ${at(item.latestAction.at, timeZone)}`}. لا يُعدّ ذلك إسناد مسؤولية المتابعة إليه.</p>
        : <p className="text-xs">لا يوجد حدث تتبع مسجّل لهذا الطلب؛ تاريخ إنشاء السجل: {at(item.createdAt, timeZone)}.</p>}
      {item.tasks.length === 0 ? <p className="mt-2 text-xs">لا توجد مهمة متابعة مفتوحة ظاهرة لك. لا نستنتج مسؤولًا أو موعد متابعة.</p>
        : <><p className="mt-2 text-xs">المتابعات المفتوحة الظاهرة لك: {item.visibleTaskCount}{item.visibleTaskCount > 3 ? "؛ معروضة أول 3 حسب الاستحقاق" : ""}.</p>
          <ul className="mt-2 space-y-2">{item.tasks.map(task => <li key={task.id} className="rounded-lg bg-slate-50 p-2 text-xs leading-6">
            مهمة #{task.id}: {task.title} · {taskStatus[task.status]}<br />
            المسؤول المسند في المهمة: {task.assignee ?? "غير مسند"} · الاستحقاق: {task.dueAt ? at(task.dueAt, timeZone) : "غير محدد"}<br />
            آخر تحديث للمهمة: {at(task.updatedAt, timeZone)}. هذا ليس دليل اتصال أو موعد تركيب.
          </li>)}</ul></>}
      <div className="mt-2 flex flex-wrap gap-3 text-xs font-bold"><a className="underline" href={labBacklogPatientHref(item.patientId)}>فتح ملف المريض · المعمل والتركيبات</a><a className="underline" href="/hr?tab=tasks">فتح المهام المسندة</a></div>
      <p className="mt-2 text-xs text-slate-500">لا يوجد هنا ربط موثّق بين الطلب وموعد محدد؛ راجع المواعيد في الملف. عدم وجود هذا الربط لا يثبت غياب المريض.</p>
    </details>
  </article>;
}
