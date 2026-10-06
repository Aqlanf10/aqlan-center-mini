"use client";

import { useEffect, useMemo, useState } from "react";
import { useClinicName, useSetting } from "@/components/SettingsProvider";
import { Logo } from "@/components/Icon";
import { friendlyDateLong } from "@/lib/reminders";
import { addDays, clinicDateString, type DayLoad } from "@/lib/schedule";
import { appointmentsCountText, reportText, shortMinutes, type DayReport } from "@/lib/report";
import type { LabSummary } from "@/lib/lab";
import { PageHeader, StatCard as Stat } from "@/components/PageHeader";
import { PrintButton } from "@/components/PrintButton";
import { CLINIC_ZONE_FALLBACK } from "@/lib/clinicZone";

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
 * طلبًا غامضًا يُطبَّع، ولا تعرض تقرير «اليوم» بتاريخٍ مُمسوحٍ من الحقل. */
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
   * الاستجابة المُطبَّع. ردٌّ متأخرٌ لا يظهر، ورسمةٌ بعد تغيير التاريخ وقبل
   * بدء التأثير لا تجد تقريرًا قديمًا متخفيًا تحت التاريخ الجديد. */
  const feed = loadedFeed?.requestedDate === date ? loadedFeed.feed : null;
  const error = failure?.requestedDate === date ? failure.message : null;
  const waiting = loading || (loadedFeed !== null && feed === null);

  const shareLink = useMemo(() => {
    if (!feed) return null;
    const text = reportText({
      clinicName,
      dateText: friendlyDateLong(feed.date),
      report: feed.report,
      tomorrowPercent: feed.tomorrow.percent,
      lateLabOrders: feed.lab.late,
    });
    return `https://wa.me/?text=${encodeURIComponent(text)}`;
  }, [feed, clinicName]);

  return (
    <main data-testid="daily-report" className="mx-auto max-w-4xl p-4 pb-24">
      {/* ترويسة الطباعة: الشعار والهوية على الورقة — تقرير الأداء اليومي يُوقّع
          ويُؤرشف عند إقفال اليوم، فيحمل اسم المركز كاملًا لا عنوان شاشةٍ فقط. */}
      <div className="mb-3 hidden print:block" dir="rtl">
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
          <p className="ms-auto shrink-0 text-xs font-bold text-navy-900">تقرير الأداء اليومي</p>
        </div>
      </div>

      <PageHeader
        title="تقرير الأداء اليومي"
        subtitle="إحصاءات الحضور، أزمنة الانتظار، وجاهزية أعمال الغد"
      >
        {/* لا طباعة إلا لتقريرٍ صحيحٍ للتاريخ المختار — والطباعة من المتصفح
            نفسها لا تجد في الصفحة تقريرًا قديمًا لأن جسم التقرير غير موجود. */}
        {feed ? (
          <div className="flex items-center gap-2">
            <PrintButton />
          </div>
        ) : null}
      </PageHeader>

      {/* شريط اختيار التاريخ */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-slate-200 bg-white p-3 shadow-xs print:hidden">
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

        <input
          type="date"
          value={date}
          onChange={(event) => setDate(event.target.value)}
          aria-invalid={!dateSelectable ? true : undefined}
          className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-extrabold text-navy-900 outline-none focus:border-navy-800"
        />
      </div>

      {dateSelectable && error ? (
        <div
          role="alert"
          className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-2"
        >
          <p className="text-xs font-bold text-red-700">{error}</p>
          <button
            type="button"
            onClick={() => setRetry((current) => current + 1)}
            className="rounded-xl border border-red-300 bg-white px-3 py-1.5 text-xs font-extrabold text-red-700 hover:bg-red-100"
          >
            أعد المحاولة
          </button>
        </div>
      ) : null}

      {!dateSelectable ? (
        <p role="alert" className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2 text-xs font-bold text-amber-900">
          التاريخ المختار غير صالح — اختر تاريخًا صحيحًا أو اضغط «اليوم» لعرض تقرير اليوم.
        </p>
      ) : null}

      {dateSelectable && waiting && !feed ? (
        <p className="rounded-2xl border border-slate-200 bg-white p-8 text-center text-xs text-slate-400">
          جارٍ إعداد التقرير اليومي…
        </p>
      ) : feed ? (
        <div className="space-y-4">
          <div className="flex items-center justify-between rounded-xl bg-navy-50/50 p-3 border border-navy-100">
            <span className="text-xs font-black text-navy-900">
              تقرير يوم: {friendlyDateLong(feed.date)}
            </span>
            <span className="text-[11px] text-slate-500 font-bold">
              عدد الكراسي الفعالة: {feed.chairs}
            </span>
          </div>

          {/*
           * لوحة اليوم (§٢٦): زيارات اليوم المخطَّطة من خطط العلاج — من سيأتي، بأيّ
           * عنوان، ومع من. مدخلٌ واحد يفتح منه الطبيب عمل يومه من ملف المريض مباشرة.
           */}
          {feed.plannedToday && feed.plannedToday.length > 0 ? (
            <section className="rounded-2xl border border-navy-200 bg-white p-4 shadow-xs" aria-label="لوحة اليوم">
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="text-xs font-black text-navy-900">
                  لوحة اليوم — زيارات مخطَّطة ({feed.plannedToday.length})
                </span>
                <a href="/appointments" className="text-[11px] font-bold text-navy-700 underline underline-offset-4">
                  كل المواعيد
                </a>
              </div>
              <ul className="space-y-1.5">
                {feed.plannedToday.slice(0, 8).map((row) => (
                  <li key={row.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-100 bg-slate-50/70 px-3 py-2">
                    <div className="min-w-0">
                      <p className="text-xs font-bold text-navy-900">
                        <span dir="ltr" className="ml-1 font-extrabold text-navy-700">{row.time ?? "—"}</span>
                        · {row.patientName}
                      </p>
                      <p className="text-[10px] text-slate-500">
                        {row.title} · {row.durationMinutes} دقيقة
                        {row.doctorName ? ` · ${row.doctorName}` : ""}
                      </p>
                    </div>
                    <a
                      href={`/patients/${row.patientId}?tab=today`}
                      className={`rounded-xl px-3 py-1.5 text-[11px] font-extrabold ${
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
                <p className="mt-2 text-center text-[10px] text-slate-400">
                  و{feed.plannedToday.length - 8} زيارة أخرى — تُعرض في المواعيد
                </p>
              ) : null}
            </section>
          ) : null}

          {/* الحضور والزيارات */}
          <section className="grid grid-cols-3 gap-2.5" aria-label="الحضور">
            <Stat label="إجمالي الحضور" value={feed.report.arrived} />
            <Stat label="اكتملت زيارتهم" value={feed.report.done} tone="calm" />
            <Stat
              label="لم يحضروا"
              value={feed.report.noShow}
              tone={feed.report.noShow > 0 ? "warn" : "calm"}
            />
          </section>

          {/* أزمنة الانتظار والتشغيل */}
          <section className="grid grid-cols-3 gap-2.5" aria-label="الانتظار">
            <Stat
              label="متوسط وقت الانتظار"
              value={shortMinutes(feed.report.averageWaitMinutes)}
              tone={
                feed.report.averageWaitMinutes >= 30
                  ? "bad"
                  : feed.report.averageWaitMinutes >= 15
                  ? "warn"
                  : "calm"
              }
            />
            <Stat
              label="أطول وقت انتظار"
              value={shortMinutes(feed.report.longestWaitMinutes)}
              tone={
                feed.report.longestWaitMinutes >= 45
                  ? "bad"
                  : feed.report.longestWaitMinutes >= 20
                  ? "warn"
                  : "calm"
              }
            />
            <Stat
              label="متوسط الجلسة على الكرسي"
              value={shortMinutes(feed.report.averageChairMinutes)}
            />
          </section>

          {/* حِمل الغد وأعمال المختبر */}
          <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-xs" aria-label="الغد والمختبر">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <span className="text-xs font-black text-navy-900">
                  حِمل الغد ({friendlyDateLong(feed.nextDate)})
                </span>
                <p className="text-[11px] text-slate-500 mt-0.5">
                  نسبة إشغال المواعيد المحجوزة مقاسة بطاقة الكراسي
                </p>
              </div>
              <span
                className={`rounded-xl px-3 py-1 text-xs font-extrabold ${
                  feed.tomorrow.percent >= 90
                    ? "bg-red-500 text-white"
                    : feed.tomorrow.percent >= 70
                    ? "bg-amber-200 text-amber-900"
                    : "bg-emerald-100 text-emerald-800"
                }`}
              >
                {feed.tomorrow.percent}٪ · {appointmentsCountText(feed.tomorrow.booked)}
              </span>
            </div>

            <div className="mb-3 h-2.5 w-full overflow-hidden rounded-full bg-slate-100">
              <div
                className={`h-full transition-all duration-300 ${
                  feed.tomorrow.percent >= 90
                    ? "bg-red-500"
                    : feed.tomorrow.percent >= 70
                    ? "bg-amber-400"
                    : "bg-emerald-500"
                }`}
                style={{ width: `${Math.min(100, feed.tomorrow.percent)}%` }}
              />
            </div>

            {/* أرقام المختبر تبقى بدلالتها الحالية (حالة المختبر الآن) كما
                يرسلها المسار — لا تُحوَّل تلقائيًا إلى أرقامٍ تاريخية. */}
            <div className="flex flex-wrap gap-2 pt-2 border-t border-slate-100 text-xs">
              <a
                href="/lab"
                className={`rounded-xl px-3 py-2 font-bold transition-colors ${
                  feed.lab.late > 0 ? "bg-red-50 text-red-700 border border-red-200" : "bg-slate-100 text-slate-600"
                }`}
              >
                🔬 تراكيب متأخرة بالمختبر: {feed.lab.late}
              </a>
              <a
                href="/lab"
                className="rounded-xl bg-slate-100 px-3 py-2 font-bold text-slate-600 hover:bg-slate-200"
              >
                📦 جاهزة للتركيب: {feed.lab.waitingFitting}
              </a>
              {feed.report.unresolved > 0 ? (
                <a
                  href="/appointments"
                  className="rounded-xl bg-amber-50 px-3 py-2 font-bold text-amber-800 border border-amber-200"
                >
                  ⚠️ مواعيد غير مغلقة: {feed.report.unresolved}
                </a>
              ) : null}
            </div>
          </section>

          {/* زر مشاركة التقرير — لا يُجهَّز الرابط إلا لتقريرٍ صحيحٍ للتاريخ المختار. */}
          {shareLink ? (
            <a
              href={shareLink}
              target="_blank"
              rel="noopener"
              className="flex items-center justify-center gap-2 rounded-2xl bg-[#25D366] py-3 text-center text-xs font-black text-white shadow-2xs transition-opacity hover:opacity-90 print:hidden"
            >
              <span>💬 إرسال ملخص التقرير عبر واتساب لإدارة المركز</span>
            </a>
          ) : null}
        </div>
      ) : null}
    </main>
  );
}
