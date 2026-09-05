"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  APPLIANCE_LABEL, ARCHES_LABEL, CASE_STATUS_LABEL, ELASTIC_LABEL, PHASE_HINT,
  PHASE_LABEL, PHASE_ORDER, RETAINER_LABEL, SLOT_LABEL,
  nextAdjustmentDate, nextWire, usesArchwires, wiresFor,
  type Appliance, type Arches, type CaseStatus, type ElasticClass,
  type OrthoPhase, type RetainerType, type SlotSize,
} from "@/lib/ortho";
import {
  PHOTO_STAGE_LABEL, PHOTO_VIEW_LABEL, buildComparison, fullPhotoSetCheck,
  suggestPhotoStage, type PhotoStage, type PhotoView, type StagePhoto,
} from "@/lib/ortho-photos";
import {
  friendlyDateLong, friendlyTime, orthoSessionBookedText, toWhatsAppNumber,
} from "@/lib/reminders";
import { clinicDateString } from "@/lib/schedule";
import { useClinicName, useSetting } from "./SettingsProvider";
import { PatientCeph } from "./PatientCeph";
import { WebCephRecordsGrid } from "./WebCephRecordsGrid";

/**
 * كابينة تقويم الأسنان التخصصية (Orthodontic Specialty Cockpit).
 *
 * تجسد معمارية برمجيات التقويم العالمية الرائدة (Dolphin Imaging, WebCeph, OrthoTrac)
 * القائمة على أربعة أركان سريرية متكاملة للحالة:
 *
 * ١) الركن التشخيصي (Diagnostic Records & Imaging):
 *    - التحليل السيفالومتري ومخطط ويب سيف (T1 ما قبل العلاج، T2 أثناء التقدم، T3 بعد العلاج، T4 المتابعة)
 *    - التوثيق الصوري ومقارنة التطور (5 صور داخل الفم + 3 صور للوجه والبروفايل)
 *    - التحليل السريري للفكين والأسنان وتصنيف مالوكلوجن
 *
 * ٢) خطة العلاج والميكانيكا الحيوية (Prescription & Biomechanics):
 *    - نوع الجهاز (معدني، خزفي، شفاف، وظيفي)، حجم الشق (0.018 / 0.022)، فلسفة البراكيت
 *    - خطة القلع، الزريعات TADs، التوسيع، وملاحظات الإرساء
 *
 * ٣) مسار الجلسات وتتابع الأسلاك (Archwire Progression & Timeline):
 *    - شريط الأسلاك الفوري على الكرسي (Upper & Lower Wires)
 *    - محدد المراحل السريرية (Aligning -> Working -> Finishing -> Retention)
 *    - تسجيل الشدّة السريعة، اقتراح السلك، صنف المطاطات، والتقاط الصور الحية
 *    - إغلاق الحلقة: حجز الجلسة القادمة التلقائي والتذكير
 *
 * ٤) التثبيت والاستبقاء (Retention & Stability):
 *    - اختيار المثبت (Hawley, Essix, Bonded) وتاريخ التسليم ومواعيد الفحص الدوري
 *    - الإغلاق الآمن للحالة لمنع ارتداد الأسنان
 */

interface SessionPhoto {
  id: number;
  title: string;
  isImage: boolean;
  photoStage: string | null;
  photoView: string | null;
  takenOn: string | null;
}

interface Adjustment {
  id: number; visitId: number | null; doneOn: string; phase: OrthoPhase | null;
  upperWire: string | null; lowerWire: string | null; elastics: ElasticClass;
  elasticNote: string | null; done: string | null; nextWeeks: number;
  note: string | null; recordedBy: string;
  photos: SessionPhoto[];
}

interface OrthoCase {
  id: number; appliance: Appliance; arches: Arches; slot: SlotSize;
  bracketSystem: string | null; status: CaseStatus; phase: OrthoPhase;
  startDate: string; plannedMonths: number;
  upperWire: string | null; lowerWire: string | null;
  retainer: RetainerType | null; retainerOn: string | null; note: string | null;
  closedAt: string | null; closedBy: string | null; closedNote: string | null;
  adjustments: Adjustment[];
  progress: {
    monthsElapsed: number; monthsPlanned: number; monthsRemaining: number;
    percent: number; overdue: boolean; adjustments: number;
    lastAdjustment: string | null; daysSinceLast: number | null;
  };
}

type OrthoPillar = "wires" | "diagnostics" | "prescription" | "retention";

const PILLAR_TABS: { key: OrthoPillar; label: string; icon: string }[] = [
  { key: "wires", label: "مسار الأسلاك والشدّات", icon: "⚡" },
  { key: "diagnostics", label: "السجلات والسيفالومتري (WebCeph)", icon: "📐" },
  { key: "prescription", label: "خطة العلاج والميكانيكا", icon: "⚙️" },
  { key: "retention", label: "التثبيت والاستبقاء", icon: "🛡️" },
];

function monthsText(months: number): string {
  if (months < 1) return "أقل من شهر";
  const whole = Math.round(months);
  if (whole === 1) return "شهر";
  if (whole === 2) return "شهرين";
  if (whole <= 10) return `${whole} أشهر`;
  return `${whole} شهرًا`;
}

function daysText(days: number): string {
  if (days === 1) return "قبل يوم";
  if (days === 2) return "قبل يومين";
  if (days <= 10) return `قبل ${days} أيام`;
  return `قبل ${days} يومًا`;
}

interface QueuedPhoto {
  file: File;
  preview: string;
  view: PhotoView | "";
}

interface SavedAdjustment {
  adjustmentId: number;
  caseId: number;
  doneOn: string;
  nextWeeks: number;
  photosUploaded: number;
}

