"use client";

import { useEffect, useMemo, useState } from "react";
import { useClinicName, useSetting } from "@/components/SettingsProvider";
import { Icon, Logo } from "@/components/Icon";
import { friendlyDateNamed } from "@/lib/reminders";
import { addDays, clinicDateString, type DayLoad } from "@/lib/schedule";
import { appointmentsCountText, reportText, shortMinutes, type DayReport } from "@/lib/report";
import type { LabSummary } from "@/lib/lab";
import { PageHeader } from "@/components/PageHeader";
import { CLINIC_ZONE_FALLBACK } from "@/lib/clinicZone";
import styles from "./report.module.css";

/**
 * تقرير اليوم — أرقام الحضور، أزمنة الانتظار، إشغال الكراسي، وحمل الغد.
 */

interface PlannedTodayRow {
  id: number; patientId: number; patientName: string; patientNumber: string;
  title: string; doctorName: string | null; time: string | null;
  durationMinutes: number; status: string; appointmentId: number | null;
}

interface ReportFeed {
  date: string;
  nextDate: string;
  report: DayReport;
  tomorrow: DayLoad;
  lab: LabSummary;
  chairs: number;
  plannedToday?: PlannedTodayRow[];
}

/* نفس عقد مسار /api/report: YYYY-MM-DD. الفحص هنا ليس تكرارًا للخادم —
 * الخادم يُطبّع التاريخ الفاسد إلى «اليوم» بصمت، والشاشة لا ترسل أصلًا
 * طلبًا غامضًا يُطبَّع، ولا تعرض تقرير «اليوم» بتاريخٍ مُمسوحٍ من الحقل. */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** هل القيمة يومٌ حقيقي في التقويم — لا نصٌّ يطابق القالب فحسب (كـ 2026-13-45)؟ */
function isSelectableDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const calendar = new Date(Date.UTC(year, month - 1, day));
  return calendar.getUTCFullYear() === year
    && calendar.getUTCMonth() === month - 1
    && calendar.getUTCDate() === day;
}

/** المدة المختصرة مفصولة إلى رقمٍ كبير ووحدةٍ أصغر بجواره — لا «12 دقيقة»
 *  مدحوقةً في سطرٍ واحد داخل بطاقة لا تتجاوز ١٤٠ بكسلًا على الهاتف. */
function durationParts(minutes: number): { value: string; unit: string } {
  const text = shortMinutes(minutes);
  const split = text.lastIndexOf(" ");
  return split === -1 ? { value: text, unit: "" } : { value: text.slice(0, split), unit: text.slice(split + 1) };
}

/* الورق أبيض والحبر غالٍ: كل بطاقة تُطبع بلا ظلٍّ ولا خلفية ملوّنة، ولا
 * تُقسم بين صفحتين — الأرقام هي التي تُقرأ على الورق لا الزخرفة. */
const PAPER_CARD =
  "break-inside-avoid print:break-inside-avoid print:shadow-none print:border-slate-400 print:bg-white";

/** بطاقة رقمٍ محلية بالشاشة — نفس لغة StatCard المشتركة بصريًّا، لكن بحقن
 *  طباعةٍ ورقيةٍ ووحدةٍ منفصلة عن الرقم. تظل المشتركة كما هي لبقية الشاشات. */
function ReportStat({ label, value, unit, tone = "calm" }: {
  label: string;
  value: string;
  unit?: string;
  tone?: "calm" | "warn" | "bad";
}) {
  const tones = {
    calm: "border-slate-200 bg-white text-navy-900",
    warn: "border-warning-300 bg-warning-50 text-warning-900",
    bad: "border-danger-300 bg-danger-50 text-danger-900",
  }[tone];
  return (
    <div data-report-stat data-print-card className={`rounded-2xl border p-4 text-center shadow-xs ${PAPER_CARD} ${tones}`}>
      <p data-stat-value className="text-2xl font-bold leading-none">
        {value}
        {unit ? <span data-stat-unit className="ms-1.5 inline-block align-middle text-sm font-extrabold opacity-75">{unit}</span> : null}
      </p>
      <p data-stat-label className="mt-1.5 text-xs font-semibold leading-snug opacity-80">{label}</p>
    </div>
  );
}

