"use client";

import { useRouter } from "next/navigation";
import { use, useCallback, useEffect, useMemo, useState } from "react";
import type { Visit } from "@/lib/flow";
import type { Appointment } from "@/lib/schedule";
import {
  GENDER_LABEL,
  ageFromBirthYear,
  ageText,
  COMMON_MEDICAL_RISKS,
  parseMedicalAlerts,
  getBloodPressureRisk,
  type Gender,
  type Patient,
} from "@/lib/patient";

import { toWhatsAppNumber } from "@/lib/reminders";
import { PatientLedger } from "@/components/PatientLedger";
import { PatientPlans } from "@/components/PatientPlans";
import { DentalChart } from "@/components/DentalChart";
import { PatientDocuments } from "@/components/PatientDocuments";
import { PatientOrtho } from "@/components/PatientOrtho";
import { PatientCeph } from "@/components/PatientCeph";
import { PatientLabOrders } from "@/components/PatientLabOrders";
import { PatientMaterials } from "@/components/PatientMaterials";
import { QuickAppointmentModal } from "@/components/QuickAppointmentModal";
import { PrescriptionModal } from "@/components/PrescriptionModal";
import { CollectPaymentModal } from "@/components/CollectPaymentModal";
import { ChairsideTabletView } from "@/components/ChairsideTabletView";
import { VitalsModal } from "@/components/VitalsModal";
import { SummaryTab, type WorkflowSummary } from "@/components/patient/SummaryTab";
import { TodayVisitTab } from "@/components/patient/TodayVisitTab";
import { formatMoney, isCurrency, type Currency } from "@/lib/money";
import { nextStep } from "@/lib/workflow";
import { useSetting } from "@/components/SettingsProvider";
import { useSession } from "@/components/SessionProvider";
import { isAdmin } from "@/lib/roles";

interface PatientFile {
  patient: Patient;
  visits: Visit[];
  appointments: Appointment[];
}

/**
 * ملف المريض — رحلةٌ واحدة لا دليلُ تبويبات (المواصفة §٣-٥).
 *
 * خمسة تبويبات فقط: **الملخص** (ما المطلوب الآن؟)، **العلاج** (المخطط والخطة
 * والتقويم والمعمل)، **زيارة اليوم** (مساحة الطبيب)، **الحساب** (الرصيد
 * والحركات)، **الأشعة والملفات** (الأشعة والمستندات والسيفالو). وكل ما كان تبويبًا
 * مستقلًّا — المواعيد، الزيارات القديمة، المستهلكات — يظهر داخل مكانه الطبيعي.
 *
 * التقويم والأشعة دائمان في الظهور: التقويم قسمٌ ثابت في «العلاج» يعرض زر
 * «افتح حالة تقويم» حتى بلا حالة قائمة (لا يُخفى لغياب حالة)، والأشعة في
 * عنوان التبويب الأخير نفسه مع شارةٍ بعدد الأشعة والمستندات.
 *
 * والترويسة إجراءٌ رئيسٌ واحد: النظام يحدّد الخطوة التالية من حالة المريض، لا
 * من ذاكرة من يفتح الملف.
 */

type Tab = "summary" | "treatment" | "today" | "account" | "files";

const TABS: [Tab, string, string][] = [
  ["summary", "الملخص", "📊"],
  ["treatment", "العلاج", "🦷"],
  ["today", "زيارة اليوم", "🪑"],
  ["account", "الحساب", "💳"],
  ["files", "الأشعة والملفات", "🗂️"],
];

/** روابط التبويبات القديمة تصل مكانها الجديد — لا رابطٌ مكسور في النظام كله. */
const LEGACY_TAB_MAP: Record<string, Tab> = {
  overview: "summary", appointments: "summary",
  chart: "treatment", plans: "treatment", ortho: "treatment",
  lab: "treatment", materials: "treatment",
  ledger: "account",
  documents: "files", ceph: "files",
  visits: "today",
};

