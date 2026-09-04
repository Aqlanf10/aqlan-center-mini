"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useClinicName, useSetting } from "@/components/SettingsProvider";
import { friendlyDateLong, toWhatsAppNumber } from "@/lib/reminders";
import { clinicDateString } from "@/lib/schedule";
import {
  LAPSE_LABEL,
  LAPSE_OPTIONS,
  recallText,
  sinceText,
  type LapseWeeks,
  type RecallRow,
} from "@/lib/recall";
import { PageHeader } from "@/components/PageHeader";
import { QuickAppointmentModal } from "@/components/QuickAppointmentModal";

/**
 * المتابعة والاستدعاء — استعادة المرضى المنقطعين والتواصل الفوري عبر قوالب واتساب الذكية وإعادة الحجز المباشر.
 */

interface RecallFeed {
  missed: RecallRow[];
  lapsed: RecallRow[];
  weeks: number;
}

type MessageTemplate = "missed" | "ortho" | "hygiene" | "post_op";

const TEMPLATE_NAMES: Record<MessageTemplate, string> = {
  missed: "📅 تذكير بغياب موعد",
  ortho: "🧲 متابعة جلسة تقويم",
  hygiene: "🦷 فحص وتنظيف دوري",
  post_op: "🩺 اطمئنان بعد علاج/جراحة",
};