/** زر الطباعة المحلي للشاشة — زرٌّ بحدٍّ وأيقونة وتسمية وحالة تركيز واضحة،
 *  ويختفي من الورقة. يُرسم فقط حين يوجد تقريرٌ صحيحٌ للتاريخ المختار، فلا
 *  زرَّ طباعة أثناء التحميل أو الخطأ أو عدم تطابق التاريخ. */
function ReportPrintButton() {
  return (
    <button
      type="button"
      data-testid="print-report"
      onClick={() => window.print()}
      className="inline-flex items-center gap-1.5 rounded-xl border border-navy-200 bg-white px-3 py-2 text-xs font-extrabold text-navy-800 shadow-xs transition-colors hover:bg-navy-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-navy-700 focus-visible:ring-offset-2 print:hidden"
    >
      <Icon name="print" className="h-4 w-4" />
      طباعة التقرير
    </button>
  );
}

export default function ReportPage() {
  const clinicName = useClinicName();
  const doctor = useSetting("clinic.lead_doctor");
  const doctorTitle = useSetting("clinic.lead_doctor_title");
  const phone = useSetting("clinic.phone");
  const address = useSetting("clinic.address");
  const today = useMemo(() => clinicDateString(new Date(), CLINIC_ZONE_FALLBACK), []);
  const [date, setDate] = useState(today);
  /* (هوية العرض) التقرير المحمول مقترنٌ بالتاريخ الذي طُلب له، فاختيارُ يومٍ
   * جديدًا يُخفي القديمَ في نفس الرسمة — قبل أن يعمل تأثيرُ React ويمسحه. */
  const [loadedFeed, setLoadedFeed] = useState<{ requestedDate: string; feed: ReportFeed } | null>(null);
  const [loading, setLoading] = useState(true);
  /* الخطأ أيضًا مقترنٌ بتاريخه: خطأُ يومٍ سابقٍ لا يُعرض تحت اختيارٍ جديد. */
  const [failure, setFailure] = useState<{ requestedDate: string; message: string } | null>(null);
  const [retry, setRetry] = useState(0);

  const dateSelectable = isSelectableDate(date);

  useEffect(() => {
    /* حقلٌ مُمسوح أو قيمةٌ فاسدة: لا طلبَ يُرسَل، ولا تقريرَ قديمَ يبقى، ولا
     * «جارٍ التحميل» بلا طلبٍ فعلّي. الاستعادة بزر «اليوم» أو بإدخال تاريخٍ صحيح. */
    if (!isSelectableDate(date)) {
      setLoadedFeed(null);
      setFailure(null);
      setLoading(false);
      return;
    }
    let active = true;
    const controller = new AbortController();
    async function load() {
      // تقريرٌ سابق لا يجوز أن يبقى مرئيًا أو قابلًا للطباعة أثناء تحميل جديد.
      setLoadedFeed(null);
      setFailure(null);
      setLoading(true);
      try {
        const response = await fetch(`/api/report?date=${date}`, {
          cache: "no-store", signal: controller.signal,
        });
        if (!active) return;
        const payload = await response.json();
        if (!active) return;
        if (!response.ok) throw new Error(payload?.message ?? "تعذّر التحميل.");
        /* استجابةٌ بتاريخٍ غير المطلوب خطأٌ صريح، لا تقريرٌ لليوم المختار:
         * الإلغاء وحده لا يحمي من ردٍّ متأخرٍ يجتاز الفحصَ ويعرض يومًا آخر. */
        if (payload?.date !== date) throw new Error("وصل تقريرٌ بتاريخٍ غير التاريخ المطلوب.");
        setLoadedFeed({ requestedDate: date, feed: payload as ReportFeed });
      } catch (loadError) {
        if (!active) return;
        setLoadedFeed(null);
        setFailure({
          requestedDate: date,
          message: loadError instanceof Error ? loadError.message : "تعذّر التحميل.",
        });
      } finally {
        if (active) setLoading(false);
      }
    }
    void load();
    return () => { active = false; controller.abort(); };
  }, [date, retry]);

  /* القيم المعروضة (والطباعة والمشاركة) مقيدة بالطلب الذي أنتجها، لا بتاريخ
   * الاستجابة المُطبَّع. ردٌّ متأخرٌ لا يظهر، ورسمةٌ بعد تغيير التاريخ وقبل
   * بدء التأثير لا تجد تقريرًا قديمًا متخفيًا تحت التاريخ الجديد. */
  const feed = loadedFeed?.requestedDate === date ? loadedFeed.feed : null;
  const error = failure?.requestedDate === date ? failure.message : null;
  const waiting = loading || (loadedFeed !== null && feed === null);

  const shareLink = useMemo(() => {
    if (!feed) return null;
    const text = reportText({
      clinicName,
      dateText: friendlyDateNamed(feed.date),
      report: feed.report,
      tomorrowPercent: feed.tomorrow.percent,
      lateLabOrders: feed.lab.late,
    });
    return `https://wa.me/?text=${encodeURIComponent(text)}`;
  }, [feed, clinicName]);

  return (
    <main data-testid="daily-report" className={`${styles.report} mx-auto max-w-4xl p-4 pb-24`}>
      {/* ترويسة الورقة الوحيدة: هوية المركز والعنوان وتاريخ التقرير — مرةً
          واحدة لا مرتين. التاريخ لا يظهر عليها إلا لتقريرٍ صحيحٍ وصل فعلًا،
          فلا ورقةً تحمل تاريخًا قديمًا تحت يومٍ جديد. */}
      <div data-testid="report-paper-header" className="mb-3 hidden print:block" dir="rtl">
        <div className="flex items-center gap-3 border-b-2 border-navy-900 pb-2">
          <Logo className="h-14 w-14 shrink-0" />
          <div className="min-w-0">
            <p className="text-base font-black leading-snug text-navy-950">{clinicName}</p>
            <p className="text-[10px] font-semibold text-slate-600">
              {doctor} — {doctorTitle}
            </p>
            <p className="text-[9px] text-slate-500">
              {address}
              {phone ? (
                <>
                  {address ? " · " : ""}
                  هاتف: <span dir="ltr">{phone}</span>
                </>
              ) : null}
            </p>
          </div>
          <div className="ms-auto shrink-0 text-end">
            <p className="text-xs font-bold text-navy-900">تقرير الأداء اليومي</p>
            {feed ? (
              <p data-testid="print-report-date" className="mt-0.5 text-[11px] font-bold text-navy-900">
                {friendlyDateNamed(feed.date)}
              </p>
            ) : null}
            {feed ? (
              <p className="mt-0.5 text-[9px] font-semibold text-slate-600">
                عدد الكراسي الفعالة: {feed.chairs}
              </p>
            ) : null}
          </div>
        </div>
      </div>

      {/* ترويسة الشاشة تختبئ من الورقة — العنوان عليها مرةً في ترويسة الطباعة. */}
      <div className="print:hidden">
        <PageHeader
          title="تقرير الأداء اليومي"
          subtitle="إحصاءات الحضور، أزمنة الانتظار، وحجوزات اليوم التالي"
        >
          {/* لا طباعة إلا لتقريرٍ صحيحٍ للتاريخ المختار — والطباعة من المتصفح
              نفسها لا تجد في الصفحة تقريرًا قديمًا لأن جسم التقرير غير موجود،
              ولا زرًّا تفاعليًّا على الورقة. */}
          {feed ? <ReportPrintButton /> : null}
        </PageHeader>
      </div>

      {/* شريط اختيار التاريخ — حقلٌ مسمّى، وبجانبه التاريخ المختار بنصٍّ عربيٍّ
          لا يُقرأ خطأً. تنسيق input[type=date] يتبع لغة نظام المستخدم لا
          لغة الشاشة، فالنصُّ العربيُّ المسمّى هو المرجع، والحقل أداة اختيار. */}
      <section
        aria-label="اختيار تاريخ التقرير"
        className="mb-4 rounded-2xl border border-slate-200 bg-white p-3 shadow-xs print:hidden"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              onClick={() => setDate((current) => addDays(current, -1))}
              disabled={!dateSelectable}
              className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-bold text-slate-700 hover:bg-slate-100 disabled:opacity-40"
            >
              ‹ اليوم السابق
            </button>
            <button
              onClick={() => setDate(today)}
              className={`rounded-xl px-3 py-1.5 text-xs font-bold transition-all ${
                date === today
                  ? "bg-navy-800 text-white shadow-xs"
                  : "border border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
              }`}
            >
              اليوم ({today})
            </button>
            <button
              onClick={() => setDate((current) => addDays(current, 1))}
              disabled={!dateSelectable || date >= today}
              className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-bold text-slate-700 hover:bg-slate-100 disabled:opacity-40"
            >
              اليوم التالي ›
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor="daily-report-date" className="text-xs font-bold text-slate-600">
              تاريخ التقرير
            </label>
            <input
              id="daily-report-date"
              type="date"
              value={date}
              onChange={(event) => setDate(event.target.value)}
              aria-invalid={!dateSelectable ? true : undefined}
              className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-extrabold text-navy-900 outline-none focus:border-navy-800 focus-visible:ring-2 focus-visible:ring-navy-700/40"
            />
            {dateSelectable ? (
              <p
                data-testid="selected-date-text"
                className="rounded-xl border border-navy-100 bg-navy-50 px-3 py-1.5 text-xs font-black text-navy-900"
              >
                {friendlyDateNamed(date)}
              </p>
            ) : null}
          </div>
        </div>
      </section>

      {dateSelectable && error ? (
        <div
          role="alert"
          data-state="error"
          className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-2.5 print:hidden"
        >
          <p className="flex items-center gap-1.5 text-xs font-bold text-red-700">
            <Icon name="alert" className="h-4 w-4 shrink-0" />
            {error}
          </p>
          <button
            type="button"
            onClick={() => setRetry((current) => current + 1)}
            className="rounded-xl border border-red-300 bg-white px-3 py-1.5 text-xs font-extrabold text-red-700 hover:bg-red-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-600 focus-visible:ring-offset-1"
          >
            أعد المحاولة
          </button>
        </div>
      ) : null}

      {!dateSelectable ? (
        <div
          role="alert"
          data-state="invalid-date"
          className="mb-4 flex items-start gap-1.5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-xs font-bold text-amber-900 print:hidden"
        >
          <Icon name="alert" className="mt-0.5 h-4 w-4 shrink-0" />
          <p>التاريخ المختار غير صالح — اختر تاريخًا صحيحًا أو اضغط «اليوم» لعرض تقرير اليوم.</p>
        </div>
      ) : null}

      {dateSelectable && waiting && !feed ? (
        <div
          data-state="loading"
          className="rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-xs print:hidden"
        >
          <Icon name="chart" className="mx-auto h-7 w-7 text-slate-300" />
          <p className="mt-2 text-xs font-bold text-slate-500">جارٍ إعداد التقرير اليومي…</p>
          <p className="mt-1 text-[11px] font-semibold text-slate-400">ليوم {friendlyDateNamed(date)}</p>
        </div>
      ) : feed ? (
        <div className="space-y-4">
          {/* لافتة الشاشة: اليوم المعروض بلا لبس — تختبئ من الورقة لأن ترويسة
              الطباعة تحمل التاريخ نفسه مرةً واحدة. */}
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-navy-100 bg-navy-50/50 p-3 print:hidden">
            <span className="text-xs font-black text-navy-900">
              تقرير يوم: {friendlyDateNamed(feed.date)}
            </span>
            <span className="text-[11px] font-bold text-slate-500">
              عدد الكراسي الفعالة: {feed.chairs}
            </span>
          </div>

          {/* يومٌ صحيحٌ بلا نشاط: تقريرٌ سليمٌ لا خطأ ولا انتظارٍ أبدي — وإثباتٌ
              مرئي على الشاشة والورقة أن لا شيء سُجّل، لا شاشةً فارغة بلا تفسير. */}
          {feed.report.arrived === 0 && feed.report.booked === 0 ? (
            <p
              data-state="empty-day"
              className={`rounded-2xl border border-slate-200 bg-white p-4 text-center text-xs font-bold text-slate-500 shadow-xs ${PAPER_CARD}`}
            >
              لا حضور ولا مواعيد مسجّلة في هذا اليوم — تقريرٌ صحيحٌ بلا نشاط.
            </p>
          ) : null}

          {/*
           * لوحة اليوم (§٢٦): زيارات اليوم المخطَّطة من خطط العلاج — من سيأتي، بأيّ
           * عنوان، ومع من. مدخلٌ واحد يفتح منه الطبيب عمل يومه من ملف المريض مباشرة.
           * على الورقة تبقى القائمة (الاسم والوقت والعنوان) وتختفي الأزرار والروابط.
           */}
          {feed.plannedToday && feed.plannedToday.length > 0 ? (
            <section
              aria-label="لوحة اليوم"
              data-print-card
              className={`rounded-2xl border border-navy-200 bg-white p-4 shadow-xs ${PAPER_CARD}`}
            >
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="text-xs font-black text-navy-900">
                  لوحة اليوم — زيارات مخطَّطة ({feed.plannedToday.length})
                </span>
                <a href="/appointments" className="text-[11px] font-bold text-navy-700 underline underline-offset-4 print:hidden">
                  كل المواعيد
                </a>
              </div>
              <ul className="space-y-1.5">
                {feed.plannedToday.slice(0, 8).map((row) => (
                  <li
                    key={row.id}
                    data-planned-row
                    className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-100 bg-slate-50/70 px-3 py-2 break-inside-avoid print:break-inside-avoid print:border-slate-300 print:bg-white"
                  >
                    <div className="min-w-0">
                      <p className="text-xs font-bold text-navy-900">
                        <span dir="ltr" className="ml-1 font-extrabold text-navy-700">{row.time ?? "—"}</span>
                        · {row.patientName}
                      </p>
                      <p className="text-[10px] text-slate-500 print:text-slate-700">
                        {row.title} · {row.durationMinutes} دقيقة
                        {row.doctorName ? ` · ${row.doctorName}` : ""}
                      </p>
                    </div>
                    <a
                      href={`/patients/${row.patientId}?tab=today`}
                      className={`rounded-xl px-3 py-1.5 text-[11px] font-extrabold print:hidden ${
                        row.status === "in_progress"
                          ? "bg-emerald-600 text-white"
                          : "bg-navy-800 text-white"
                      }`}
                    >
                      {row.status === "in_progress" ? "زيارة قائمة — افتحها" : "افتح الملف"}
                    </a>
                  </li>
                ))}
              </ul>
              {feed.plannedToday.length > 8 ? (
                <p className="mt-2 text-center text-[10px] text-slate-400 print:text-slate-600">
                  و{feed.plannedToday.length - 8} زيارة أخرى — تُعرض في المواعيد
                </p>
              ) : null}
            </section>
          ) : null}

          {/* ── سياق ١: أداء اليوم المختار نفسه — لا رقمٌ من يومٍ آخر ─────────── */}
          <section
            aria-label="أداء اليوم المختار"
            data-print-card
            className={`rounded-2xl border border-slate-200 bg-white p-4 shadow-xs ${PAPER_CARD}`}
          >
            <div className="mb-3">
              <h2 className="text-xs font-black text-navy-900">
                أداء اليوم المختار
                <span className="print:hidden"> — {friendlyDateNamed(feed.date)}</span>
              </h2>
              <p className="mt-0.5 text-[11px] font-medium text-slate-500 print:text-slate-700">
                أرقام الحضور والانتظار ليوم التقرير نفسه.
              </p>
            </div>

            {/* الحضور */}
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3" aria-label="الحضور">
              <ReportStat label="إجمالي الحضور" value={String(feed.report.arrived)} />
              <ReportStat label="اكتملت زيارتهم" value={String(feed.report.done)} />
              <ReportStat
                label="لم يحضروا"
                value={String(feed.report.noShow)}
                tone={feed.report.noShow > 0 ? "warn" : "calm"}
              />
            </div>

            {/* أزمنة الانتظار والتشغيل — الرقم كبيرًا و«دقيقة» وحدةً مرئية بجواره */}
            <div className="mt-2.5 grid grid-cols-2 gap-2.5 sm:grid-cols-3" aria-label="الانتظار">
              <ReportStat
                label="متوسط وقت الانتظار"
                {...durationParts(feed.report.averageWaitMinutes)}
                tone={
                  feed.report.averageWaitMinutes >= 30
                    ? "bad"
                    : feed.report.averageWaitMinutes >= 15
                    ? "warn"
                    : "calm"
                }
              />
              <ReportStat
                label="أطول وقت انتظار"
                {...durationParts(feed.report.longestWaitMinutes)}
                tone={
                  feed.report.longestWaitMinutes >= 45
                    ? "bad"
                    : feed.report.longestWaitMinutes >= 20
                    ? "warn"
                    : "calm"
                }
              />
              <ReportStat
                label="متوسط الجلسة على الكرسي"
                {...durationParts(feed.report.averageChairMinutes)}
              />
            </div>
          </section>

          {/* ── سياق ٢: حجوزات اليوم التالي ليوم التقرير — بتاريخٍ صريحٍ لا
              «الغد» التي تُوهم بأنه غد اليوم الحقيقي وأنت تستعرض الماضي ───── */}
          <section
            aria-label="حجوزات اليوم التالي"
            data-print-card
            className={`rounded-2xl border border-slate-200 bg-white p-4 shadow-xs ${PAPER_CARD}`}
          >
            <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
              <div>
                <h2 className="text-xs font-black text-navy-900">
                  حجوزات اليوم التالي — {friendlyDateNamed(feed.nextDate)}
                </h2>
                <p className="mt-0.5 text-[11px] font-medium text-slate-500 print:text-slate-700">
                  اليوم التالي ليوم التقرير
                  <span className="print:hidden"> ({friendlyDateNamed(feed.date)})</span>
                  {" "}— نسبة الإشغال مقاسة بطاقة الكراسي وساعات الدوام.
                </p>
              </div>
              <span
                data-testid="report-occupancy-badge"
                className={`rounded-xl px-3 py-1 text-xs font-extrabold print:border print:border-slate-400 print:bg-white print:text-black ${
                  feed.tomorrow.percent >= 90
                    ? "bg-red-700 text-white"
                    : feed.tomorrow.percent >= 70
                    ? "bg-amber-200 text-amber-900"
                    : "bg-emerald-100 text-emerald-800"
                }`}
              >
                إشغال {feed.tomorrow.percent}٪
              </span>
            </div>

            {/* النص قبل الشريط: عددٌ بوحدته ونسبةٌ بوحدتها — الشريط يُقرأ بالأرقام
                لا باللون وحده، ويمتلئ من اليمين إلى اليسار كاتجاه الشاشة. */}
            <p className="text-xs font-bold text-slate-600 print:text-black">
              المحجوز: {appointmentsCountText(feed.tomorrow.booked)} — {feed.tomorrow.percent}٪ من طاقة اليوم
            </p>
            <div
              data-testid="report-occupancy-track"
              className="mt-2 h-3 w-full overflow-hidden rounded-full border border-slate-200 bg-slate-100 print:border-slate-400 print:bg-white"
              aria-hidden="true"
            >
              <div
                data-testid="report-occupancy-fill"
                className={`h-full transition-all duration-300 print:bg-slate-400 ${
                  feed.tomorrow.percent >= 90
                    ? "bg-red-500"
                    : feed.tomorrow.percent >= 70
                    ? "bg-amber-400"
                    : "bg-emerald-500"
                }`}
                style={{ width: `${Math.min(100, feed.tomorrow.percent)}%` }}
              />
            </div>
            <div className="mt-1 flex justify-between text-[10px] font-bold text-slate-400 print:text-slate-600" aria-hidden="true">
              <span>0٪</span>
              <span>100٪</span>
            </div>
          </section>

          {/* ── سياق ٣: حالة أعمال المختبر الآن. أرقام المختبر تبقى بدلالتها
              الحالية (حالة المختبر الآن) كما يرسلها المسار — لا تُحوَّل تلقائيًا
              إلى أرقامٍ تاريخية، والتصميم يقول ذلك صراحةً لا يتركه تخمينًا ── */}
          <section
            aria-label="أعمال المختبر الآن"
            data-print-card
            className={`rounded-2xl border border-slate-200 bg-white p-4 shadow-xs ${PAPER_CARD}`}
          >
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-xs font-black text-navy-900">أعمال المختبر — الحالة الآن</h2>
                <p className="mt-0.5 text-[11px] font-medium text-slate-500 print:text-slate-700">
                  هذه الأرقام تعكس وضع المختبر لحظة فتح التقرير، وليست رصيد يوم التقرير.
                </p>
              </div>
              <a
                href="/lab"
                className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-[11px] font-extrabold text-navy-800 hover:bg-slate-50 print:hidden"
              >
                فتح شاشة المختبر
              </a>
            </div>
            <ul className="space-y-1.5">
              <li
                className={`flex items-center gap-2 rounded-xl border px-3 py-2.5 text-xs font-bold break-inside-avoid print:break-inside-avoid print:border-slate-400 print:bg-white ${
                  feed.lab.late > 0
                    ? "border-danger-200 bg-danger-50 text-danger-800"
                    : "border-slate-200 bg-slate-50 text-slate-700"
                }`}
              >
                <Icon name="flask" className="h-4 w-4 shrink-0" />
                <span>تراكيب متأخرة بالمختبر: {feed.lab.late}</span>
              </li>
              <li className="flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-xs font-bold text-slate-700 break-inside-avoid print:break-inside-avoid print:border-slate-400 print:bg-white">
                <Icon name="box" className="h-4 w-4 shrink-0" />
                <span>جاهزة للتركيب: {feed.lab.waitingFitting}</span>
              </li>
            </ul>
          </section>

          {/* ── سياق ٤: المواعيد غير المغلقة التابعة لتاريخ التقرير نفسه ─────── */}
          {feed.report.unresolved > 0 ? (
            <section
              aria-label="مواعيد غير مغلقة"
              data-print-card
              className={`rounded-2xl border border-amber-200 bg-amber-50/60 p-4 shadow-xs ${PAPER_CARD}`}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="flex items-center gap-1.5 text-xs font-bold text-amber-900 print:text-black">
                  <Icon name="alert" className="h-4 w-4 shrink-0" />
                  مواعيد غير مغلقة ليوم التقرير: {feed.report.unresolved}
                </p>
                <a
                  href="/appointments"
                  className="rounded-xl border border-amber-300 bg-white px-3 py-1.5 text-[11px] font-extrabold text-amber-900 hover:bg-amber-100 print:hidden"
                >
                  متابعتها في المواعيد
                </a>
              </div>
            </section>
          ) : null}

          {/* زر مشاركة التقرير — لا يُجهَّز الرابط إلا لتقريرٍ صحيحٍ للتاريخ المختار. */}
          {shareLink ? (
            <a
              href={shareLink}
              target="_blank"
              rel="noopener"
              className="flex items-center justify-center gap-2 rounded-2xl bg-[#25D366] py-3 text-center text-xs font-black text-white shadow-2xs transition-opacity hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-700 focus-visible:ring-offset-2 print:hidden"
            >
              <Icon name="send" className="h-4 w-4" />
              إرسال ملخص التقرير عبر واتساب لإدارة المركز
            </a>
          ) : null}
        </div>
      ) : null}
    </main>
  );
}
