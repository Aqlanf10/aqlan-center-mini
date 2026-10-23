"use client";

import { useEffect, useRef, useState } from "react";
import { useSession } from "../SessionProvider";
import { STATUS_LABEL } from "@/lib/appointment-lifecycle";
import { canReadOperationalOverview, decodeOperationalOverview, OPERATIONAL_PAGE_SIZE, operationalPatientHref,
  type OperationalItem, type OperationalLane, type OperationalOverview, type OperationalSection, type OperationalSource } from "@/lib/leadership-operations";

const button = "cursor-pointer rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-bold text-navy-800 hover:bg-navy-50 active:bg-navy-100 disabled:cursor-not-allowed disabled:opacity-50";
const sourceTitle: Record<OperationalSource, string> = {
  appointments: "مواعيد لم يحضر أصحابها أو أُلغيت",
  referrals: "نتائج إحالات بانتظار مراجعة الطبيب",
};
const stateLabel: Record<OperationalItem["state"], string> = {
  needs_review: "يحتاج مراجعة؛ لا دليل حجز بديل مرتبط",
  history_review: "تعارض في الحضور أو الروابط؛ راجع السجل",
  replacement_active: "حجز بديل قائم موثّق",
  replacement_finished: "الحجز البديل انتهى بحسب حالة الموعد",
  replacement_terminal: "الحجز البديل أيضًا لم يحضر صاحبه أو أُلغي",
  awaiting_referrer: "النتيجة مسجّلة؛ لم تُسجّل مراجعة الطبيب",
};
const appointmentStatus = (status: string) => STATUS_LABEL[status as keyof typeof STATUS_LABEL] ?? (status === "in_progress" ? "قيد العلاج" : "حالة تحتاج مراجعة");
function instant(value: string, timeZone: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat("ar-YE", {
    timeZone, dateStyle: "short", timeStyle: "short",
  }).format(date) : "وقت غير معروف";
}

/** Session-keyed child: logout/role or account changes unmount pending reads and all patient data. */
export function LeadershipOperationalOverview() {
  const session = useSession();
  if (!session || !canReadOperationalOverview(session.role)) return null;
  return <OperationalOverviewPanel key={`${session.username}:${session.role}`} />;
}