export default function RecallPage() {
  const clinicName = useClinicName();
  const clinicPhone = useSetting("clinic.phone");
  const [feed, setFeed] = useState<RecallFeed>({ missed: [], lapsed: [], weeks: 6 });
  const [weeks, setWeeks] = useState<LapseWeeks>(6);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);

  // Search & Active Tab
  const [search, setSearch] = useState("");
  const [activeCategory, setActiveCategory] = useState<"all" | "missed" | "lapsed">("all");

  // Rebooking Modal State
  const [rebookPatient, setRebookPatient] = useState<{ id: number; name: string } | null>(null);

  const today = useMemo(() => clinicDateString(new Date(), "Asia/Aden"), []);

  const load = useCallback(async (targetWeeks: number, showSpinner = false) => {
    if (showSpinner) setLoading(true);
    try {
      const response = await fetch(`/api/recall?weeks=${targetWeeks}`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.message ?? "تعذّر التحميل.");
      setFeed(payload as RecallFeed);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "تعذّر التحميل.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(weeks, true);
  }, [weeks, load]);

  const markDone = useCallback(
    async (row: RecallRow) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setBusy(true);
      try {
        const response = await fetch("/api/recall", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind: row.kind, id: row.id }),
        });
        const payload = await response.json().catch(() => null);
        if (!response.ok) setError(payload?.message ?? "تعذّر التسجيل.");
        else setError(null);
        await load(weeks);
      } catch {
        setError("تعذّر الاتصال بالخادم.");
      } finally {
        inFlight.current = false;
        setBusy(false);
      }
    },
    [load, weeks],
  );

  const filterRows = (rows: RecallRow[]) => {
    if (!search.trim()) return rows;
    const q = search.toLowerCase().trim();
    return rows.filter(
      (r) =>
        r.patientName.toLowerCase().includes(q) ||
        (r.patientPhone ?? "").includes(q) ||
        (r.note ?? "").toLowerCase().includes(q),
    );
  };

  const filteredMissed = useMemo(() => filterRows(feed.missed), [feed.missed, search]);
  const filteredLapsed = useMemo(() => filterRows(feed.lapsed), [feed.lapsed, search]);

  const total = feed.missed.length + feed.lapsed.length;

  return (
    <main className="mx-auto max-w-4xl p-4 pb-24">
      <PageHeader
        title="المتابعة واستدعاء المرضى"
        subtitle="استعادة المرضى المتغيبين والمنقطعين مع التواصل المباشر وإعادة الجدولة الفورية"
      />

      {error ? (
        <p role="alert" className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-2 text-xs font-bold text-red-700">
          {error}
        </p>
      ) : null}

      {/* بطاقات الإحصاءات السريعة */}
      <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
        <div className="rounded-2xl border border-amber-200 bg-amber-50/70 p-3.5 shadow-2xs">
          <span className="text-[11px] font-bold text-amber-800">تغيّبوا عن مواعيدهم</span>
          <p className="mt-1 text-xl font-black text-amber-900">{feed.missed.length}</p>
          <span className="text-[10px] text-amber-700">يحتاجون إعادة جدولة</span>
        </div>
        <div className="rounded-2xl border border-blue-200 bg-blue-50/70 p-3.5 shadow-2xs">
          <span className="text-[11px] font-bold text-blue-800">انقطعوا عن العلاج ({LAPSE_LABEL[weeks]})</span>
          <p className="mt-1 text-xl font-black text-blue-900">{feed.lapsed.length}</p>
          <span className="text-[10px] text-blue-700">يحتاجون تذكير بالمتابعة</span>
        </div>
        <div className="col-span-2 sm:col-span-1 rounded-2xl border border-slate-200 bg-white p-3.5 shadow-2xs">
          <span className="text-[11px] font-bold text-slate-500">إجمالي قائمة الاستدعاء</span>
          <p className="mt-1 text-xl font-black text-navy-900">{total}</p>
          <span className="text-[10px] text-slate-400">تتجدد تلقائياً</span>
        </div>
      </div>

      {/* شريط الفلترة واختيار مدة الانقطاع والبحث */}
      <div className="mb-4 space-y-2 rounded-2xl border border-slate-200 bg-white p-3 shadow-xs">
        <div className="flex flex-wrap items-center justify-between gap-2">
          {/* تبويبات النوع */}
          <div className="flex flex-wrap items-center gap-1">
            <button
              onClick={() => setActiveCategory("all")}
              className={`rounded-xl px-3 py-1.5 text-xs font-bold transition-all ${
                activeCategory === "all"
                  ? "bg-navy-800 text-white shadow-xs"
                  : "bg-white text-slate-600 border border-slate-200 hover:bg-slate-50"
              }`}
            >
              الكل ({total})
            </button>
            <button
              onClick={() => setActiveCategory("missed")}
              className={`rounded-xl px-3 py-1.5 text-xs font-bold transition-all ${
                activeCategory === "missed"
                  ? "bg-amber-800 text-white shadow-xs"
                  : "bg-white text-amber-800 border border-amber-200 hover:bg-amber-50"
              }`}
            >
              غياب مواعيد ({feed.missed.length})
            </button>
            <button
              onClick={() => setActiveCategory("lapsed")}
              className={`rounded-xl px-3 py-1.5 text-xs font-bold transition-all ${
                activeCategory === "lapsed"
                  ? "bg-navy-800 text-white shadow-xs"
                  : "bg-white text-slate-600 border border-slate-200 hover:bg-slate-50"
              }`}
            >
              انقطاع جلسات ({feed.lapsed.length})
            </button>
          </div>

          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="🔍 بحث بالاسم أو الهاتف…"
            className="w-full sm:w-56 rounded-xl border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs outline-none focus:border-navy-800"
          />
        </div>

        {/* فترات الانقطاع */}
        <div className="flex flex-wrap items-center gap-1.5 pt-1 border-t border-slate-100">
          <span className="text-[11px] font-bold text-slate-500">مدة الانقطاع:</span>
          {LAPSE_OPTIONS.map((option) => (
            <button
              key={option}
              onClick={() => setWeeks(option)}
              className={`rounded-lg px-2.5 py-1 text-[11px] font-bold transition-all ${
                weeks === option
                  ? "bg-navy-800 text-white"
                  : "bg-slate-100 text-slate-600 hover:bg-slate-200"
              }`}
            >
              {LAPSE_LABEL[option]}
            </button>
          ))}
          <button
            type="button"
            onClick={() => {
              setWeeks(24);
              setActiveCategory("lapsed");
            }}
            className={`rounded-lg px-2.5 py-1 text-[11px] font-bold transition-all flex items-center gap-1 ${
              weeks === 24 && activeCategory === "lapsed"
                ? "bg-emerald-700 text-white shadow-xs"
                : "bg-emerald-50 text-emerald-800 border border-emerald-200 hover:bg-emerald-100"
            }`}
          >
            <span>🦷</span>
            <span>استدعاء تنظيف وفحص دوري (٦ أشهر)</span>
          </button>
        </div>
      </div>

      {loading ? (
        <p className="rounded-2xl border border-slate-200 bg-white p-8 text-center text-xs text-slate-400">
          جارٍ فحص سجلات المتابعة…
        </p>
      ) : (
        <div className="space-y-6">
          {/* قسم المتغيبين عن مواعيدهم */}
          {(activeCategory === "all" || activeCategory === "missed") && (
            <section aria-label="متغيّبون">
              <div className="mb-2 flex items-center justify-between">
                <h2 className="text-xs font-extrabold text-navy-900">
                  ⚠️ لم يحضروا مواعيدهم ({filteredMissed.length})
                </h2>
              </div>
              {filteredMissed.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-slate-200 bg-white p-4 text-center text-xs text-slate-400">
                  {search ? "لا نتائج مطابقة للبحث" : "لا يوجد مرضى بانتظار متابعة غياب."}
                </div>
              ) : (
                <ul className="space-y-2">
                  {filteredMissed.map((row) => (
                    <RecallCard
                      key={`missed-${row.id}`}
                      row={row}
                      today={today}
                      busy={busy}
                      onDone={markDone}
                      onRebook={() => setRebookPatient({ id: row.patientId, name: row.patientName })}
                      clinicName={clinicName}
                      clinicPhone={clinicPhone}
                    />
                  ))}
                </ul>
              )}
            </section>
          )}

          {/* قسم المنقطعين عن المتابعة الدورية */}
          {(activeCategory === "all" || activeCategory === "lapsed") && (
            <section aria-label="منقطعون">
              <div className="mb-2 flex items-center justify-between">
                <h2 className="text-xs font-extrabold text-navy-900">
                  🗓️ انقطعوا عن متابعة العلاج ({filteredLapsed.length})
                </h2>
              </div>
              {filteredLapsed.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-slate-200 bg-white p-4 text-center text-xs text-slate-400">
                  {search ? "لا نتائج مطابقة للبحث" : "لا يوجد منقطعون بهذه المدة المحددة."}
                </div>
              ) : (
                <ul className="space-y-2">
                  {filteredLapsed.map((row) => (
                    <RecallCard
                      key={`lapsed-${row.id}`}
                      row={row}
                      today={today}
                      busy={busy}
                      onDone={markDone}
                      onRebook={() => setRebookPatient({ id: row.patientId, name: row.patientName })}
                      clinicName={clinicName}
                      clinicPhone={clinicPhone}
                    />
                  ))}
                </ul>
              )}
            </section>
          )}

          {total === 0 ? (
            <div className="rounded-2xl border border-emerald-200 bg-emerald-50/60 p-6 text-center text-xs font-bold text-emerald-800">
              ✓ تم التواصل مع جميع المرضى ومتابعة كافة المواعيد بنجاح!
            </div>
          ) : null}
        </div>
      )}

      {/* نافذة إعادة حجز موعد مباشر */}
      {rebookPatient ? (
        <QuickAppointmentModal
          patientId={rebookPatient.id}
          patientName={rebookPatient.name}
          isOpen={true}
          onClose={() => setRebookPatient(null)}
          onSuccess={() => {
            setRebookPatient(null);
            void load(weeks);
          }}
        />
      ) : null}
    </main>
  );
}

