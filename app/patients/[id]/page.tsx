"use client";

import { use, useCallback, useEffect, useMemo, useState } from "react";
import type { Visit } from "@/lib/flow";
import type { Appointment } from "@/lib/schedule";
import { GENDER_LABEL, ageFromBirthYear, ageText, type Gender, type Patient } from "@/lib/patient";
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
import { SummaryTab, type WorkflowSummary } from "@/components/patient/SummaryTab";
import { TodayVisitTab } from "@/components/patient/TodayVisitTab";
import { formatMoney, isCurrency, type Currency } from "@/lib/money";
import { nextStep } from "@/lib/workflow";
import { useSetting } from "@/components/SettingsProvider";

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
  const [moreOpen, setMoreOpen] = useState(false);

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
      {/* رأس الملف: ما يهم فقط + إجراءٌ رئيسٌ واحد (§٤) */}
      <header className="mb-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-xs">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-black text-navy-900 leading-tight">{patient.fullName}</h1>
              <span className="rounded-lg bg-navy-50 px-2 py-0.5 text-xs font-extrabold text-navy-800">
                {patient.patientNumber}
              </span>
              {/* شارة الرصيد المباشر (من عمل الوكيل المساعد) — لمن يملكه فقط؛
                  الخادم قرّر لا الشاشة: null يعني محجوبًا عن هذا الدور. */}
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
            <p className="mt-1 text-xs text-slate-500">
              {GENDER_LABEL[patient.gender]} · {ageText(age)}
              {patient.phone ? ` · 📞 ${patient.phone}` : ""}
              {primaryPlan?.specialty ? ` · ${primaryPlan.specialty}` : ""}
              {primaryPlan?.primaryDoctorName ? ` · ${primaryPlan.primaryDoctorName}` : ""}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
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

            {/* المزيد ⋯ — ما لا يستحق زرًّا دائمًا (§٤١: الأزرار تظهر عندما تحتاج) */}
            <details className="relative" open={moreOpen} onToggle={(event) => setMoreOpen(event.currentTarget.open)}>
              <summary className="cursor-pointer list-none rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-navy-800 hover:bg-slate-50">
                المزيد ⋯
              </summary>
              <div className="absolute left-0 z-20 mt-1.5 w-52 rounded-xl border border-slate-200 bg-white p-1.5 shadow-lg">
                {whatsApp ? (
                  <a href={`https://wa.me/${whatsApp}`} target="_blank" rel="noopener"
                    className="block rounded-lg px-3 py-2 text-xs font-bold text-emerald-700 hover:bg-emerald-50">
                    💬 واتساب
                  </a>
                ) : null}
                <a href={`/messages?patient=${patient.id}`}
                  className="block rounded-lg px-3 py-2 text-xs font-bold text-navy-800 hover:bg-slate-50">
                  ✉️ مراسلة
                </a>
                <button type="button" onClick={() => setShowRxModal(true)}
                  className="block w-full rounded-lg px-3 py-2 text-right text-xs font-bold text-orange-800 hover:bg-orange-50">
                  ℞ وصفة طبية
                </button>
                <button type="button" onClick={() => setEditing((open) => !open)}
                  className="block w-full rounded-lg px-3 py-2 text-right text-xs font-bold text-navy-800 hover:bg-slate-50">
                  ✏️ تعديل الملف
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
              </div>
            </details>
          </div>
        </div>

        {/* التنبيه الطبي */}
        {patient.medicalAlert ? (
          <div className="mt-3 flex items-center gap-2 rounded-xl border border-red-300 bg-red-50 p-2.5 text-xs font-extrabold text-red-700">
            <span className="text-sm">⚠️</span>
            <span>تنبيه طبي حرج: {patient.medicalAlert}</span>
          </div>
        ) : null}

        {/* الرصيد في الرأس — لمن يملكه فقط؛ الخادم قرّر لا الشاشة */}
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