export function OperationalOverviewPanel() {
  const [day, setDay] = useState("");
  const [lane, setLane] = useState<OperationalLane>("all");
  const [pages, setPages] = useState({ appointments: 0, referrals: 0 });
  const [revision, setRevision] = useState(0);
  const [read, setRead] = useState<{ key: string; data: OperationalOverview | null; error: string | null }>({ key: "", data: null, error: null });
  const [stale, setStale] = useState(false);
  const sequence = useRef(0);
  const initialDay = useRef("");
  const requestKey = JSON.stringify([day, lane, pages.appointments, pages.referrals, revision]);
  const current = read.key === requestKey;
  const data = current ? read.data : null;
  const error = current ? read.error : null;
  const loading = !current || (!data && !error);
  const refresh = () => { setStale(false); setRevision(value => value + 1); };

  useEffect(() => {
    const request = ++sequence.current;
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 20_000);
    const params = new URLSearchParams({ lane, appointmentPage: String(pages.appointments), referralPage: String(pages.referrals) });
    if (day || initialDay.current) params.set("day", day || initialDay.current);
    setStale(false);
    void (async () => {
      try {
        const response = await fetch(`/api/executive/operations?${params}`, { cache: "no-store", signal: controller.signal });
        const payload = await response.json();
        if (!response.ok) throw new Error(response.status === 401 || response.status === 403
          ? "انتهت الجلسة أو تغيّرت الصلاحية. سجّل الدخول من جديد." : "تعذّر تحميل المراجعة التشغيلية. أعد المحاولة.");
        const verified = decodeOperationalOverview(payload, params.get("day"), lane);
        if (!verified) throw new Error("تعذّر التحقق من نتيجة القراءة. أعد المحاولة.");
        if (request === sequence.current && !controller.signal.aborted) {
          initialDay.current = verified.day;
          setRead({ key: requestKey, data: verified, error: null });
        }
      } catch (failure) {
        if (request !== sequence.current || (controller.signal.aborted && !timedOut)) return;
        setRead({ key: requestKey, data: null, error: timedOut ? "استغرقت القراءة وقتًا طويلًا. العدد غير معروف؛ أعد المحاولة."
          : failure instanceof Error ? failure.message : "تعذّر تحميل المراجعة التشغيلية. أعد المحاولة." });
      } finally { clearTimeout(timeout); }
    })();
    return () => { clearTimeout(timeout); controller.abort(); };
  }, [requestKey, day, lane, pages.appointments, pages.referrals]);

  useEffect(() => {
    const markStale = () => setStale(true);
    const onVisibility = () => { if (document.visibilityState === "visible") markStale(); };
    window.addEventListener("focus", markStale);
    window.addEventListener("online", markStale);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("focus", markStale);
      window.removeEventListener("online", markStale);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return <section aria-labelledby="operational-title" className="mb-6 rounded-2xl border border-navy-200 bg-white p-4 sm:p-5" data-testid="leadership-operations">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="mb-1 text-xs font-bold text-navy-600">مراجعة الإدارة · قراءة فقط</p>
        <h2 id="operational-title" className="text-lg font-black text-navy-900">ما الذي يحتاج مراجعة؟</h2>
      </div>
      <button type="button" className={button} onClick={refresh} disabled={loading}>تحديث القراءة</button>
    </div>
    <p id="operational-scope" className="mt-2 text-sm leading-6 text-slate-600">
      الحالة الحالية لأحداث اليوم المختار؛ ليست قائمة بكل المتابعات المتراكمة.
    </p>
    <div className="mt-4 flex flex-wrap items-end gap-3">
      <label className="flex flex-col gap-1 text-sm font-bold text-slate-700" htmlFor="operational-day">
        يوم الموعد / اكتمال الإحالة
        <input id="operational-day" type="date" value={day || initialDay.current || data?.day || ""} className="min-h-11 rounded-lg border border-slate-200 px-3 py-2"
          onChange={event => { initialDay.current = ""; setDay(event.target.value); setPages({ appointments: 0, referrals: 0 }); }} aria-describedby="operational-scope" />
      </label>
      <fieldset className="min-w-0">
        <legend className="mb-1 text-sm font-bold text-slate-700">نوع السجلات</legend>
        <div className="flex flex-wrap gap-2">
          {([["all", "الكل"], ["reception", "المواعيد"], ["doctor", "الإحالات"]] as const).map(([value, label]) =>
            <button key={value} type="button" aria-pressed={lane === value} onClick={() => { setLane(value); setPages({ appointments: 0, referrals: 0 }); }}
              className={`${button} ${lane === value ? "border-navy-800 bg-navy-50" : ""}`}>{label}</button>)}
        </div>
      </fieldset>
    </div>
    {data && <p className="mt-3 text-xs font-bold text-slate-600">يوم الأحداث: <bdi>{data.day}</bdi> · توقيت العيادة: <bdi>{data.timeZone}</bdi> · لقطة قراءة، لا تحديث مباشر</p>}
    {stale && data && <p role="status" className="mt-3 rounded-xl border border-warning-200 bg-warning-50 p-3 text-sm text-warning-900">قد تكون السجلات تغيّرت أثناء غيابك. حدّث القراءة قبل اتخاذ قرار.</p>}
    <div className="mt-4 min-h-24" aria-busy={loading}>
      {loading && <p role="status" className="py-5 text-sm text-slate-500">جارٍ التحقق من المصادر التشغيلية… الأعداد غير معروفة بعد.</p>}
      {error && <p role="alert" className="rounded-xl border border-warning-200 bg-warning-50 p-3 text-sm text-warning-900">{error} لا تُعرض أعداد قديمة أو أصفار بدل الخطأ.</p>}
      {data && <div className="space-y-5">{data.sections.map(section => <OperationalSourceSection key={section.source} section={section} timeZone={data.timeZone}
        onPage={page => setPages(value => ({ ...value, [section.source]: page }))} onRetry={refresh} />)}</div>}
    </div>
    <details className="mt-4 border-t border-slate-100 pt-3 text-xs leading-6 text-slate-600">
      <summary className="cursor-pointer font-bold text-navy-800">كيف تُقرأ هذه القائمة؟</summary>
      <p className="mt-2">هذه قراءة للحالة الحالية، لا إعادة بناء لحالة يوم سابق. عدد المواعيد يشمل ما له حجز بديل، وليس عدد المتابعات غير المعالجة. الإلغاء لا يعني أن المريض تغيّب، ووقت الموعد الأصلي ليس موعدًا نهائيًا للمتابعة.</p>
      <p className="mt-2">مراجعة الحجز من إجراءات الاستقبال والإدارة، ومراجعة نتائج الإحالة من إجراءات الطبيب المحدد والإدارة بحسب الصلاحيات الحالية. اسم الطبيب سياق في السجل، لا إسناد أو قبول مسؤولية؛ لا يوجد مالك متابعة أو موعد نهائي مثبت هنا.</p>
      <p className="mt-2">فتح الملف لا يغلق المتابعة. الحجز البديل أو مراجعة الطبيب لا يثبتان اكتمال العلاج. شاشة اليوم تبقى مكان الوصول والتأخر وعدم الحضور. إسناد المتابعة ونتيجتها والتنبيهات خارج هذه المرحلة.</p>
    </details>
  </section>;
}

export function OperationalSourceSection({ section, timeZone, onPage, onRetry }: {
  section: OperationalSection; timeZone: string; onPage: (page: number) => void; onRetry: () => void;
}) {
  return <section aria-labelledby={`operational-${section.source}`} className="rounded-xl border border-slate-200 p-3 sm:p-4">
    <h3 id={`operational-${section.source}`} className="text-sm font-black text-navy-900">{sourceTitle[section.source]}</h3>
    {section.status === "error" ? <div role="alert" className="mt-3 text-sm text-warning-900">
      <p>{section.message}</p><button type="button" className={`${button} mt-2`} onClick={onRetry}>إعادة التحقق</button>
    </div> : <>
      <p className="mt-1 text-xs leading-5 text-slate-500">المصدر: {section.source === "appointments" ? "المواعيد وروابط الجلسات وسجل إعادة الحجز" : "حالة الإحالة الداخلية"} · وقت القراءة: <bdi>{instant(section.asOf, timeZone)}</bdi></p>
      <p className="mt-2 text-sm font-bold text-slate-700">{section.total} {section.source === "appointments" ? "موعدًا ضمن اليوم (يشمل ما له حجز بديل)" : "نتيجة بانتظار مراجعة الطبيب ضمن هذا اليوم"}</p>
      {section.items.length === 0 ? <p className="mt-3 text-sm text-slate-500">لا سجلات مطابقة لهذا المصدر واليوم. هذا لا ينفي وجود متابعات في أيام أخرى.</p>
        : <ul className="mt-3 divide-y divide-slate-100">{section.items.map(item => <li key={item.id} className="py-3 first:pt-0 last:pb-0">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0 break-words">
              <p className="text-sm font-bold text-navy-900">{item.patientName} <bdi className="text-xs font-normal text-slate-500">{item.patientNumber}</bdi></p>
              <p className="mt-1 text-xs text-slate-600">{section.source === "appointments" ? `موعد #${item.id} · ${appointmentStatus(item.status)} · ${item.eventAt}` : `إحالة #${item.id} · اكتملت: ${instant(item.eventAt, timeZone)}`}</p>
            </div>
            <a className={button} href={operationalPatientHref(item, section.source)}>{section.source === "appointments" ? "مراجعة الملخص والمواعيد" : "مراجعة الإحالات"}</a>
          </div>
          <p className="mt-2 text-sm font-bold text-navy-800">{stateLabel[item.state]}</p>
          {item.replacement && <details className="mt-1 text-xs leading-5 text-slate-600"><summary className="cursor-pointer font-bold text-navy-800">تفاصيل الحجز البديل</summary><p className="mt-1 break-words">موعد #{item.replacement.id} · <bdi>{item.replacement.date} {item.replacement.time}</bdi> · {appointmentStatus(item.replacement.status)} · سجل #{item.replacement.auditId} بتاريخ <bdi>{instant(item.replacement.recordedAt, timeZone)}</bdi>{item.plannedVisitId ? ` · جلسة #${item.plannedVisitId}` : ""}</p></details>}
          {section.source === "referrals" && <p className="mt-1 text-xs leading-5 text-slate-600">طبيب مراجعة النتيجة: {item.reviewDoctor || "غير محدّد في السجل"}.</p>}
        </li>)}</ul>}
      {section.total > 0 && <nav aria-label={`صفحات ${sourceTitle[section.source]}`} className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-3">
        <span className="text-xs text-slate-500">عرض {section.page * OPERATIONAL_PAGE_SIZE + 1}–{section.page * OPERATIONAL_PAGE_SIZE + section.items.length} من {section.total}</span>
        <div className="flex gap-2"><button type="button" className={button} disabled={section.page === 0} onClick={() => onPage(section.page - 1)}>السابق</button>
          <button type="button" className={button} disabled={!section.hasMore} onClick={() => onPage(section.page + 1)}>التالي</button></div>
      </nav>}
    </>}
  </section>;
}