export function PatientOrtho({ patientId }: { patientId: number }) {
  const today = clinicDateString(new Date(), "Asia/Aden");
  const [cases, setCases] = useState<OrthoCase[]>([]);
  const [patient, setPatient] = useState<{ name: string; phone: string | null } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [adjusting, setAdjusting] = useState<number | null>(null);
  const [saved, setSaved] = useState<SavedAdjustment | null>(null);

  // تبويب الركن النشط لكل حالة (افتراضيًا: الأسلاك والشدّات)
  const [activePillars, setActivePillars] = useState<Record<number, OrthoPillar>>({});

  const setPillarForCase = (caseId: number, pillar: OrthoPillar) => {
    setActivePillars((prev) => ({ ...prev, [caseId]: pillar }));
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [orthoRes, patientRes] = await Promise.all([
        fetch(`/api/ortho?patientId=${patientId}`, { cache: "no-store" }),
        fetch(`/api/patients/${patientId}`, { cache: "no-store" }),
      ]);
      const payload = await orthoRes.json();
      if (!orthoRes.ok) throw new Error(payload?.message ?? "تعذّر التحميل.");
      setCases(payload.cases as OrthoCase[]);
      if (patientRes.ok) {
        const file = await patientRes.json().catch(() => null);
        setPatient(file?.patient
          ? { name: file.patient.fullName, phone: file.patient.phone }
          : null);
      }
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "تعذّر التحميل.");
    } finally {
      setLoading(false);
    }
  }, [patientId]);

  useEffect(() => { void load(); }, [load]);

  const open = cases.find((row) => row.status === "active" || row.status === "retention");

  const patch = async (id: number, body: Record<string, unknown>) => {
    const response = await fetch(`/api/ortho/${id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) { setError(payload?.message ?? "تعذّر التنفيذ."); return false; }
    setError(null);
    await load();
    return true;
  };

  return (
    <div className="space-y-4">
      {error ? (
        <p role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-2 text-xs font-bold text-red-700">
          {error}
        </p>
      ) : null}

      {/* بطاقة الجلسة القادمة المقترحة — إغلاق الحلقة السريرية فورياً */}
      {saved ? (
        <NextAppointmentCard
          patientId={patientId}
          patientName={patient?.name ?? ""}
          patientPhone={patient?.phone ?? null}
          caseId={saved.caseId}
          doneOn={saved.doneOn}
          nextWeeks={saved.nextWeeks}
          photosUploaded={saved.photosUploaded}
          onDismiss={() => setSaved(null)}
          onError={setError}
        />
      ) : null}

      {/* زر فتح حالة تقويم جديدة إن لم تكن هناك حالة قائمة */}
      {!open ? (
        <div className="rounded-2xl border border-dashed border-navy-300 bg-navy-50/50 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm font-extrabold text-navy-900">
                فتح حالة تقويم تخصصية جديدة
              </p>
              <p className="text-xs text-slate-600">
                تسجيل خطة التقويم، الأقواس السنية، مقاس الشق، وفلسفة الحاصرات
              </p>
            </div>
            <button
              onClick={() => setOpening((value) => !value)}
              className="rounded-xl bg-navy-800 px-4 py-2 text-xs font-black text-white hover:bg-navy-900 transition-colors shadow-xs"
            >
              {opening ? "✕ إغلاق النموذج" : "+ فتح حالة تقويم جديدة"}
            </button>
          </div>
          {opening ? (
            <div className="mt-3">
              <NewCase
                patientId={patientId}
                today={today}
                onSaved={() => { setOpening(false); void load(); }}
                onError={setError}
              />
            </div>
          ) : null}
        </div>
      ) : null}

      {/* إذا لم تكن هناك حالات مسجلة للمريض: نوفر مساحة التشخيص والسيفالومتري التمهيدي */}
      {cases.length === 0 && !loading && (
        <div className="space-y-4">
          <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-xs">
            <div className="mb-2">
              <h4 className="text-sm font-extrabold text-navy-900">
                📐 السجلات التشخيصية والسيفالومتري التمهيدي (T1 Pre-treatment)
              </h4>
              <p className="text-xs text-slate-500">
                يمكنك إجراء وتوثيق التتبع السيفالومتري لدراسة الحالة قبل تركيب الحاصرات وفتح ملف التقويم
              </p>
            </div>
            <PatientCeph patientId={patientId} embedded={true} />
          </div>
        </div>
      )}

      {loading && cases.length === 0 ? (
        <p className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-400">
          جارٍ تحميل كابينة التقويم…
        </p>
      ) : null}

      {/* قائمة حالات التقويم مع هيكلية الأركان الأربعة */}
      {cases.length > 0 && (
        <ul className="space-y-4">
          {cases.map((row) => {
            const live = row.status === "active" || row.status === "retention";
            const wires = wiresFor(row.slot);
            const currentPillar: OrthoPillar = activePillars[row.id] ?? "wires";

            return (
              <li
                key={row.id}
                className={`rounded-2xl border shadow-xs overflow-hidden transition-all ${
                  live ? "border-navy-200 bg-white" : "border-slate-200 bg-slate-50/70 opacity-80"
                }`}
              >
                {/* رأس الحالة التقويمية */}
                <div className="border-b border-slate-100 bg-slate-50/70 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-navy-800 text-xs font-bold text-white">
                        #{row.id}
                      </span>
                      <span className="text-base font-black text-navy-900">
                        {APPLIANCE_LABEL[row.appliance]} · {ARCHES_LABEL[row.arches]}
                      </span>
                      {row.bracketSystem && (
                        <span className="rounded-md bg-white border border-slate-200 px-2 py-0.5 text-[11px] font-bold text-slate-700 font-mono" dir="ltr">
                          {row.bracketSystem} · {SLOT_LABEL[row.slot]}
                        </span>
                      )}
                    </div>

                    <div className="flex items-center gap-2">
                      <span
                        className={`rounded-full px-2.5 py-0.5 text-[11px] font-black border ${
                          live
                            ? "bg-emerald-50 text-emerald-800 border-emerald-200"
                            : "bg-slate-100 text-slate-600 border-slate-200"
                        }`}
                      >
                        {CASE_STATUS_LABEL[row.status]}
                      </span>
                      <span className="rounded-full bg-navy-100 px-2.5 py-0.5 text-[11px] font-bold text-navy-900">
                        {PHASE_LABEL[row.phase]}
                      </span>
                    </div>
                  </div>

                  {/* شريط الإحصائيات السريعة ومعدل التقدم */}
                  <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-2 text-center text-xs">
                    <div className="rounded-xl bg-white p-2 border border-slate-200/80">
                      <p className="font-extrabold text-navy-900">{monthsText(row.progress.monthsElapsed)}</p>
                      <p className="text-[10px] text-slate-500">انقضى من العلاج</p>
                    </div>
                    <div className={`rounded-xl p-2 border ${
                      row.progress.overdue
                        ? "bg-amber-50 border-amber-300 text-amber-900"
                        : "bg-white border-slate-200/80 text-slate-700"
                    }`}>
                      <p className="font-extrabold">
                        {row.progress.overdue ? "تجاوزت المدة" : monthsText(row.progress.monthsRemaining)}
                      </p>
                      <p className="text-[10px] text-slate-500">
                        {row.progress.overdue ? `المخطط ${row.plannedMonths} شهرًا` : "المتبقي المتوقع"}
                      </p>
                    </div>
                    <div className="rounded-xl bg-white p-2 border border-slate-200/80">
                      <p className="font-extrabold text-navy-900">{row.progress.adjustments}</p>
                      <p className="text-[10px] text-slate-500">جلسات وشدّات منفذة</p>
                    </div>
                    <div className="rounded-xl bg-white p-2 border border-slate-200/80">
                      <p className="font-extrabold text-navy-900">
                        {row.progress.lastAdjustment
                          ? friendlyDateLong(row.progress.lastAdjustment)
                          : "—"}
                      </p>
                      <p className="text-[10px] text-slate-500">
                        {row.progress.daysSinceLast !== null
                          ? daysText(row.progress.daysSinceLast)
                          : "لا شدّات بعد"}
                      </p>
                    </div>
                  </div>

                  {/* شريط التقدم الزمني */}
                  <div className="mt-2.5 h-2 w-full overflow-hidden rounded-full bg-slate-200">
                    <div
                      className={`h-full transition-all ${
                        row.progress.overdue ? "bg-amber-500" : "bg-navy-800"
                      }`}
                      style={{ width: `${Math.min(100, row.progress.percent)}%` }}
                    />
                  </div>
                </div>

                {/* أشرطة الأركان الأربعة التخصصية (Pillar Navigation) */}
                <div className="flex border-b border-slate-200 bg-white">
                  {PILLAR_TABS.map((tab) => {
                    const isSelected = currentPillar === tab.key;
                    return (
                      <button
                        key={tab.key}
                        onClick={() => setPillarForCase(row.id, tab.key)}
                        className={`flex-1 py-2.5 text-xs font-black transition-all border-b-2 flex items-center justify-center gap-1.5 ${
                          isSelected
                            ? "border-navy-800 text-navy-900 bg-navy-50/40"
                            : "border-transparent text-slate-500 hover:text-slate-800 hover:bg-slate-50"
                        }`}
                      >
                        <span>{tab.icon}</span>
                        <span className="hidden sm:inline">{tab.label}</span>
                        <span className="sm:hidden">{tab.label.split(" ")[0]}</span>
                      </button>
                    );
                  })}
                </div>

                {/* محتوى الركن المختار */}
                <div className="p-4">
                  {/* ────────────────── الركن الأول: مسار الأسلاك والشدّات ────────────────── */}
                  {currentPillar === "wires" && (
                    <div className="space-y-4">
                      {/* لوحة الأسلاك المباشرة على الكرسي (Chairside High-Contrast Wire Board) */}
                      {usesArchwires(row.appliance) ? (
                        <div className="rounded-2xl border-2 border-navy-800 bg-gradient-to-r from-navy-900 to-slate-900 p-4 text-white shadow-xs">
                          <div className="flex items-center justify-between border-b border-white/20 pb-2 mb-3">
                            <span className="text-xs font-bold text-navy-200">
                              الأسلاك الحالية على الكرسي
                            </span>
                            <span className="text-[11px] font-bold text-amber-300">
                              {SLOT_LABEL[row.slot]}
                            </span>
                          </div>
                          <div className="grid grid-cols-2 gap-3 text-center">
                            <div className="rounded-xl bg-white/10 p-3 backdrop-blur-xs">
                              <p className="text-xl font-black tracking-wider text-amber-400" dir="ltr">
                                {row.upperWire ?? "—"}
                              </p>
                              <p className="mt-1 text-xs font-bold text-navy-200">السلك العلوي (Upper)</p>
                            </div>
                            <div className="rounded-xl bg-white/10 p-3 backdrop-blur-xs">
                              <p className="text-xl font-black tracking-wider text-amber-400" dir="ltr">
                                {row.lowerWire ?? "—"}
                              </p>
                              <p className="mt-1 text-xs font-bold text-navy-200">السلك السفلي (Lower)</p>
                            </div>
                          </div>
                        </div>
                      ) : null}

                      {/* محدد المرحلة السريرية */}
                      {live ? (
                        <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-3">
                          <p className="mb-2 text-[11px] font-extrabold text-slate-600">
                            المرحلة السريرية الحالية (انقر للتغيير):
                          </p>
                          <div className="flex flex-wrap gap-1.5">
                            {PHASE_ORDER.map((phase) => (
                              <button
                                key={phase}
                                onClick={() => void patch(row.id, { phase })}
                                title={PHASE_HINT[phase]}
                                className={`rounded-xl border px-3 py-1.5 text-xs font-bold transition-all ${
                                  row.phase === phase
                                    ? "border-navy-800 bg-navy-800 text-white shadow-xs"
                                    : "border-slate-200 bg-white text-slate-700 hover:bg-slate-100"
                                }`}
                              >
                                {PHASE_LABEL[phase]}
                              </button>
                            ))}
                          </div>
                          <p className="mt-2 text-[11px] text-slate-500">
                            {PHASE_HINT[row.phase]}
                          </p>
                        </div>
                      ) : null}

                      {/* زر ونموذج تسجيل الشدّة */}
                      {live && (
                        <div>
                          {adjusting === row.id ? (
                            <AdjustmentForm
                              caseRow={row}
                              today={today}
                              wires={wires}
                              patientId={patientId}
                              onSaved={(result) => {
                                setAdjusting(null);
                                setSaved(result);
                                void load();
                              }}
                              onError={setError}
                            />
                          ) : (
                            <button
                              onClick={() => { setSaved(null); setAdjusting(row.id); }}
                              className="w-full rounded-2xl bg-brand-orange py-3 text-sm font-black text-white shadow-xs hover:bg-amber-600 transition-colors"
                            >
                              ⚡ سجّل شدّة وجلسة جديدة الآن
                            </button>
                          )}
                        </div>
                      )}

                      {/* سجل الشدّات السابقة وألبومات الجلسات */}
                      {row.adjustments.length > 0 ? (
                        <div className="rounded-2xl border border-slate-200 bg-white p-4">
                          <h4 className="mb-3 text-xs font-extrabold text-navy-900">
                            سجل الشدّات السابقة وألبومات الجلسات ({row.adjustments.length})
                          </h4>
                          <ul className="space-y-2">
                            {row.adjustments.map((entry, index) => (
                              <li key={entry.id} className="rounded-xl border border-slate-100 bg-slate-50/70 p-3">
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                  <span className="text-xs font-extrabold text-navy-900">
                                    جلسة {row.adjustments.length - index} · {friendlyDateLong(entry.doneOn)}
                                  </span>
                                  <span className="text-xs font-bold text-slate-600">
                                    {entry.upperWire || entry.lowerWire ? (
                                      <>
                                        علوي <span dir="ltr" className="font-mono text-navy-800">{entry.upperWire ?? "—"}</span>
                                        {" · "}سفلي <span dir="ltr" className="font-mono text-navy-800">{entry.lowerWire ?? "—"}</span>
                                      </>
                                    ) : "—"}
                                  </span>
                                </div>
                                {entry.done ? <p className="mt-1 text-xs text-slate-700 font-medium">{entry.done}</p> : null}
                                <p className="mt-1 text-[11px] text-slate-500">
                                  {ELASTIC_LABEL[entry.elastics]}
                                  {entry.elasticNote ? ` · ${entry.elasticNote}` : ""}
                                  {" · القادم "}{friendlyDateLong(nextAdjustmentDate(entry.doneOn, entry.nextWeeks))}
                                  {" · "}{entry.recordedBy}
                                </p>

                                {/* صور الجلسة */}
                                {entry.photos.length > 0 ? (
                                  <div className="mt-2.5 grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-2">
                                    {entry.photos.map((photo) => (
                                      <a
                                        key={photo.id}
                                        href={`/api/documents/${photo.id}`}
                                        target="_blank"
                                        rel="noopener"
                                        className="group relative block overflow-hidden rounded-xl bg-slate-900 border border-slate-200"
                                      >
                                        {photo.isImage ? (
                                          <img
                                            src={`/api/documents/${photo.id}`}
                                            alt={photo.title}
                                            loading="lazy"
                                            className="h-20 w-full object-cover opacity-90 group-hover:opacity-100 transition-opacity"
                                          />
                                        ) : (
                                          <div className="flex h-20 items-center justify-center text-2xl">📄</div>
                                        )}
                                        {photo.photoView && photo.photoView in PHOTO_VIEW_LABEL ? (
                                          <span className="absolute bottom-1 right-1 rounded bg-black/70 px-1 py-0.5 text-[9px] font-bold text-white">
                                            {PHOTO_VIEW_LABEL[photo.photoView as PhotoView]}
                                          </span>
                                        ) : null}
                                      </a>
                                    ))}
                                  </div>
                                ) : null}
                              </li>
                            ))}
                          </ul>
                        </div>
                      ) : (
                        <p className="rounded-xl border border-dashed border-slate-200 bg-slate-50 p-4 text-center text-xs text-slate-500">
                          لا توجد شدّات مسجلة بعد في هذه الحالة.
                        </p>
                      )}
                    </div>
                  )}

                  {/* ────────────────── الركن الثاني: السجلات والتشخيص السيفالومتري ────────────────── */}
                  {currentPillar === "diagnostics" && (
                    <div className="space-y-4">
                      {/* معرض سجلات الحالة والأشعة المعياري الـ 12 كمنصة WebCeph */}
                      <section>
                        <WebCephRecordsGrid
                          patientId={patientId}
                          orthoCaseId={row.id}
                          currentPhase={row.phase}
                          startDate={row.startDate}
                        />
                      </section>

                      {/* السيفالومتري ومخطط ويب سيف (WebCeph Station) */}
                      <section className="rounded-2xl border border-navy-100 bg-slate-50/50 p-3.5">
                        <PatientCeph
                          patientId={patientId}
                          orthoCaseId={row.id}
                          currentPhase={row.phase}
                          embedded={true}
                        />
                      </section>

                      {/* التوثيق الفوتوغرافي ومقارنة المراحل (Before / Progress / After) */}
                      <section className="rounded-2xl border border-slate-200 bg-white p-3.5">
                        <OrthoComparison patientId={patientId} orthoCaseId={row.id} />
                      </section>

                      {/* التحليل السريري للفكين وتصنيف الحالة (Malocclusion Diagnosis) */}
                      <section className="rounded-2xl border border-slate-200 bg-white p-3.5">
                        <PatientDiagnosis patientId={patientId} orthoCaseId={row.id} onError={setError} />
                      </section>
                    </div>
                  )}

                  {/* ────────────────── الركن الثالث: الخطة والميكانيكا الحيوية ────────────────── */}
                  {currentPillar === "prescription" && (
                    <div className="space-y-4">
                      <div className="rounded-2xl border border-slate-200 bg-white p-4">
                        <h4 className="mb-3 text-xs font-black text-navy-900">
                          وصفة الجهاز والمواصفات الميكانيكية
                        </h4>
                        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-xs">
                          <div className="rounded-xl bg-slate-50 p-2.5 border border-slate-100">
                            <span className="block text-[10px] text-slate-500 font-bold">نوع الجهاز</span>
                            <span className="font-black text-navy-900">{APPLIANCE_LABEL[row.appliance]}</span>
                          </div>
                          <div className="rounded-xl bg-slate-50 p-2.5 border border-slate-100">
                            <span className="block text-[10px] text-slate-500 font-bold">الفكّان المعالجان</span>
                            <span className="font-black text-navy-900">{ARCHES_LABEL[row.arches]}</span>
                          </div>
                          <div className="rounded-xl bg-slate-50 p-2.5 border border-slate-100">
                            <span className="block text-[10px] text-slate-500 font-bold">مقاس الشق (Slot)</span>
                            <span className="font-black text-navy-900">{SLOT_LABEL[row.slot]}</span>
                          </div>
                          <div className="rounded-xl bg-slate-50 p-2.5 border border-slate-100">
                            <span className="block text-[10px] text-slate-500 font-bold">فلسفة البراكيت</span>
                            <span className="font-black text-navy-900 font-mono" dir="ltr">
                              {row.bracketSystem ?? "Roth / MBT"}
                            </span>
                          </div>
                          <div className="rounded-xl bg-slate-50 p-2.5 border border-slate-100">
                            <span className="block text-[10px] text-slate-500 font-bold">تاريخ البدء</span>
                            <span className="font-black text-navy-900">{friendlyDateLong(row.startDate)}</span>
                          </div>
                          <div className="rounded-xl bg-slate-50 p-2.5 border border-slate-100">
                            <span className="block text-[10px] text-slate-500 font-bold">المدة المخططة</span>
                            <span className="font-black text-navy-900">{row.plannedMonths} شهرًا</span>
                          </div>
                        </div>

                        {row.note && (
                          <div className="mt-3 rounded-xl bg-slate-50 p-3 border border-slate-100 text-xs">
                            <span className="block font-bold text-slate-500 mb-1">ملاحظات خطة العلاج والميكانيكا:</span>
                            <p className="text-slate-800">{row.note}</p>
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* ────────────────── الركن الرابع: التثبيت والاستبقاء ────────────────── */}
                  {currentPillar === "retention" && (
                    <div className="space-y-4">
                      <div className="rounded-2xl border border-slate-200 bg-white p-4">
                        <div className="mb-3 flex items-center justify-between">
                          <h4 className="text-xs font-black text-navy-900">
                            المثبّتات والاستقرار ومنع الارتداد (Relapse Prevention)
                          </h4>
                          <span className={`rounded-full border px-2.5 py-0.5 text-[10px] font-black ${
                            row.retainer && row.retainer !== "none"
                              ? "bg-emerald-50 text-emerald-800 border-emerald-200"
                              : "bg-amber-50 text-amber-800 border-amber-200"
                          }`}>
                            {row.retainer ? RETAINER_LABEL[row.retainer] : "لم يُسجَّل مثبت بعد"}
                          </span>
                        </div>

                        {live && (
                          <div className="rounded-xl bg-slate-50 p-3 border border-slate-200">
                            <p className="mb-2 text-xs font-bold text-slate-700">
                              اختر نوع المثبّت المسلّم للمريض:
                            </p>
                            <div className="flex flex-wrap gap-2 mb-3">
                              {(Object.keys(RETAINER_LABEL) as RetainerType[]).map((type) => (
                                <button
                                  key={type}
                                  onClick={() => void patch(row.id, { retainer: type })}
                                  className={`rounded-xl border px-3 py-1.5 text-xs font-bold transition-all ${
                                    row.retainer === type
                                      ? "border-emerald-600 bg-emerald-600 text-white shadow-xs"
                                      : "border-slate-200 bg-white text-slate-700 hover:bg-slate-100"
                                  }`}
                                >
                                  {RETAINER_LABEL[type]}
                                </button>
                              ))}
                            </div>

                            <div className="flex flex-wrap gap-2 pt-2 border-t border-slate-200">
                              <button
                                onClick={async () => {
                                  const note = window.prompt("ملاحظة على إكمال الحالة (اختياري)") ?? "";
                                  await patch(row.id, { status: "completed", note });
                                }}
                                className="flex-1 rounded-xl bg-emerald-600 py-2.5 text-xs font-black text-white hover:bg-emerald-700 shadow-xs transition-colors"
                              >
                                ✓ أُكملت الحالة بنجاح وسُلّم المثبت
                              </button>
                              <button
                                onClick={async () => {
                                  const note = window.prompt("سبب التوقّف أو الإلغاء؟");
                                  if (!note?.trim()) return;
                                  await patch(row.id, { status: "discontinued", note });
                                }}
                                className="rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-xs font-bold text-slate-700 hover:bg-slate-50 transition-colors"
                              >
                                توقّفت الحالة
                              </button>
                            </div>
                          </div>
                        )}

                        {row.closedAt && (
                          <div className="rounded-xl bg-slate-100 p-3 text-xs text-slate-700">
                            <p className="font-bold">
                              أُغلقت الحالة في {friendlyDateLong(row.closedAt.slice(0, 10))} بواسطة {row.closedBy}
                            </p>
                            {row.closedNote && <p className="mt-1 text-slate-600">{row.closedNote}</p>}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/* ═══════════════ الجلسة القادمة المقترحة — إغلاق الحلقة ═══════════════ */

function NextAppointmentCard({
  patientId, patientName, patientPhone, caseId, doneOn, nextWeeks,
  photosUploaded, onDismiss, onError,
}: {
  patientId: number; patientName: string; patientPhone: string | null;
  caseId: number; doneOn: string; nextWeeks: number; photosUploaded: number;
  onDismiss: () => void; onError: (message: string | null) => void;
}) {
  const clinicName = useClinicName();
  const clinicPhone = useSetting("clinic.phone");
  const suggested = nextAdjustmentDate(doneOn, nextWeeks);
  const [booking, setBooking] = useState(false);
  const [date, setDate] = useState(suggested);
  const [time, setTime] = useState("16:00");
  const [busy, setBusy] = useState(false);
  const [booked, setBooked] = useState<{ date: string; time: string } | null>(null);

  const message = booked
    ? orthoSessionBookedText({
        patientName: patientName || "المريض",
        whenText: `${friendlyDateLong(booked.date)} الساعة ${friendlyTime(booked.time)}`,
        clinic: { name: clinicName, phone: clinicPhone || "04-253028" },
      })
    : null;
  const waLink = booked && patientPhone
    ? (() => {
        const number = toWhatsAppNumber(patientPhone);
        return number
          ? `https://wa.me/${number}?text=${encodeURIComponent(message ?? "")}`
          : null;
      })()
    : null;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    onError(null);
    try {
      const response = await fetch("/api/appointments", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          patientId, date, time, durationMinutes: 15,
          appointmentType: "follow_up",
          note: "جلسة شدّ تقويم — من كابينة التقويم",
        }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        onError(payload?.suggestionMessage || payload?.message || "تعذّر الحجز.");
        return;
      }
      setBooked({ date, time });
      setBooking(false);
    } catch {
      onError("تعذّر الاتصال بالخادم.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-2xl border-2 border-emerald-500 bg-emerald-50 p-4 shadow-xs">
      <p className="mb-1 text-sm font-black text-emerald-900">
        {booked ? "تم حجز الجلسة القادمة بنجاح" : "📅 الجلسة القادمة المقترحة"}
      </p>
      {photosUploaded > 0 ? (
        <p className="mb-1 text-xs font-bold text-emerald-700">
          📷 رُفعت {photosUploaded} صورة للجلسة وحُفظت مباشرة في ألبوم الحالة.
        </p>
      ) : null}
      <p className="mb-2 text-xs text-emerald-800">
        {friendlyDateLong(booked?.date ?? suggested)} — متابعة تقويم وشد · 15 دقيقة
        {booked ? ` · الساعة ${friendlyTime(booked.time)}` : ""}
      </p>

      {booked ? (
        <>
          {waLink && message ? (
            <div className="flex flex-wrap gap-2">
              <a href={waLink} target="_blank" rel="noopener"
                className="flex-1 rounded-xl bg-emerald-600 py-2 text-center text-xs font-black text-white hover:bg-emerald-700 transition-colors">
                أرسل تأكيد الموعد واتساب
              </a>
              <button type="button"
                onClick={() => void navigator.clipboard?.writeText(message).catch(() => {})}
                className="rounded-xl border border-emerald-300 bg-white px-3 py-2 text-xs font-bold text-emerald-700 hover:bg-emerald-50">
                انسخ الرسالة
              </button>
            </div>
          ) : null}
          <button onClick={onDismiss}
            className="mt-2 w-full rounded-xl border border-emerald-300 bg-white py-2 text-xs font-bold text-emerald-700 hover:bg-emerald-50">
            تم — إغلاق
          </button>
        </>
      ) : !booking ? (
        <div className="flex flex-wrap gap-2">
          <button onClick={() => setBooking(true)}
            className="flex-1 rounded-xl bg-emerald-600 py-2.5 text-xs font-black text-white hover:bg-emerald-700 transition-colors">
            📅 حجز الموعد المقترح الآن
          </button>
          <button onClick={onDismiss}
            className="rounded-xl border border-emerald-300 bg-white px-4 py-2.5 text-xs font-bold text-emerald-700 hover:bg-emerald-50">
            لاحقًا
          </button>
        </div>
      ) : (
        <form onSubmit={submit} className="rounded-xl border border-emerald-200 bg-white p-3">
          <div className="mb-2 flex flex-wrap gap-2">
            <label className="min-w-[9rem] flex-1">
              <span className="mb-1 block text-[10px] font-bold text-slate-500">التاريخ المقترح</span>
              <input type="date" value={date} onChange={(event) => setDate(event.target.value)}
                aria-label="تاريخ الجلسة القادمة"
                className="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-xs" />
            </label>
            <label className="w-32">
              <span className="mb-1 block text-[10px] font-bold text-slate-500">الوقت</span>
              <input type="time" value={time} onChange={(event) => setTime(event.target.value)}
                aria-label="وقت الجلسة القادمة"
                className="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-xs" />
            </label>
          </div>
          <div className="flex gap-2">
            <button type="submit" disabled={busy || !date || !time}
              className="flex-1 rounded-xl bg-emerald-600 py-2 text-xs font-black text-white disabled:opacity-50">
              {busy ? "جارٍ الحجز…" : "أكّد الحجز"}
            </button>
            <button type="button" onClick={() => setBooking(false)}
              className="rounded-xl border border-slate-300 px-4 py-2 text-xs font-bold text-slate-600">
              رجوع
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

/* ═══════════════ نماذج الحالة والشدّة ═══════════════ */

function NewCase({ patientId, today, onSaved, onError }: {
  patientId: number; today: string; onSaved: () => void; onError: (message: string | null) => void;
}) {
  const [appliance, setAppliance] = useState<Appliance>("fixed_metal");
  const [arches, setArches] = useState<Arches>("both");
  const [slot, setSlot] = useState<SlotSize>("022");
  const [bracketSystem, setBracketSystem] = useState("MBT");
  const [startDate, setStartDate] = useState(today);
  const [plannedMonths, setPlannedMonths] = useState("18");
  const [saving, setSaving] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    onError(null);
    try {
      const response = await fetch("/api/ortho", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          patientId, appliance, arches, slot, bracketSystem, startDate,
          plannedMonths: Number(plannedMonths) || 18,
        }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) { onError(payload?.message ?? "تعذّر الفتح."); return; }
      onSaved();
    } catch {
      onError("تعذّر الاتصال بالخادم.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className="rounded-2xl border border-navy-800 bg-white p-4 shadow-xs">
      <h3 className="mb-3 text-sm font-black text-navy-900">فتح حالة تقويم جديدة</h3>
      <div className="mb-2 flex flex-wrap gap-2">
        <label className="min-w-[9rem] flex-1">
          <span className="mb-1 block text-[10px] font-bold text-slate-500">الجهاز</span>
          <select value={appliance} onChange={(event) => setAppliance(event.target.value as Appliance)}
            aria-label="نوع الجهاز"
            className="w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs">
            {(Object.keys(APPLIANCE_LABEL) as Appliance[]).map((value) => (
              <option key={value} value={value}>{APPLIANCE_LABEL[value]}</option>
            ))}
          </select>
        </label>
        <label className="min-w-[7rem] flex-1">
          <span className="mb-1 block text-[10px] font-bold text-slate-500">الفكّان</span>
          <select value={arches} onChange={(event) => setArches(event.target.value as Arches)}
            aria-label="الفكّان المعالَجان"
            className="w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs">
            {(Object.keys(ARCHES_LABEL) as Arches[]).map((value) => (
              <option key={value} value={value}>{ARCHES_LABEL[value]}</option>
            ))}
          </select>
        </label>
      </div>

      {usesArchwires(appliance) ? (
        <div className="mb-2 flex flex-wrap gap-2">
          <label className="min-w-[7rem] flex-1">
            <span className="mb-1 block text-[10px] font-bold text-slate-500">الشقّ</span>
            <select value={slot} onChange={(event) => setSlot(event.target.value as SlotSize)}
              aria-label="مقاس الشقّ"
              className="w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs">
              {(Object.keys(SLOT_LABEL) as SlotSize[]).map((value) => (
                <option key={value} value={value}>{SLOT_LABEL[value]}</option>
              ))}
            </select>
          </label>
          <label className="min-w-[8rem] flex-1">
            <span className="mb-1 block text-[10px] font-bold text-slate-500">نظام البراكيت</span>
            <input value={bracketSystem} onChange={(event) => setBracketSystem(event.target.value)}
              aria-label="نظام البراكيت" dir="ltr"
              className="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-xs font-mono" />
          </label>
        </div>
      ) : null}

      <div className="mb-3 flex flex-wrap gap-2">
        <label className="min-w-[9rem] flex-1">
          <span className="mb-1 block text-[10px] font-bold text-slate-500">تاريخ البدء</span>
          <input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)}
            aria-label="تاريخ بدء التقويم"
            className="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-xs" />
        </label>
        <label className="w-32">
          <span className="mb-1 block text-[10px] font-bold text-slate-500">المدة (أشهر)</span>
          <input value={plannedMonths} onChange={(event) => setPlannedMonths(event.target.value)}
            aria-label="المدة المتوقعة" inputMode="numeric" dir="ltr"
            className="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-xs" />
        </label>
      </div>

      <button type="submit" disabled={saving}
        className="w-full rounded-xl bg-navy-800 py-2.5 text-xs font-black text-white disabled:opacity-50">
        افتح الحالة
      </button>
    </form>
  );
}

function AdjustmentForm({ caseRow, today, wires, patientId, onSaved, onError }: {
  caseRow: OrthoCase; today: string; wires: { code: string }[]; patientId: number;
  onSaved: (result: {
    adjustmentId: number; caseId: number; doneOn: string;
    nextWeeks: number; photosUploaded: number;
  }) => void;
  onError: (message: string | null) => void;
}) {
  const suggestedUpper = nextWire(caseRow.slot, caseRow.upperWire)?.code ?? caseRow.upperWire ?? "";
  const suggestedLower = nextWire(caseRow.slot, caseRow.lowerWire)?.code ?? caseRow.lowerWire ?? "";

  const [doneOn, setDoneOn] = useState(today);
  const [upperWire, setUpperWire] = useState(suggestedUpper);
  const [lowerWire, setLowerWire] = useState(suggestedLower);
  const [elastics, setElastics] = useState<ElasticClass>("none");
  const [elasticNote, setElasticNote] = useState("");
  const [done, setDone] = useState("");
  const [nextWeeks, setNextWeeks] = useState("4");
  const [saving, setSaving] = useState(false);

  const [queue, setQueue] = useState<QueuedPhoto[]>([]);
  const [stage, setStage] = useState<PhotoStage>(() =>
    suggestPhotoStage({
      date: today, startDate: caseRow.startDate, phase: caseRow.phase,
      isFirstSession: caseRow.adjustments.length === 0,
    }),
  );
  const cameraInput = useRef<HTMLInputElement>(null);
  const galleryInput = useRef<HTMLInputElement>(null);

  const addFiles = (files: FileList | null) => {
    if (!files) return;
    const added: QueuedPhoto[] = [];
    for (const file of Array.from(files)) {
      if (!file.type.startsWith("image/")) continue;
      added.push({ file, preview: URL.createObjectURL(file), view: "" });
    }
    if (added.length > 0) setQueue((current) => [...current, ...added]);
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    onError(null);
    try {
      const response = await fetch(`/api/ortho/${caseRow.id}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          doneOn, upperWire, lowerWire, elastics, elasticNote, done,
          nextWeeks: Number(nextWeeks) || 4,
        }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) { onError(payload?.message ?? "تعذّر التسجيل."); return; }

      const adjustmentId = Number(payload?.id);
      let uploaded = 0;
      let failed = 0;
      for (const photo of queue) {
        try {
          const form = new FormData();
          form.set("file", photo.file);
          form.set("kind", "photo");
          form.set("title", `صورة جلسة ${friendlyDateLong(doneOn)}`);
          form.set("takenOn", doneOn);
          form.set("orthoCaseId", String(caseRow.id));
          form.set("adjustmentId", String(adjustmentId));
          form.set("photoStage", stage);
          if (photo.view) form.set("photoView", photo.view);
          const upload = await fetch(`/api/patients/${patientId}/documents`, { method: "POST", body: form });
          if (upload.ok) uploaded += 1; else failed += 1;
        } catch {
          failed += 1;
        }
      }
      if (failed > 0) {
        onError(`رُفعت ${uploaded} صورة وفشل ${failed} — أعد المحاولة من المستندات.`);
      }
      for (const photo of queue) URL.revokeObjectURL(photo.preview);

      onSaved({ adjustmentId, caseId: caseRow.id, doneOn, nextWeeks: Number(nextWeeks) || 4, photosUploaded: uploaded });
    } catch {
      onError("تعذّر الاتصال بالخادم.");
    } finally {
      setSaving(false);
    }
  };

  const options = [...new Set([...wires.map((wire) => wire.code),
    caseRow.upperWire, caseRow.lowerWire].filter(Boolean) as string[])];

  const fullSet = fullPhotoSetCheck({
    sessionDate: doneOn,
    startDate: caseRow.startDate,
    lastFullSetDate: caseRow.adjustments.find((entry) =>
      entry.photos.some((photo) => photo.photoStage === "initial"))?.doneOn ?? null,
    intervalMonths: 6,
    phase: caseRow.phase,
    capturedViews: queue.map((photo) => photo.view).filter((view): view is PhotoView => view !== ""),
  });

  return (
    <form onSubmit={submit} className="rounded-2xl border border-brand-orange bg-orange-50/50 p-4 shadow-xs">
      <p className="mb-2 text-xs font-black text-slate-800">تسجيل شدّة وتعديل جديد</p>

      {usesArchwires(caseRow.appliance) ? (
        <div className="mb-2 flex flex-wrap gap-2">
          <label className="min-w-[9rem] flex-1">
            <span className="mb-1 block text-[10px] font-bold text-slate-500">
              السلك العلوي {caseRow.upperWire ? `(الحالي ${caseRow.upperWire})` : ""}
            </span>
            <select value={upperWire} onChange={(event) => setUpperWire(event.target.value)}
              aria-label="السلك العلوي" dir="ltr"
              className="w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs font-mono">
              <option value="">— بلا تغيير —</option>
              {options.map((code) => <option key={code} value={code}>{code}</option>)}
            </select>
          </label>
          <label className="min-w-[9rem] flex-1">
            <span className="mb-1 block text-[10px] font-bold text-slate-500">
              السلك السفلي {caseRow.lowerWire ? `(الحالي ${caseRow.lowerWire})` : ""}
            </span>
            <select value={lowerWire} onChange={(event) => setLowerWire(event.target.value)}
              aria-label="السلك السفلي" dir="ltr"
              className="w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs font-mono">
              <option value="">— بلا تغيير —</option>
              {options.map((code) => <option key={code} value={code}>{code}</option>)}
            </select>
          </label>
        </div>
      ) : null}

      <div className="mb-2 flex flex-wrap gap-2">
        <label className="min-w-[8rem] flex-1">
          <span className="mb-1 block text-[10px] font-bold text-slate-500">المطاطات</span>
          <select value={elastics} onChange={(event) => setElastics(event.target.value as ElasticClass)}
            aria-label="صنف المطاطات"
            className="w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs">
            {(Object.keys(ELASTIC_LABEL) as ElasticClass[]).map((value) => (
              <option key={value} value={value}>{ELASTIC_LABEL[value]}</option>
            ))}
          </select>
        </label>
        {elastics !== "none" ? (
          <label className="min-w-[9rem] flex-1">
            <span className="mb-1 block text-[10px] font-bold text-slate-500">وصف المطاطات</span>
            <input value={elasticNote} onChange={(event) => setElasticNote(event.target.value)}
              aria-label="وصف المطاطات" placeholder="3/16 خفيفة — ليلًا"
              className="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-xs" />
          </label>
        ) : null}
      </div>

      <label className="mb-2 block">
        <span className="mb-1 block text-[10px] font-bold text-slate-500">ما نُفّذ</span>
        <input value={done} onChange={(event) => setDone(event.target.value)}
          aria-label="ما نُفّذ في الشدّة" placeholder="تبديل السلك وربط الأربطة وتثبيت المطاطات"
          className="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-xs" />
      </label>

      {/* صور الجلسة */}
      <div className="mb-2 rounded-xl border border-slate-200 bg-white p-3">
        <p className="mb-1.5 text-xs font-black text-slate-700">📷 صور الجلسة والكاميرا</p>
        {fullSet.required ? (
          <p className="mb-1.5 rounded-lg bg-amber-50 px-2 py-1 text-[10px] font-bold text-amber-800">
            {fullSet.reason}
            {fullSet.missingViews.length > 0 ? ` — ناقص: ${fullSet.missingViews.map((view) => PHOTO_VIEW_LABEL[view]).join("، ")}` : ""}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => cameraInput.current?.click()}
            className="min-w-[10rem] flex-1 rounded-xl bg-navy-800 py-2.5 text-xs font-black text-white hover:bg-navy-900">
            📷 التقط بالكاميرا الآن
          </button>
          <button type="button" onClick={() => galleryInput.current?.click()}
            className="rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-xs font-bold text-slate-700 hover:bg-slate-50">
            اختيار من المعرض
          </button>
        </div>

        <input ref={cameraInput} type="file" accept="image/*" capture="environment"
          aria-label="كاميرا الجلسة" className="sr-only"
          onChange={(event) => { addFiles(event.target.files); event.target.value = ""; }} />
        <input ref={galleryInput} type="file" accept="image/*" multiple
          aria-label="اختيار صور" className="sr-only"
          onChange={(event) => { addFiles(event.target.files); event.target.value = ""; }} />

        <label className="mt-2 block">
          <span className="mb-1 block text-[10px] font-bold text-slate-500">دور الصور المرفوعة</span>
          <select value={stage} onChange={(event) => setStage(event.target.value as PhotoStage)}
            aria-label="دور صور الجلسة"
            className="w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs">
            {(Object.keys(PHOTO_STAGE_LABEL) as PhotoStage[]).map((value) => (
              <option key={value} value={value}>{PHOTO_STAGE_LABEL[value]}</option>
            ))}
          </select>
        </label>

        {queue.length > 0 ? (
          <ul className="mt-2 space-y-1.5">
            {queue.map((photo, index) => (
              <li key={photo.preview} className="flex items-center gap-2 rounded-lg bg-slate-50 p-1.5">
                <img src={photo.preview} alt="صورة الجلسة" className="h-12 w-12 rounded-lg object-cover" />
                <select value={photo.view}
                  onChange={(event) => {
                    const view = event.target.value as PhotoView | "";
                    setQueue((current) => current.map((row, rowIndex) =>
                      rowIndex === index ? { ...row, view } : row));
                  }}
                  aria-label="وجه الصورة"
                  className="min-w-0 flex-1 rounded-lg border border-slate-200 bg-white px-2 py-1 text-[11px]">
                  <option value="">— وجه الصورة (اختياري) —</option>
                  {(Object.keys(PHOTO_VIEW_LABEL) as PhotoView[]).map((view) => (
                    <option key={view} value={view}>{PHOTO_VIEW_LABEL[view]}</option>
                  ))}
                </select>
                <button type="button"
                  onClick={() => {
                    URL.revokeObjectURL(photo.preview);
                    setQueue((current) => current.filter((_, rowIndex) => rowIndex !== index));
                  }}
                  className="text-[11px] font-bold text-red-500">حذف</button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      <div className="mb-2 flex flex-wrap gap-2">
        <label className="min-w-[9rem] flex-1">
          <span className="mb-1 block text-[10px] font-bold text-slate-500">تاريخ الشدّة</span>
          <input type="date" value={doneOn} onChange={(event) => setDoneOn(event.target.value)}
            aria-label="تاريخ الشدّة"
            className="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-xs" />
        </label>
        <label className="w-36">
          <span className="mb-1 block text-[10px] font-bold text-slate-500">القادمة بعد (أسابيع)</span>
          <input value={nextWeeks} onChange={(event) => setNextWeeks(event.target.value)}
            aria-label="أسابيع حتى الشدّة القادمة" inputMode="numeric" dir="ltr"
            className="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-xs font-mono" />
        </label>
      </div>

      <p className="mb-2 text-[10px] text-slate-500">
        الموعد المقترح: {friendlyDateLong(nextAdjustmentDate(doneOn, Number(nextWeeks) || 4))}
      </p>

      <button type="submit" disabled={saving}
        className="w-full rounded-xl bg-brand-orange py-2.5 text-xs font-black text-white hover:bg-amber-600 disabled:opacity-50">
        {saving ? "جارٍ الحفظ والرفع…" : "احفظ الشدّة والصور"}
      </button>
    </form>
  );
}

/* ═══════════════ مقارنة Before / Progress / After ═══════════════ */

function OrthoComparison({ patientId, orthoCaseId }: { patientId: number; orthoCaseId: number }) {
  const [photos, setPhotos] = useState<StagePhoto[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(`/api/patients/${patientId}/documents`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error("تعذّر التحميل.");
      const documents = (payload.documents ?? []) as {
        id: number; isImage: boolean; orthoCaseId: number | null;
        photoStage: string | null; photoView: string | null;
        takenOn: string | null; uploadedAt: string;
      }[];
      setPhotos(documents
        .filter((document) => document.orthoCaseId === orthoCaseId && document.isImage)
        .map((document) => ({
          id: document.id,
          stage: (document.photoStage ?? "progress") as PhotoStage,
          view: (document.photoView ?? null) as PhotoView | null,
          takenOn: document.takenOn,
          uploadedAt: document.uploadedAt,
        })));
    } catch {
      setPhotos([]);
    } finally {
      setLoading(false);
    }
  }, [patientId, orthoCaseId]);

  useEffect(() => { void load(); }, [load]);

  const columns = useMemo(() => buildComparison(photos), [photos]);
  const withPhotos = columns.filter((column) => column.count > 0);

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <h4 className="text-xs font-black text-navy-900 flex items-center gap-1.5">
          <span>📸</span> التوثيق الفوتوغرافي ومقارنة المراحل (Before / Progress / After)
        </h4>
        <span className="text-[10px] text-slate-500 font-bold">
          {photos.length} صورة مسجلة
        </span>
      </div>

      {loading ? (
        <p className="text-xs text-slate-400">جارٍ التحميل…</p>
      ) : withPhotos.length < 2 ? (
        <p className="rounded-xl border border-dashed border-slate-200 bg-slate-50 p-3 text-xs text-slate-500 text-center">
          التقط صورًا في مراحل التقويم المختلفة (ما قبل العلاج، أثناء الشدّات، وبعد العلاج) لتفعيل المقارنة التطورية الفورية.
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {withPhotos.map((column) => (
            <div key={column.stage} className="text-center rounded-xl bg-slate-50 p-2 border border-slate-100">
              <p className="mb-1 text-[11px] font-bold text-slate-700">{column.label}</p>
              {column.featured ? (
                <a href={`/api/documents/${column.featured.id}`} target="_blank" rel="noopener">
                  <img src={`/api/documents/${column.featured.id}`}
                    alt={column.label}
                    className="aspect-square w-full rounded-xl bg-slate-900 object-cover" />
                </a>
              ) : (
                <div className="aspect-square w-full rounded-xl bg-slate-200" />
              )}
              <p className="mt-1 text-[10px] text-slate-500">{column.count} صورة</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ═══════════════ التشخيص النسخي السريري ═══════════════ */

interface DiagnosisVersionView {
  id: number;
  version: number;
  content: Record<string, string | null>;
  label: string | null;
  createdBy: string;
  createdAt: string;
}

function PatientDiagnosis({ patientId, orthoCaseId, onError }: {
  patientId: number; orthoCaseId: number | null;
  onError: (message: string | null) => void;
}) {
  const [versions, setVersions] = useState<DiagnosisVersionView[]>([]);
  const [loading, setLoading] = useState(true);
  const [writing, setWriting] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(`/api/patients/${patientId}/diagnoses`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.message ?? "تعذّر التحميل.");
      setVersions(payload.diagnoses as DiagnosisVersionView[]);
    } catch {
      setVersions([]);
    } finally {
      setLoading(false);
    }
  }, [patientId]);

  useEffect(() => { void load(); }, [load]);

  const current = versions[0];

  const save = async (content: Record<string, string>, label: string) => {
    setSaving(true);
    onError(null);
    try {
      const response = await fetch(`/api/patients/${patientId}/diagnoses`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, label, orthoCaseId }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) { onError(payload?.message ?? "تعذّر الحفظ."); return; }
      setWriting(false);
      await load();
    } catch {
      onError("تعذّر الاتصال بالخادم.");
    } finally {
      setSaving(false);
    }
  };

  const lines = (content: Record<string, string | null>): string[] => {
    const names: Record<string, string> = {
      skeletal: "الصنف الهيكلي", dental: "الصنف السني", crowding: "الازدحام",
      overjet: "Overjet", bite: "الإطباق",
    };
    return Object.entries(content)
      .filter(([, value]) => value)
      .map(([key, value]) => key === "note" ? String(value) : `${names[key] ?? key}: ${value}`);
  };

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <h4 className="text-xs font-black text-navy-900 flex items-center gap-1.5">
          <span>📝</span> التشخيص السريري للفكين وتصنيف الحالة {current ? `(نسخة ${current.version})` : ""}
        </h4>
        <span className="text-[10px] text-slate-500 font-bold">
          {current ? friendlyDateLong(current.createdAt.slice(0, 10)) : "غير مسجل بعد"}
        </span>
      </div>

      <div className="space-y-2">
        {loading ? (
          <p className="text-xs text-slate-400">جارٍ التحميل…</p>
        ) : versions.length === 0 ? (
          <p className="rounded-xl bg-slate-50 p-3 text-xs text-slate-500 text-center">
            لا تشخيص سريري مسجل بعد — سجّل تشخيص البداية ليقارن عليه تقدم الحالة.
          </p>
        ) : (
          versions.map((version, index) => (
            <div key={version.id}
              className={`rounded-xl p-3 ${index === 0 ? "border border-navy-200 bg-navy-50/50" : "bg-slate-50"}`}>
              <p className="mb-1 text-[11px] font-extrabold text-slate-800">
                {version.version === 1 ? "تشخيص البداية" : `تحديث التشخيص — نسخة ${version.version}`}
                {version.label ? ` · ${version.label}` : ""}
                {" · "}{friendlyDateLong(version.createdAt.slice(0, 10))} · {version.createdBy}
              </p>
              <ul className="list-inside list-disc text-xs text-slate-700 space-y-0.5">
                {lines(version.content).map((line) => <li key={line}>{line}</li>)}
              </ul>
            </div>
          ))
        )}

        {!writing ? (
          <button onClick={() => setWriting(true)}
            className="w-full rounded-xl border border-navy-800 bg-white py-2 text-xs font-bold text-navy-800 hover:bg-navy-50 transition-colors">
            {current ? "+ تحديث التشخيص (نسخة جديدة — لا يمسح القديم)" : "+ سجّل تشخيص البداية"}
          </button>
        ) : (
          <DiagnosisForm saving={saving} onCancel={() => setWriting(false)} onSave={save} />
        )}
      </div>
    </div>
  );
}

function DiagnosisForm({ saving, onCancel, onSave }: {
  saving: boolean;
  onCancel: () => void;
  onSave: (content: Record<string, string>, label: string) => void;
}) {
  const [skeletal, setSkeletal] = useState("");
  const [dental, setDental] = useState("");
  const [crowding, setCrowding] = useState("");
  const [overjet, setOverjet] = useState("");
  const [bite, setBite] = useState("");
  const [note, setNote] = useState("");
  const [label, setLabel] = useState("");

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3 shadow-xs">
      <div className="mb-2 grid grid-cols-2 gap-2">
        <label>
          <span className="mb-1 block text-[10px] font-bold text-slate-500">الصنف الهيكلي</span>
          <input value={skeletal} onChange={(event) => setSkeletal(event.target.value)}
            placeholder="Class II هيكلي" aria-label="الصنف الهيكلي"
            className="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-xs" />
        </label>
        <label>
          <span className="mb-1 block text-[10px] font-bold text-slate-500">الصنف السني</span>
          <input value={dental} onChange={(event) => setDental(event.target.value)}
            placeholder="Class II Div 1" aria-label="الصنف السني" dir="ltr"
            className="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-xs font-mono" />
        </label>
        <label>
          <span className="mb-1 block text-[10px] font-bold text-slate-500">الازدحام</span>
          <input value={crowding} onChange={(event) => setCrowding(event.target.value)}
            placeholder="علوي 5 مم" aria-label="الازدحام"
            className="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-xs" />
        </label>
        <label>
          <span className="mb-1 block text-[10px] font-bold text-slate-500">Overjet</span>
          <input value={overjet} onChange={(event) => setOverjet(event.target.value)}
            placeholder="7 مم" aria-label="البعد الأفقي" dir="ltr"
            className="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-xs font-mono" />
        </label>
        <label>
          <span className="mb-1 block text-[10px] font-bold text-slate-500">الإطباق</span>
          <input value={bite} onChange={(event) => setBite(event.target.value)}
            placeholder="عضة عميقة 60%" aria-label="الإطباق"
            className="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-xs" />
        </label>
        <label>
          <span className="mb-1 block text-[10px] font-bold text-slate-500">سبب التحديث</span>
          <input value={label} onChange={(event) => setLabel(event.target.value)}
            placeholder="بعد ٦ أشهر من العلاج" aria-label="سبب التحديث"
            className="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-xs" />
        </label>
      </div>
      <label className="mb-2 block">
        <span className="mb-1 block text-[10px] font-bold text-slate-500">ملاحظات حرة</span>
        <textarea value={note} onChange={(event) => setNote(event.target.value)} rows={2}
          aria-label="ملاحظات التشخيص"
          className="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-xs" />
      </label>
      <div className="flex gap-2">
        <button type="button" disabled={saving}
          onClick={() => onSave({ skeletal, dental, crowding, overjet, bite, note }, label)}
          className="flex-1 rounded-xl bg-navy-800 py-2 text-xs font-black text-white disabled:opacity-50 hover:bg-navy-900">
          {saving ? "جارٍ الحفظ…" : "احفظ النسخة الجديدة"}
        </button>
        <button type="button" onClick={onCancel}
          className="rounded-xl border border-slate-300 px-4 py-2 text-xs font-bold text-slate-600 hover:bg-slate-50">
          إلغاء
        </button>
      </div>
    </div>
  );
}