export default function PatientFilePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const session = useSession();
  const admin = isAdmin(session?.role);
  const baseSetting = useSetting("finance.base_currency");
  const base: Currency = isCurrency(baseSetting) ? baseSetting : "YER";

  const [file, setFile] = useState<PatientFile | null>(null);
  const [summary, setSummary] = useState<WorkflowSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState(false);
  const [showBookModal, setShowBookModal] = useState(false);
  const [showRxModal, setShowRxModal] = useState(false);
  const [showCollect, setShowCollect] = useState(false);
  const [showTabletMode, setShowTabletMode] = useState(false);
  const [showVitalsModal, setShowVitalsModal] = useState(false);
  const [copiedLabel, setCopiedLabel] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);

  const copyToClipboard = (text: string, label: string) => {
    try {
      void navigator.clipboard.writeText(text);
      setCopiedLabel(label);
      setTimeout(() => setCopiedLabel(null), 2500);
    } catch {
      // fallback
    }
  };

  /* حذف الملف نهائيًا — سلطة المدير: نافذة تأكيد صارمة تطلب رقم الملف نفسه،
   * والخادم يتحقق منه مرة ثانية. */
  const [showDeleteFile, setShowDeleteFile] = useState(false);
  const [deleteConfirmNumber, setDeleteConfirmNumber] = useState("");
  const [deleteReason, setDeleteReason] = useState("");
  const [deleting, setDeleting] = useState(false);

  const [tab, setTab] = useState<Tab>(() => {
    if (typeof window === "undefined") return "summary";
    const requested = new URLSearchParams(window.location.search).get("tab");
    if (!requested) return "summary";
    return (TABS.some(([key]) => key === requested) ? requested
      : LEGACY_TAB_MAP[requested] ?? "summary") as Tab;
  });
  const [editing, setEditing] = useState(false);

  /** طلبان لا خمسة: ملخص الرحلة يغني عن تحميل كل وحدة بكامل تفاصيلها (§٤٨). */
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [patientRes, workflowRes] = await Promise.all([
        fetch(`/api/patients/${id}`, { cache: "no-store" }),
        fetch(`/api/patients/${id}/workflow`, { cache: "no-store" }),
      ]);

      const payload = await patientRes.json();
      if (!patientRes.ok) throw new Error(payload?.message ?? "تعذّر التحميل.");
      setFile(payload as PatientFile);

      if (workflowRes.ok) {
        const data = await workflowRes.json();
        setSummary({
          openVisit: data.openVisit ?? null,
          lastVisit: data.lastVisit ?? null,
          nextAppointment: data.nextAppointment ?? null,
          activePlans: data.activePlans ?? [],
          plannedVisits: data.plannedVisits ?? [],
          counts: data.counts,
          financial: data.financial ?? null,
          alerts: data.alerts ?? [],
          canSeeFinancial: data.canSeeFinancial ?? false,
        });
      }
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "تعذّر التحميل.");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const confirmDeleteFile = async () => {
    if (!file || deleting) return;
    if (deleteConfirmNumber.trim() !== file.patient.patientNumber) {
      setError("اكتب رقم ملف المريض نفسه لتأكيد الحذف.");
      return;
    }
    setDeleting(true);
    setError(null);
    try {
      const res = await fetch(`/api/patients/${id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          confirmPatientNumber: deleteConfirmNumber.trim(),
          reason: deleteReason.trim() || null,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.message ?? "تعذّر حذف الملف.");
        return;
      }
      router.push("/patients");
    } catch {
      setError("تعذّر الاتصال بالخادم.");
    } finally {
      setDeleting(false);
    }
  };

  const today = useMemo(
    () => new Date().toISOString().slice(0, 10),
    [],
  );

  /*
   * الزر الرئيسي واحد — والنظام يختاره من حالة المريض (§٤):
   * زيارةٌ قائمة → استكمالها؛ موعد اليوم → بدء الزيارة؛ دَين → التحصيل؛
   * جلسةٌ غير مجدولة → حجزها؛ وإلا متابعةٌ أو إنشاء خطة.
   */
  const step = useMemo(() => {
    if (!summary) return null;
    return nextStep({
      openVisit: summary.openVisit ? { id: summary.openVisit.id } : null,
      todayAppointment: summary.nextAppointment &&
        summary.nextAppointment.date <= today &&
        summary.nextAppointment.status !== "done"
        ? { id: summary.nextAppointment.id }
        : null,
      debtMinor: summary.financial ? summary.financial.balanceMinor : null,
      unscheduledPlannedVisit: summary.plannedVisits.find(
        (visit) => visit.status === "planned" && !visit.appointmentDate,
      ) ? { id: 1 } : null,
      activePlan: summary.activePlans[0] ? { id: summary.activePlans[0].id } : null,
    });
  }, [summary, today]);

  const startTodayVisit = async () => {
    if (!file || busyAction) return;
    setBusyAction(true);
    setSuccessMsg(null);
    setError(null);
    try {
      const res = await fetch("/api/visits", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          patientId: file.patient.id,
          patientName: file.patient.fullName,
          patientPhone: file.patient.phone,
          note: "دخول مباشر من ملف المريض",
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.message ?? "تعذّر تسجيل الزيارة.");
        return;
      }
      await load();
      setTab("today");
    } catch {
      setError("تعذّر الاتصال بالخادم.");
    } finally {
      setBusyAction(false);
    }
  };

  if (loading && !file) {
    return (
      <main className="mx-auto max-w-4xl p-4">
        <p className="rounded-2xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-400">
          جارٍ تحميل ملخص رحلة المريض…
        </p>
      </main>
    );
  }

  if (!file) {
    return (
      <main className="mx-auto max-w-4xl p-4">
        <p role="alert" className="rounded-2xl border border-red-200 bg-red-50 p-6 text-center text-sm text-red-700">
          {error ?? "لا يوجد مريض بهذا الرقم."}
        </p>
        <a href="/patients" className="mt-4 block text-center text-sm font-bold text-navy-800">
          العودة لدليل المرضى
        </a>
      </main>
    );
  }

  const patient = file.patient;
  const whatsApp = toWhatsAppNumber(patient.phone);
  const age = ageFromBirthYear(patient.birthYear, today);
  const primaryPlan = summary?.activePlans[0] ?? null;

  const parsedAlerts = parseMedicalAlerts(patient.medicalAlert);
  const vitals = parsedAlerts.vitals;
  const bpRisk = getBloodPressureRisk(vitals?.bpSystolic, vitals?.bpDiastolic);

  const initials = patient.fullName
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join("");

  const primaryAction = (() => {
    if (!step) return null;
    switch (step.kind) {
      case "continue_visit":
        return { label: "استكمال زيارة اليوم", run: () => setTab("today"), primary: true };
      case "start_today_visit":
        return { label: "بدء زيارة اليوم", run: () => void startTodayVisit(), primary: true };
      case "collect_payment":
        return summary?.canSeeFinancial
          ? { label: "تحصيل دفعة", run: () => setShowCollect(true), primary: true }
          : null;
      case "schedule_next_visit":
        return { label: "حجز الجلسة القادمة", run: () => setTab("summary"), primary: true };
      default:
        return null;
    }
  })();

  return (
    <main className="mx-auto max-w-5xl p-4 pb-24">
      {/* رأس الملف السريري الاحترافي: هوية المريض، المؤشرات الحيوية، والأمان السريري */}
      <header className="mb-5 rounded-2xl border border-slate-200 bg-white p-5 shadow-xs">
        <div className="flex flex-wrap items-start justify-between gap-4">
          {/* قسم هوية المريض والبيانات التعريفية */}
          <div className="flex items-start gap-4 min-w-0">
            <div
              className={`flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl text-lg font-black shadow-md ${
                patient.gender === "female"
                  ? "bg-gradient-to-br from-pink-500 to-rose-600 text-white"
                  : "bg-gradient-to-br from-emerald-600 to-teal-700 text-white"
              }`}
            >
              {initials || "م"}
            </div>

            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-xl font-black text-navy-900 leading-tight">
                  {patient.fullName}
                </h1>

                {/* رقم الملف مع زر النسخ السريع */}
                <button
                  type="button"
                  onClick={() => copyToClipboard(patient.patientNumber, "patientNumber")}
                  title="نسخ رقم الملف الطبي"
                  className="flex items-center gap-1 rounded-lg bg-navy-50 px-2 py-0.5 text-xs font-extrabold text-navy-800 hover:bg-navy-100 transition-colors"
                >
                  <span>#{patient.patientNumber}</span>
                  <span className="text-[10px] opacity-60">📋</span>
                </button>

                {copiedLabel === "patientNumber" && (
                  <span className="text-[11px] font-bold text-emerald-600 animate-in fade-in">
                    تم نسخ الرقم ✓
                  </span>
                )}

                {/* شارة الرصيد المباشر */}
                {summary?.financial ? (
                  <span
                    className={`rounded-lg px-2.5 py-0.5 text-xs font-black ${
                      summary.financial.balanceMinor > 0
                        ? "border border-amber-300 bg-amber-100 text-amber-900"
                        : summary.financial.balanceMinor < 0
                        ? "border border-sky-300 bg-sky-100 text-sky-900"
                        : "border border-emerald-300 bg-emerald-100 text-emerald-900"
                    }`}
                  >
                    {summary.financial.balanceMinor > 0
                      ? `مستحق: ${formatMoney(summary.financial.balanceMinor, base)}`
                      : summary.financial.balanceMinor < 0
                      ? `رصيد دائن للمريض: ${formatMoney(-summary.financial.balanceMinor, base)}`
                      : "الرصيد خالص ✓"}
                  </span>
                ) : null}
              </div>

              {/* المعلومات الديموغرافية والاتصال السريع */}
              <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-slate-600">
                <span className="font-semibold text-slate-700">
                  {GENDER_LABEL[patient.gender]} · {ageText(age)}
                </span>
                {patient.phone ? (
                  <div className="flex items-center gap-1">
                    <span>·</span>
                    <button
                      type="button"
                      onClick={() => copyToClipboard(patient.phone!, "phone")}
                      className="font-medium text-slate-700 hover:text-navy-900 flex items-center gap-1"
                      title="نسخ الهاتف"
                    >
                      <span dir="ltr">📞 {patient.phone}</span>
                      <span className="text-[10px] opacity-60">📋</span>
                    </button>
                    {copiedLabel === "phone" && (
                      <span className="text-[10px] font-bold text-emerald-600">تم النسخ ✓</span>
                    )}
                    {whatsApp && (
                      <a
                        href={`https://wa.me/${whatsApp}`}
                        target="_blank"
                        rel="noopener"
                        className="rounded-md bg-emerald-50 px-1.5 py-0.5 text-[11px] font-bold text-emerald-700 hover:bg-emerald-100"
                      >
                        واتساب
                      </a>
                    )}
                  </div>
                ) : null}
                {primaryPlan?.specialty ? (
                  <span>· 🦷 {primaryPlan.specialty}</span>
                ) : null}
                {primaryPlan?.primaryDoctorName ? (
                  <span>· 👨‍⚕️ {primaryPlan.primaryDoctorName}</span>
                ) : null}
              </div>
            </div>
          </div>

          {/* شريط الإجراءات السريرية السريعة */}
          <div className="flex flex-wrap items-center gap-2">
            {primaryAction ? (
              <button
                type="button"
                onClick={primaryAction.run}
                disabled={busyAction}
                className="rounded-xl bg-brand-orange px-4 py-2 text-xs font-extrabold text-white shadow-xs transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                🪑 {primaryAction.label}
              </button>
            ) : null}

            <button
              type="button"
              onClick={() => setShowBookModal(true)}
              className="rounded-xl bg-navy-800 px-3 py-2 text-xs font-bold text-white transition-opacity hover:opacity-90"
            >
              📅 حجز موعد
            </button>

            <button
              type="button"
              onClick={() => setShowTabletMode(true)}
              className="rounded-xl border border-indigo-200 bg-indigo-50 px-3 py-2 text-xs font-black text-indigo-900 transition-colors hover:bg-indigo-100 flex items-center gap-1.5 shadow-xs"
              title="شاشة لمس مخصصة لطبيب الأسنان بجانب الكرسي الطبي"
            >
              <span>📱</span>
              <span>وضع الكرسي</span>
            </button>

            {/* زر طباعة الملف الطبي الشامل */}
            <a
              href={`/print/dossier/${patient.id}`}
              target="_blank"
              rel="noopener"
              className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-slate-700 hover:bg-slate-50 transition-colors flex items-center gap-1.5 shadow-xs"
              title="طباعة الملف الطبي السريري الشامل A4"
            >
              <span>🖨️</span>
              <span>الملف الشامل</span>
            </a>

            {/* زر فتح محطة العلامات الحيوية */}
            <button
              type="button"
              onClick={() => setShowVitalsModal(true)}
              className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-bold text-emerald-800 hover:bg-emerald-100 transition-colors flex items-center gap-1.5 shadow-xs"
              title="تسجيل وتحديث العلامات الحيوية وفصيلة الدم وضغط الدم"
            >
              <span>🩺</span>
              <span>العلامات الحيوية</span>
            </button>

            {/* القائمة المنسدلة: المزيد */}
            <details className="relative" open={moreOpen} onToggle={(event) => setMoreOpen(event.currentTarget.open)}>
              <summary className="cursor-pointer list-none rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-navy-800 hover:bg-slate-50">
                المزيد ⋯
              </summary>
              <div className="absolute left-0 z-20 mt-1.5 w-52 rounded-xl border border-slate-200 bg-white p-1.5 shadow-lg">
                {whatsApp ? (
                  <a href={`https://wa.me/${whatsApp}`} target="_blank" rel="noopener"
                    className="block rounded-lg px-3 py-2 text-xs font-bold text-emerald-700 hover:bg-emerald-50">
                    💬 محادثة واتساب
                  </a>
                ) : null}
                <a href={`/messages?patient=${patient.id}`}
                  className="block rounded-lg px-3 py-2 text-xs font-bold text-navy-800 hover:bg-slate-50">
                  ✉️ مراسلة المريض
                </a>
                <button type="button" onClick={() => setShowRxModal(true)}
                  className="block w-full rounded-lg px-3 py-2 text-right text-xs font-bold text-orange-800 hover:bg-orange-50">
                  ℞ وصفة طبية
                </button>
                <button type="button" onClick={() => setEditing((open) => !open)}
                  className="block w-full rounded-lg px-3 py-2 text-right text-xs font-bold text-navy-800 hover:bg-slate-50">
                  ✏️ تعديل بيانات الملف
                </button>
                {summary?.canSeeFinancial ? (
                  <a href={`/print/statement/${patient.id}`} target="_blank" rel="noopener"
                    className="block rounded-lg px-3 py-2 text-xs font-bold text-navy-800 hover:bg-slate-50">
                    🖨️ طباعة كشف حساب
                  </a>
                ) : null}
                <a href="/patients"
                  className="block rounded-lg px-3 py-2 text-xs font-bold text-slate-600 hover:bg-slate-50">
                  ‹ قائمة المرضى
                </a>
                {admin ? (
                  <button type="button"
                    onClick={() => {
                      setMoreOpen(false);
                      setShowDeleteFile(true);
                    }}
                    className="block w-full rounded-lg px-3 py-2 text-right text-xs font-bold text-red-700 hover:bg-red-50">
                    🗑 حذف الملف نهائيًا
                  </button>
                ) : null}
              </div>
            </details>
          </div>
        </div>

        {/* شريط المؤشرات الحيوية السريعة (Vital Signs Quick Strip) */}
        <div className="mt-3.5 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3">
          {vitals ? (
            <>
              {vitals.bpSystolic && vitals.bpDiastolic ? (
                <button
                  type="button"
                  onClick={() => setShowVitalsModal(true)}
                  className={`flex items-center gap-1.5 rounded-xl border px-3 py-1 text-xs font-black shadow-xs transition-transform hover:scale-105 ${
                    bpRisk.category === "normal"
                      ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                      : bpRisk.category === "elevated"
                      ? "border-yellow-200 bg-yellow-50 text-yellow-800"
                      : bpRisk.category === "stage1"
                      ? "border-amber-200 bg-amber-50 text-amber-800"
                      : "border-rose-300 bg-rose-100 text-rose-900 animate-pulse"
                  }`}
                  title={`${bpRisk.label}: ${bpRisk.clinicalNote}`}
                >
                  <span>🩺</span>
                  <span>الضغط: {vitals.bpSystolic}/{vitals.bpDiastolic} mmHg</span>
                  <span className="text-[10px] font-bold opacity-75">({bpRisk.label})</span>
                </button>
              ) : null}

              {vitals.bloodGroup ? (
                <button
                  type="button"
                  onClick={() => setShowVitalsModal(true)}
                  className="flex items-center gap-1 rounded-xl border border-rose-200 bg-rose-50 px-2.5 py-1 text-xs font-black text-rose-800 shadow-xs hover:bg-rose-100"
                  title="فصيلة دم المريض"
                >
                  <span>🩸</span>
                  <span>فصيلة الدم: {vitals.bloodGroup}</span>
                </button>
              ) : null}

              {vitals.pulse ? (
                <button
                  type="button"
                  onClick={() => setShowVitalsModal(true)}
                  className="flex items-center gap-1 rounded-xl border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-bold text-slate-700 hover:bg-slate-100"
                >
                  <span>❤️</span>
                  <span>النبض: {vitals.pulse} bpm</span>
                </button>
              ) : null}

              {vitals.bloodSugar ? (
                <button
                  type="button"
                  onClick={() => setShowVitalsModal(true)}
                  className="flex items-center gap-1 rounded-xl border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-bold text-slate-700 hover:bg-slate-100"
                >
                  <span>💉</span>
                  <span>السكر: {vitals.bloodSugar} mg/dL</span>
                </button>
              ) : null}
            </>
          ) : (
            <button
              type="button"
              onClick={() => setShowVitalsModal(true)}
              className="flex items-center gap-1.5 rounded-xl border border-dashed border-emerald-300 bg-emerald-50/50 px-3 py-1 text-xs font-bold text-emerald-800 hover:bg-emerald-100 transition-colors"
            >
              <span>🩺</span>
              <span>+ تسجيل العلامات الحيوية وفصيلة الدم</span>
            </button>
          )}
        </div>

        {/* التنبيه الطبي وشارات السلامة السريرية */}
        {patient.medicalAlert ? (
          <div className="mt-3 rounded-xl border border-red-300 bg-red-50 p-2.5 text-xs font-bold text-red-800 shadow-xs">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="flex items-center gap-1 font-black text-red-700">
                  <span className="text-base">⚠️</span> تنبيه أمان سريري:
                </span>
                {parsedAlerts.badges.map((b) => (
                  <span
                    key={b.id}
                    className={`inline-flex items-center gap-1 rounded-lg px-2 py-0.5 text-xs font-black shadow-xs ${
                      b.severity === "high"
                        ? "bg-red-600 text-white"
                        : "bg-amber-500 text-white"
                    }`}
                  >
                    <span>{b.icon}</span>
                    <span>{b.label}</span>
                  </span>
                ))}
                {parsedAlerts.customNote ? (
                  <span className="text-red-900 font-semibold">{parsedAlerts.customNote}</span>
                ) : null}
              </div>

              <button
                type="button"
                onClick={() => setShowVitalsModal(true)}
                className="rounded-lg bg-red-100 px-2.5 py-1 text-[11px] font-bold text-red-800 hover:bg-red-200 transition-colors"
              >
                ✏️ تعديل التنبيهات
              </button>
            </div>
          </div>
        ) : null}

        {/* الرصيد المالي في الرأس */}
        {summary?.financial && summary.financial.balanceMinor !== 0 ? (
          <p className={`mt-3 rounded-xl border px-3 py-2 text-xs font-bold ${
            summary.financial.balanceMinor > 0
              ? "border-amber-200 bg-amber-50 text-amber-800"
              : "border-emerald-200 bg-emerald-50 text-emerald-800"
          }`}>
            الرصيد: {formatMoney(summary.financial.balanceMinor, base)}
            {summary.financial.remainingTreatmentMinor > 0
              ? ` · باقي علاج (غير مستحق): ${formatMoney(summary.financial.remainingTreatmentMinor, base)}`
              : ""}
          </p>
        ) : null}

        {successMsg ? (
          <div className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50 p-2.5 text-xs font-bold text-emerald-800">
            ✓ {successMsg}
          </div>
        ) : null}
      </header>

      {error ? (
        <p role="alert" className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-2 text-xs font-bold text-red-700">
          {error}
        </p>
      ) : null}

      {editing ? (
        <PatientEditor
          patient={patient}
          onSaved={() => {
            setEditing(false);
            void load();
          }}
          onError={setError}
        />
      ) : null}

      <PrescriptionModal
        isOpen={showRxModal}
        onClose={() => setShowRxModal(false)}
        patientId={patient.id}
        patientName={patient.fullName}
        patientPhone={patient.phone}
        medicalAlert={patient.medicalAlert}
      />

      {/* خمسة تبويبات لا أحد عشر */}
      <div className="mb-4 flex flex-wrap items-center gap-1.5 border-b border-slate-200 pb-2">
        {TABS.map(([key, title, icon]) => {
          const isSelected = tab === key;
          const badge =
            key === "today" && summary?.openVisit ? " ●" : "";
          /* شارة عدد الأشعة والمستندات — الأشعة تُرى من الشريط نفسه لا من فتح التبويب */
          const filesCount =
            key === "files" && summary?.counts.documents ? summary.counts.documents : null;
          return (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`rounded-xl px-3.5 py-2 text-xs font-bold transition-all ${
                isSelected
                  ? "bg-navy-800 text-white shadow-xs"
                  : "bg-white text-slate-600 hover:bg-slate-100 border border-slate-200"
              }`}
            >
              <span className="ml-1">{icon}</span>
              {title}{badge}
              {filesCount != null ? (
                <span className={`mr-1.5 rounded-full px-1.5 text-[10px] font-extrabold ${
                  isSelected ? "bg-white/20 text-white" : "bg-sky-100 text-sky-700"
                }`}>
                  {filesCount}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      {/* محتوى التبويب — كل وحدة تحمّل بياناتها عند فتحها (§٤٨) */}
      {tab === "summary" ? (
        summary ? (
          <SummaryTab
            summary={summary}
            patientId={patient.id}
            patientName={patient.fullName}
            base={base}
            onVisitStarted={() => {
              setSuccessMsg("بدأت الزيارة — انتقل إلى تبويب «زيارة اليوم».");
              setTab("today");
              void load();
            }}
            onChanged={() => void load()}
            onGoToTab={(target) => setTab((target as Tab) ?? "summary")}
          />
        ) : (
          <p className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-400">
            تعذّر تحميل الملخص.
          </p>
        )
      ) : tab === "treatment" ? (
        <div className="space-y-4">
          <section aria-label="خطة العلاج">
            <div className="mb-2">
              <h2 className="text-sm font-extrabold text-navy-900">📋 خطة العلاج</h2>
            </div>
            <PatientPlans patientId={patient.id} />
          </section>
          <section aria-label="المخطط السني">
            <div className="mb-2">
              <h2 className="text-sm font-extrabold text-navy-900">🦷 المخطط السني</h2>
            </div>
            <DentalChart patientId={patient.id} />
          </section>
          { /* التقويم دائمًا ظاهر — حتى بلا حالة قائمة يبقى زر «افتح حالة تقويم»
             في متناول الطبيب؛ إخفاؤه لغياب حالة يعني أن أول حالة لا تُفتح أبدًا */ }
          <section aria-label="التقويم">
            <div className="mb-2 flex items-center gap-2">
              <h2 className="text-sm font-extrabold text-navy-900">📐 التقويم</h2>
              {summary?.counts.orthoCase ? (
                <span className="rounded-full border border-sky-200 bg-sky-50 px-2 py-0.5 text-[10px] font-bold text-sky-700">
                  حالة قائمة
                </span>
              ) : null}
            </div>
            <PatientOrtho patientId={patient.id} />
          </section>
          {summary && summary.counts.openLabOrders > 0 ? (
            <PatientLabOrders patientId={patient.id} patientName={patient.fullName} base={base} />
          ) : null}
          <details className="rounded-2xl border border-slate-200 bg-white p-3">
            <summary className="cursor-pointer text-xs font-extrabold text-navy-900">
              المستهلكات المصروفة للمريض
            </summary>
            <div className="mt-2">
              <PatientMaterials
                patientId={patient.id}
                visits={file.visits.map((v) => ({ id: v.id, arrivedAt: v.arrivedAt }))}
              />
            </div>
          </details>
        </div>
      ) : tab === "today" ? (
        <TodayVisitTab
          patientId={patient.id}
          patientName={patient.fullName}
          summary={summary}
          base={base}
          visits={file.visits}
          canCollect={summary?.canSeeFinancial ?? false}
          onVisitStarted={() => {
            setSuccessMsg("بدأت الزيارة.");
            void load();
          }}
          onChanged={() => void load()}
          onOpenTabletMode={() => setShowTabletMode(true)}
        />
      ) : tab === "account" ? (
        <PatientLedger patientId={patient.id} />
      ) : (
        <div className="space-y-4">
          <section aria-label="الأشعة والمستندات">
            <div className="mb-2 flex items-center gap-2">
              <h2 className="text-sm font-extrabold text-navy-900">🗂️ الأشعة والمستندات</h2>
              {summary?.counts.documents ? (
                <span className="rounded-full border border-sky-200 bg-sky-50 px-2 py-0.5 text-[10px] font-bold text-sky-700">
                  {summary.counts.documents}
                </span>
              ) : null}
            </div>
            <PatientDocuments patientId={patient.id} />
          </section>
          <section aria-label="التحليل السيفالومتري">
            <div className="mb-2 flex items-center gap-2">
              <h2 className="text-sm font-extrabold text-navy-900">📐 التحليل السيفالومتري</h2>
            </div>
            <PatientCeph patientId={patient.id} />
          </section>
        </div>
      )}

      {/* نوافذ الإجراءات */}
      <QuickAppointmentModal
        patientId={patient.id}
        patientName={patient.fullName}
        isOpen={showBookModal}
        onClose={() => setShowBookModal(false)}
        onSuccess={() => {
          setSuccessMsg("تم حجز الموعد بنجاح!");
          void load();
        }}
      />

      <CollectPaymentModal
        patientId={patient.id}
        patientName={patient.fullName}
        isOpen={showCollect}
        onClose={() => setShowCollect(false)}
        onSuccess={() => {
          setShowCollect(false);
          setSuccessMsg("سُجّلت الدفعة.");
          void load();
        }}
        suggestedMinor={
          summary?.financial && summary.financial.balanceMinor > 0
            ? summary.financial.balanceMinor
            : null
        }
      />

      {/* واجهة وضع الكرسي والشاشات اللمسية للأطباء */}
      {showTabletMode && file?.patient ? (
        <ChairsideTabletView
          patient={file.patient}
          visitId={summary?.openVisit?.id ?? null}
          onClose={() => setShowTabletMode(false)}
          onProcedureSelected={(proc) => {
            setSuccessMsg(`تم تسجيل إجراء في وضع الكرسي: ${proc}`);
            void load();
          }}
        />
      ) : null}

      {/* محطة قياس وتسجيل العلامات الحيوية وفصيلة الدم */}
      {file?.patient ? (
        <VitalsModal
          patientId={file.patient.id}
          patientName={file.patient.fullName}
          currentMedicalAlert={file.patient.medicalAlert}
          isOpen={showVitalsModal}
          onClose={() => setShowVitalsModal(false)}
          onSaved={(newAlert) => {
            setFile((prev) =>
              prev
                ? {
                    ...prev,
                    patient: { ...prev.patient, medicalAlert: newAlert },
                  }
                : prev,
            );
            setSuccessMsg("تم تحديث العلامات الحيوية والتنبيه الطبي بنجاح.");
            void load();
          }}
        />
      ) : null}

      {/* نافذة حذف الملف نهائيًا — المدير وحده، والتأكيد برقم الملف نفسه */}
      {showDeleteFile && file ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-navy-950/70 p-4 backdrop-blur-xs overflow-y-auto"
          onClick={(e) => {
            if (e.target === e.currentTarget && !deleting) setShowDeleteFile(false);
          }}
        >
          <div className="my-6 w-full max-w-md rounded-2xl border border-red-200 bg-white p-5 shadow-2xl">
            <div className="mb-3 flex items-center gap-2">
              <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-red-100 text-lg">🗑</span>
              <div>
                <h3 className="text-sm font-black text-red-800">حذف ملف المريض نهائيًا</h3>
                <p className="text-[11px] text-slate-500">
                  {file.patient.fullName} — {file.patient.patientNumber}
                </p>
              </div>
            </div>

            <p className="rounded-xl bg-red-50 p-3 text-[11px] leading-5 text-red-800">
              يمحو الحذف الملف كاملًا: زياراته ومواعيده وفواتيره ودفعاته وخطط علاجه
              وأشعته وأعمال معمله وحالات أسنانه — كلها في معاملة واحدة لا تراجع بعدها.
              {summary?.counts
                ? ` يشمل الملف ${summary.counts.visits} زيارة${
                    summary.counts.openLabOrders > 0
                      ? ` و${summary.counts.openLabOrders} عمل معمل قائم`
                      : ""
                  }${summary.counts.documents > 0 ? ` و${summary.counts.documents} مستند` : ""}.`
                : ""}
              {summary?.financial && summary.financial.balanceMinor > 0
                ? ` وعليه رصيد مستحق ${formatMoney(summary.financial.balanceMinor, base)} يُمحى معه — تأكد أن تحصيله ليس قائمًا.`
                : ""}
              يبقى للحذف أثرٌ في سجل التدقيق باسمك وصورة الملف المحذوف.
            </p>

            <label className="mt-3 block">
              <span className="mb-1 block text-xs font-bold text-slate-700">
                اكتب رقم الملف ({file.patient.patientNumber}) لتأكيد الحذف
              </span>
              <input
                value={deleteConfirmNumber}
                onChange={(e) => setDeleteConfirmNumber(e.target.value)}
                dir="ltr"
                className="w-full rounded-xl border border-red-300 bg-red-50/40 px-3 py-2 text-center text-sm font-black font-mono text-red-800 outline-none focus:border-red-500"
                placeholder={file.patient.patientNumber}
              />
            </label>

            <label className="mt-2 block">
              <span className="mb-1 block text-xs font-bold text-slate-700">سبب الحذف (اختياري — يُسجّل في التدقيق)</span>
              <input
                value={deleteReason}
                onChange={(e) => setDeleteReason(e.target.value)}
                className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs outline-none focus:border-navy-800"
                placeholder="مثال: ملف اختباري أُنشئ بالخطأ"
              />
            </label>

            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowDeleteFile(false)}
                disabled={deleting}
                className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-xs font-bold text-slate-600 disabled:opacity-40"
              >
                إلغاء
              </button>
              <button
                type="button"
                onClick={() => void confirmDeleteFile()}
                disabled={
                  deleting || deleteConfirmNumber.trim() !== file.patient.patientNumber
                }
                className="rounded-xl bg-red-600 px-5 py-2 text-xs font-black text-white shadow-xs hover:bg-red-700 disabled:opacity-40"
              >
                {deleting ? "جارٍ الحذف…" : "حذف نهائي لا رجعة فيه"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}

function PatientEditor({
  patient,
  onSaved,
  onError,
}: {
  patient: Patient;
  onSaved: () => void;
  onError: (message: string | null) => void;
}) {
  const [form, setForm] = useState({
    fullName: patient.fullName,
    phone: patient.phone ?? "",
    altPhone: patient.altPhone ?? "",
    gender: patient.gender,
    birthYear: patient.birthYear ? String(patient.birthYear) : "",
    address: patient.address ?? "",
    medicalAlert: patient.medicalAlert ?? "",
    note: patient.note ?? "",
  });
  const [saving, setSaving] = useState(false);

  const set = (key: keyof typeof form, value: string) =>
    setForm((current) => ({ ...current, [key]: value }));

  const save = async () => {
    if (saving) return;
    setSaving(true);
    onError(null);
    try {
      const response = await fetch(`/api/patients/${patient.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        onError(payload?.message ?? "تعذّر الحفظ.");
        return;
      }
      onSaved();
    } catch {
      onError("تعذّر الاتصال بالخادم.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="mb-4 rounded-2xl border border-navy-800 bg-white p-4 shadow-sm" aria-label="تعديل البيانات">
      <h2 className="mb-3 text-sm font-extrabold text-navy-900">تعديل بيانات المريض</h2>

      <Field label="الاسم الكامل">
        <input value={form.fullName} onChange={(e) => set("fullName", e.target.value)} className={inputClass} />
      </Field>

      <div className="flex flex-wrap gap-2">
        <Field label="رقم الجوال" className="min-w-[9rem] flex-1">
          <input
            value={form.phone}
            onChange={(e) => set("phone", e.target.value)}
            dir="ltr"
            inputMode="tel"
            className={inputClass}
          />
        </Field>
        <Field label="رقم بديل" className="min-w-[9rem] flex-1">
          <input
            value={form.altPhone}
            onChange={(e) => set("altPhone", e.target.value)}
            dir="ltr"
            inputMode="tel"
            className={inputClass}
          />
        </Field>
        <Field label="سنة الميلاد" className="w-28">
          <input
            value={form.birthYear}
            onChange={(e) => set("birthYear", e.target.value)}
            dir="ltr"
            inputMode="numeric"
            className={inputClass}
          />
        </Field>
      </div>

      <Field label="الجنس">
        <div className="flex gap-2">
          {(["male", "female", "unknown"] as Gender[]).map((option) => (
            <label key={option} className="flex items-center gap-1.5 text-xs font-bold text-slate-700">
              <input
                type="radio"
                name="gender"
                checked={form.gender === option}
                onChange={() => set("gender", option)}
              />
              {GENDER_LABEL[option]}
            </label>
          ))}
        </div>
      </Field>

      <Field label="العنوان / الحي">
        <input value={form.address} onChange={(e) => set("address", e.target.value)} className={inputClass} />
      </Field>

      <Field label="تنبيه طبي (حساسية بنج، أمراض مزمنة، أدوية سيولة)">
        <input
          value={form.medicalAlert}
          onChange={(e) => set("medicalAlert", e.target.value)}
          placeholder="مثال: حساسية بنسيلين، ضغط وسكر"
          className={`${inputClass} border-red-300 bg-red-50/50 text-red-700 font-bold`}
        />
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] font-bold text-slate-500">اختيار سريع:</span>
          {COMMON_MEDICAL_RISKS.map((risk) => {
            const isIncluded = form.medicalAlert.includes(risk.label) || risk.keywords.some((k) => form.medicalAlert.toLowerCase().includes(k.toLowerCase()));
            return (
              <button
                key={risk.id}
                type="button"
                onClick={() => {
                  if (isIncluded) return;
                  const prefix = form.medicalAlert.trim() ? `${form.medicalAlert.trim()}، ` : "";
                  set("medicalAlert", `${prefix}${risk.label}`);
                }}
                className={`inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-[11px] font-bold transition-all ${
                  isIncluded
                    ? "border-red-400 bg-red-100 text-red-800 opacity-60 cursor-default"
                    : "border-slate-200 bg-slate-50 text-slate-700 hover:border-red-300 hover:bg-red-50 hover:text-red-700"
                }`}
              >
                <span>{risk.icon}</span>
                <span>{risk.label}</span>
              </button>
            );
          })}
        </div>
      </Field>

      <Field label="ملاحظات عامة">
        <textarea
          value={form.note}
          onChange={(e) => set("note", e.target.value)}
          rows={2}
          className={`${inputClass} leading-5`}
        />
      </Field>

      <div className="mt-3 flex justify-end gap-2">
        <button
          type="button"
          onClick={save}
          disabled={saving || !form.fullName.trim()}
          className="rounded-xl bg-navy-800 px-5 py-2 text-xs font-bold text-white transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          {saving ? "جارٍ الحفظ…" : "حفظ التغييرات"}
        </button>
      </div>
    </section>
  );
}

function Field({
  label,
  children,
  className = "",
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={`mb-2 block ${className}`}>
      <span className="mb-1 block text-xs font-bold text-slate-700">{label}</span>
      {children}
    </label>
  );
}

const inputClass =
  "w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-navy-900 outline-none transition-colors focus:border-navy-800";