function RecallCard({
  row,
  today,
  busy,
  onDone,
  onRebook,
  clinicName,
  clinicPhone,
}: {
  row: RecallRow;
  today: string;
  busy: boolean;
  onDone: (row: RecallRow) => void;
  onRebook: () => void;
  clinicName: string;
  clinicPhone: string;
}) {
  const number = toWhatsAppNumber(row.patientPhone);
  const since = sinceText(row.referenceDate, today);
  const [template, setTemplate] = useState<MessageTemplate>(
    row.kind === "missed" ? "missed" : "ortho",
  );

  const getMessageText = (tmpl: MessageTemplate) => {
    switch (tmpl) {
      case "missed":
        return [
          `السلام عليكم ورحمة الله، ${row.patientName} المحترم،`,
          ``,
          `افتقدناكم في موعدكم المحدد بتاريخ ${friendlyDateLong(row.referenceDate)} في ${clinicName}.`,
          `نأمل أن يكون المانع خيرًا، ونودّ التنسيق معكم لترتيب موعد بديل يناسب وقتكم.`,
          ``,
          `للتواصل والحجز: ${clinicPhone}`,
        ].join("\n");

      case "ortho":
        return [
          `السلام عليكم ${row.patientName}،`,
          ``,
          `تحية طيبة من ${clinicName}،`,
          `نود تذكيركم بموعد جلسة شد ومتابعة التقويم الدورية للمحافظة على خطة علاجكم ونتائج الأسنان.`,
          `يسعدنا حجز موعد الجلسة القادمة في أقرب وقت يناسبكم.`,
          ``,
          `للتواصل: ${clinicPhone}`,
        ].join("\n");

      case "hygiene":
        return [
          `السلام عليكم ${row.patientName}،`,
          ``,
          `تحية طيبة من ${clinicName}،`,
          `مرت فترة منذ آخر زيارة فحص وتنظيف لأسنانكم (${since}). نوصي بإجراء الفحص الدوري وإزالة الجير لوقاية الأسنان واللثة.`,
          ``,
          `للحجز والاستفسار: ${clinicPhone}`,
        ].join("\n");

      case "post_op":
        return [
          `السلام عليكم ${row.patientName}،`,
          ``,
          `نطمئن على صحتكم بعد الإجراء الأخير في ${clinicName}.`,
          `نرجو أن تكونوا بأفضل حال وبلا أي آلام أو انزعاج، ونحن جاهزون لأي استفسار أو متابعة طبية.`,
          ``,
          `للتواصل: ${clinicPhone}`,
        ].join("\n");
    }
  };

  const messageText = getMessageText(template);

  return (
    <li
      className={`rounded-2xl border p-3.5 transition-all ${
        row.kind === "missed"
          ? "border-amber-200 bg-amber-50/40 shadow-2xs"
          : "border-slate-200 bg-white shadow-2xs"
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-[10rem] flex-1">
          <div className="flex items-center gap-2">
            <a
              href={`/patients/${row.patientId}`}
              className="text-sm font-black text-navy-900 hover:underline underline-offset-4"
            >
              {row.patientName}
            </a>
            <span
              className={`rounded-md px-1.5 py-0.5 text-[10px] font-bold ${
                row.kind === "missed"
                  ? "bg-amber-200 text-amber-900"
                  : "bg-blue-100 text-blue-900"
              }`}
            >
              {row.kind === "missed" ? "غياب موعد" : `منقطع ${since}`}
            </span>
          </div>

          <p className="mt-1 text-xs text-slate-500">
            {row.kind === "missed"
              ? `الموعد الفائت: ${friendlyDateLong(row.referenceDate)}`
              : `آخر مراجعة سريرية: ${friendlyDateLong(row.referenceDate)}`}
            {row.patientPhone ? ` · 📞 ${row.patientPhone}` : ""}
          </p>

          {row.note ? (
            <p className="mt-1 text-[11px] text-slate-600 bg-slate-100/80 rounded-lg px-2 py-0.5 inline-block">
              {row.note}
            </p>
          ) : null}

          {/* محدد قالب الرسالة السريع */}
          <div className="mt-2 flex flex-wrap items-center gap-1">
            {(["missed", "ortho", "hygiene", "post_op"] as MessageTemplate[]).map((tmpl) => (
              <button
                key={tmpl}
                type="button"
                onClick={() => setTemplate(tmpl)}
                className={`rounded-md px-2 py-0.5 text-[10px] font-bold transition-all ${
                  template === tmpl
                    ? "bg-navy-800 text-white"
                    : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                }`}
              >
                {TEMPLATE_NAMES[tmpl]}
              </button>
            ))}
          </div>
        </div>

        {/* أزرار الإجراءات السريعة */}
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={onRebook}
            className="rounded-xl bg-navy-800 px-3 py-1.5 text-xs font-bold text-white shadow-2xs hover:opacity-90"
          >
            📅 حجز موعد
          </button>

          {number ? (
            <a
              href={`https://wa.me/${number}?text=${encodeURIComponent(messageText)}`}
              target="_blank"
              rel="noopener"
              onClick={() => onDone(row)}
              className="rounded-xl bg-[#25D366] px-3 py-1.5 text-xs font-bold text-white shadow-2xs hover:opacity-90"
            >
              💬 واتساب
            </a>
          ) : (
            <span className="rounded-xl border border-slate-200 px-2.5 py-1 text-xs font-bold text-amber-600">
              بلا رقم
            </span>
          )}

          <button
            onClick={() => onDone(row)}
            disabled={busy}
            className="rounded-xl border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-bold text-slate-600 hover:bg-slate-50 disabled:opacity-40"
          >
            تمت المتابعة ✓
          </button>
        </div>
      </div>
    </li>
  );
}
