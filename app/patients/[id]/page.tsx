"use client";

import { use, useCallback, useEffect, useMemo, useState } from "react";
import type { Visit } from "@/lib/flow";
import type { Appointment } from "@/lib/schedule";
import { GENDER_LABEL, ageFromBirthYear, ageText, type Gender, type Patient } from "@/lib/patient";
import { friendlyDate, friendlyDateLong, friendlyTime, toWhatsAppNumber } from "@/lib/reminders";
import {
  clinicDateString,
  getAppointmentTypeLabel,
  getAppointmentTypeBadge,
} from "@/lib/schedule";
import { PatientLedger } from "@/components/PatientLedger";
import { PatientPlans } from "@/components/PatientPlans";
import { shortMinutes } from "@/lib/report";
import { DentalChart } from "@/components/DentalChart";
import { PatientDocuments } from "@/components/PatientDocuments";
import { PatientOrtho } from "@/components/PatientOrtho";
import { PatientCeph } from "@/components/PatientCeph";
import { PatientLabOrders } from "@/components/PatientLabOrders";
import { PatientMaterials } from "@/components/PatientMaterials";
import { QuickAppointmentModal } from "@/components/QuickAppointmentModal";
import { PrescriptionModal } from "@/components/PrescriptionModal";
import { formatMoney, type Currency, isCurrency } from "@/lib/money";
import { useSetting } from "@/components/SettingsProvider";

interface PatientFile {
  patient: Patient;
  visits: Visit[];
  appointments: Appointment[];
}

const STATUS_LABEL: Record<string, string> = {
  booked: "محجوز",
  arrived: "وصل",
  done: "تم",
  cancelled: "ملغى",
  no_show: "لم يحضر",
};

function dateOnly(iso: string): string {
  const parsed = new Date(iso);
  return `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, "0")}-${String(parsed.getDate()).padStart(2, "0")}`;
}

type Tab =
  | "overview"
  | "chart"
  | "plans"
  | "ledger"
  | "lab"
  | "materials"
  | "ortho"
  | "documents"
  | "ceph"
  | "appointments"
  | "visits";

const TABS: [Tab, string, string][] = [
  ["overview", "نظرة عامة والوحدات", "📊"],
  ["chart", "المخطط السني", "🦷"],
  ["plans", "خطة العلاج", "📋"],
  ["ledger", "الحساب المالي", "💳"],
  ["lab", "المعمل والتركيبات", "🧪"],
  ["materials", "المستهلكات والمخزن", "📦"],
  ["ortho", "التقويم", "📐"],
  ["documents", "الأشعة والمستندات", "📁"],
  ["ceph", "السيفالومتري", "📐"],
  ["appointments", "المواعيد", "📅"],
  ["visits", "الزيارات السريرية", "🪑"],
];

export default function PatientFilePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const today = useMemo(() => clinicDateString(new Date(), "Asia/Aden"), []);
  const baseSetting = useSetting("finance.base_currency");
  const base: Currency = isCurrency(baseSetting) ? baseSetting : "YER";

  const [file, setFile] = useState<PatientFile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState(false);
  const [showBookModal, setShowBookModal] = useState(false);
  const [showRxModal, setShowRxModal] = useState(false);

  // Financial summary & connected data for overview
  const [ledgerSummary, setLedgerSummary] = useState<{
    balanceMinor: number;
    invoicedMinor: number;
    paidMinor: number;
  } | null>(null);
  const [activePlan, setActivePlan] = useState<{
    title: string;
    itemsCount: number;
    doneCount: number;
    totalMinor: number;
  } | null>(null);
  const [labOrdersCount, setLabOrdersCount] = useState<number>(0);
  const [materialsCount, setMaterialsCount] = useState<number>(0);

  const [tab, setTab] = useState<Tab>(() => {
    if (typeof window === "undefined") return "overview";
    const requested = new URLSearchParams(window.location.search).get("tab");
    return TABS.some(([key]) => key === requested) ? (requested as Tab) : "overview";
  });
  const [editing, setEditing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [patientRes, ledgerRes, plansRes, labRes, matRes] = await Promise.all([
        fetch(`/api/patients/${id}`, { cache: "no-store" }),
        fetch(`/api/patients/${id}/ledger`, { cache: "no-store" }),
        fetch(`/api/patients/${id}/plans`, { cache: "no-store" }),
        fetch(`/api/lab?patientId=${id}`, { cache: "no-store" }),
        fetch(`/api/patients/${id}/materials`, { cache: "no-store" }),
      ]);

      const payload = await patientRes.json();
      if (!patientRes.ok) throw new Error(payload?.message ?? "تعذّر التحميل.");
      setFile(payload as PatientFile);

      if (ledgerRes.ok) {
        const lData = await ledgerRes.json();
        setLedgerSummary({
          balanceMinor: lData.balanceMinor ?? 0,
          invoicedMinor: lData.invoicedMinor ?? 0,
          paidMinor: lData.paidMinor ?? 0,
        });
      }

      if (plansRes.ok) {
        const pData = await plansRes.json();
        const active = (pData.plans ?? []).find((p: any) => p.status === "active" || p.status === "accepted");
        if (active) {
          setActivePlan({
            title: active.title,
            itemsCount: active.items?.length ?? 0,
            doneCount: active.items?.filter((it: any) => it.status === "done").length ?? 0,
            totalMinor: active.totalMinor ?? 0,
          });
        }
      }

      if (labRes.ok) {
        const labData = await labRes.json();
        const list = Array.isArray(labData) ? labData : labData.orders ?? [];
        setLabOrdersCount(list.length);
      }

      if (matRes.ok) {
        const matData = await matRes.json();
        const mList = Array.isArray(matData) ? matData : matData.movements ?? [];
        setMaterialsCount(mList.length);
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

  const upcoming = useMemo(() => {
    if (!file) return null;
    return (
      [...file.appointments]
        .filter((a) => a.scheduledDate >= today && (a.status === "booked" || a.status === "arrived"))
        .sort((a, b) => (a.scheduledDate + a.scheduledTime).localeCompare(b.scheduledDate + b.scheduledTime))[0] ??
      null
    );
  }, [file, today]);

  // بدء زيارة اليوم بنقرة واحدة
  const handleStartTodayVisit = async () => {
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
      setSuccessMsg("تم تسجيل زيارة اليوم وإضافة المريض لقائمة الانتظار بنجاح!");
      await load();
      setTab("visits");
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
          جارٍ تحميل ملف المريض والوحدات المترابطة…
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
  const lastVisit = file.visits[0] ?? null;
  const age = ageFromBirthYear(patient.birthYear, today);

  return (
    <main className="mx-auto max-w-5xl p-4 pb-24">
      {/* بطاقة رأس المريض والأزرار السريعة */}
      <header className="mb-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-xs">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-black text-navy-900 leading-tight">{patient.fullName}</h1>
              <span className="rounded-lg bg-navy-50 px-2 py-0.5 text-xs font-extrabold text-navy-800">
                {patient.patientNumber}
              </span>
            </div>
            <p className="mt-1 text-xs text-slate-500">
              {GENDER_LABEL[patient.gender]} · {ageText(age)}
              {patient.phone ? ` · 📞 ${patient.phone}` : ""}
              {patient.address ? ` · 📍 ${patient.address}` : ""}
            </p>
          </div>

          {/* شريط الإجراءات والترابط السريع */}
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={handleStartTodayVisit}
              disabled={busyAction}
              className="rounded-xl bg-brand-orange px-3.5 py-1.5 text-xs font-extrabold text-white shadow-xs transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              🪑 بدء زيارة اليوم
            </button>

            <button
              type="button"
              onClick={() => setShowBookModal(true)}
              className="rounded-xl bg-navy-800 px-3 py-1.5 text-xs font-bold text-white transition-opacity hover:opacity-90"
            >
              📅 حجز موعد
            </button>

            {whatsApp ? (
              <a
                href={`https://wa.me/${whatsApp}`}
                target="_blank"
                rel="noopener"
                className="rounded-xl bg-emerald-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-emerald-700"
              >
                💬 واتساب
              </a>
            ) : null}

            <a
              href={`/messages?patient=${patient.id}`}
              className="rounded-xl border border-navy-200 bg-navy-50 px-3 py-1.5 text-xs font-bold text-navy-800 hover:bg-navy-100"
              title="فتح خيط مراسلة هذا المريض — يظهر في بوابة المريض"
            >
              ✉️ مراسلة
            </a>

            <button
              type="button"
              onClick={() => setShowRxModal(true)}
              className="rounded-xl border border-brand-orange/50 bg-orange-50 px-3 py-1.5 text-xs font-extrabold text-orange-800 transition-colors hover:bg-orange-100"
              title="إصدار وصفة طبية — الأدوية بالإنجليزية والتعليمات عربي أو إنجليزي، طباعة A5 وواتساب"
            >
              ℞ وصفة طبية
            </button>

            <button
              onClick={() => setEditing((open) => !open)}
              className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-bold text-navy-800 hover:bg-slate-100"
            >
              {editing ? "إغلاق" : "✏️ تعديل الملف"}
            </button>

            <a
              href="/patients"
              className="rounded-xl border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-bold text-slate-600 hover:bg-slate-50"
            >
              ‹ قائمة المرضى
            </a>
          </div>
        </div>

        {/* التنبيه الطبي */}
        {patient.medicalAlert ? (
          <div className="mt-3 flex items-center gap-2 rounded-xl border border-red-300 bg-red-50 p-2.5 text-xs font-extrabold text-red-700">
            <span className="text-sm">⚠️</span>
            <span>تنبيه طبي حرج: {patient.medicalAlert}</span>
          </div>
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

      {/* نافذة الوصفة الطبية — تفتح من شريط إجراءات المريض */}
      <PrescriptionModal
        isOpen={showRxModal}
        onClose={() => setShowRxModal(false)}
        patientId={patient.id}
        patientName={patient.fullName}
        patientPhone={patient.phone}
        medicalAlert={patient.medicalAlert}
      />

      {/* شريط تبويبات الوحدات المتصلة بملف المريض */}
      <div className="mb-4 flex flex-wrap items-center gap-1.5 border-b border-slate-200 pb-2">
        {TABS.map(([key, title, icon]) => {
          let countBadge = "";
          if (key === "appointments") countBadge = ` (${file.appointments.length})`;
          if (key === "visits") countBadge = ` (${file.visits.length})`;
          if (key === "lab" && labOrdersCount > 0) countBadge = ` (${labOrdersCount})`;
          if (key === "materials" && materialsCount > 0) countBadge = ` (${materialsCount})`;

          const isSelected = tab === key;
          return (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`rounded-xl px-3 py-1.5 text-xs font-bold transition-all ${
                isSelected
                  ? "bg-navy-800 text-white shadow-xs"
                  : "bg-white text-slate-600 hover:bg-slate-100 border border-slate-200"
              }`}
            >
              <span className="ml-1">{icon}</span>
              {title}
              {countBadge}
            </button>
          );
        })}
      </div>

      {/* محتوى التبويب المختار */}
      {tab === "overview" ? (
        <div className="space-y-4">
          {/* بطاقات المؤشرات المترابطة مع باقي الوحدات */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {/* 1. بطاقة الحساب المالي */}
            <div
              onClick={() => setTab("ledger")}
              className="cursor-pointer rounded-2xl border border-slate-200 bg-white p-4 transition-all hover:border-navy-800 hover:shadow-xs"
            >
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-slate-500">الحساب المالي</span>
                <span className="rounded-lg bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-navy-800">
                  فتح السجل ‹
                </span>
              </div>
              <p
                className={`mt-2 text-lg font-black ${
                  (ledgerSummary?.balanceMinor ?? 0) > 0 ? "text-amber-600" : "text-emerald-600"
                }`}
              >
                {ledgerSummary ? formatMoney(ledgerSummary.balanceMinor, base) : "—"}
              </p>
              <p className="text-[11px] text-slate-500">
                {(ledgerSummary?.balanceMinor ?? 0) > 0 ? "مستحق على المريض" : "الرصيد خالص"}
                {ledgerSummary ? ` · المفوتر: ${formatMoney(ledgerSummary.invoicedMinor, base)}` : ""}
              </p>
            </div>

            {/* 2. بطاقة خطة العلاج */}
            <div
              onClick={() => setTab("plans")}
              className="cursor-pointer rounded-2xl border border-slate-200 bg-white p-4 transition-all hover:border-navy-800 hover:shadow-xs"
            >
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-slate-500">خطة العلاج النشطة</span>
                <span className="rounded-lg bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-navy-800">
                  تفاصيل الخطة ‹
                </span>
              </div>
              <p className="mt-2 text-base font-black text-navy-900 truncate">
                {activePlan ? activePlan.title : "لا توجد خطة جارية"}
              </p>
              <p className="text-[11px] text-slate-500">
                {activePlan
                  ? `أُنجز ${activePlan.doneCount} من ${activePlan.itemsCount} إجراءات (${Math.round(
                      (activePlan.doneCount / (activePlan.itemsCount || 1)) * 100,
                    )}%)`
                  : "انقر لإنشاء خطة علاجية مقسّطة"}
              </p>
            </div>

            {/* 3. بطاقة المعمل والتركيبات */}
            <div
              onClick={() => setTab("lab")}
              className="cursor-pointer rounded-2xl border border-slate-200 bg-white p-4 transition-all hover:border-navy-800 hover:shadow-xs"
            >
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-slate-500">أعمال المعمل والتركيبات</span>
                <span className="rounded-lg bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-navy-800">
                  طلبات المعمل ‹
                </span>
              </div>
              <p className="mt-2 text-lg font-black text-navy-900">
                {labOrdersCount} {labOrdersCount === 1 ? "طلب" : "طلبات"}
              </p>
              <p className="text-[11px] text-slate-500">
                {labOrdersCount > 0 ? "متابعة استلام التيجان والجسور والتقويم" : "لا توجد طلبات جارية للمريض"}
              </p>
            </div>

            {/* 4. بطاقة الموعد القادم */}
            <div
              onClick={() => setTab("appointments")}
              className={`cursor-pointer rounded-2xl border p-4 transition-all hover:shadow-xs ${
                upcoming ? "border-sky-300 bg-sky-50/40" : "border-slate-200 bg-white"
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-slate-500">الموعد القادم</span>
                <span className="rounded-lg bg-white px-2 py-0.5 text-[10px] font-bold text-navy-800 border border-slate-200">
                  جدول المواعيد ‹
                </span>
              </div>
              <p className="mt-2 text-sm font-extrabold text-navy-900">
                {upcoming
                  ? `${friendlyDate(upcoming.scheduledDate)} · ${friendlyTime(upcoming.scheduledTime)}`
                  : "لا يوجد موعد قادم"}
              </p>
              <p className="text-[11px] text-slate-500">
                {upcoming?.note ? upcoming.note : upcoming ? "موعد مؤكد" : "انقر لحجز موعد جديد"}
              </p>
            </div>

            {/* 5. بطاقة آخر زيارة سريرية */}
            <div
              onClick={() => setTab("visits")}
              className="cursor-pointer rounded-2xl border border-slate-200 bg-white p-4 transition-all hover:border-navy-800 hover:shadow-xs"
            >
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-slate-500">الزيارات السريرية</span>
                <span className="rounded-lg bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-navy-800">
                  سجل الزيارات ‹
                </span>
              </div>
              <p className="mt-2 text-sm font-extrabold text-navy-900">
                {lastVisit ? friendlyDateLong(dateOnly(lastVisit.arrivedAt)) : "لا توجد زيارات سابقة"}
              </p>
              <p className="text-[11px] text-slate-500">
                إجمالي الزيارات المسجلة: {file.visits.length}
              </p>
            </div>

            {/* 6. بطاقة المستهلكات والمخزن */}
            <div
              onClick={() => setTab("materials")}
              className="cursor-pointer rounded-2xl border border-slate-200 bg-white p-4 transition-all hover:border-navy-800 hover:shadow-xs"
            >
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-slate-500">المستهلكات المصروفة</span>
                <span className="rounded-lg bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-navy-800">
                  المخزن ‹
                </span>
              </div>
              <p className="mt-2 text-lg font-black text-navy-900">
                {materialsCount} {materialsCount === 1 ? "مادة" : "مواد"}
              </p>
              <p className="text-[11px] text-slate-500">
                تتبع الحشوات والبنج والغرسات المصروفة لعلاج المريض
              </p>
            </div>
          </div>

          {/* بيانات المريض التفصيلية */}
          <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-xs" aria-label="البيانات">
            <h3 className="mb-2 text-xs font-extrabold text-navy-900">البيانات التعريفية والاتصال</h3>
            <Row label="رقم الجوال" value={patient.phone} ltr />
            <Row label="رقم بديل" value={patient.altPhone} ltr />
            <Row label="سنة الميلاد" value={patient.birthYear ? String(patient.birthYear) : null} ltr />
            <Row label="العنوان" value={patient.address} />
            <Row label="مسجّل منذ" value={friendlyDateLong(dateOnly(patient.createdAt))} />
            <Row label="ملاحظة إدارية" value={patient.note} />
          </section>
        </div>
      ) : tab === "chart" ? (
        <DentalChart patientId={file.patient.id} />
      ) : tab === "plans" ? (
        <PatientPlans patientId={patient.id} />
      ) : tab === "ledger" ? (
        <PatientLedger patientId={patient.id} />
      ) : tab === "lab" ? (
        <PatientLabOrders patientId={patient.id} patientName={patient.fullName} base={base} />
      ) : tab === "materials" ? (
        <PatientMaterials
          patientId={patient.id}
          visits={file.visits.map((v) => ({ id: v.id, arrivedAt: v.arrivedAt }))}
        />
      ) : tab === "ortho" ? (
        <PatientOrtho patientId={patient.id} />
      ) : tab === "documents" ? (
        <PatientDocuments patientId={patient.id} />
      ) : tab === "ceph" ? (
        <PatientCeph patientId={patient.id} />
      ) : tab === "appointments" ? (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-bold text-navy-900">سجل المواعيد ({file.appointments.length})</h3>
            <button
              onClick={() => setShowBookModal(true)}
              className="rounded-xl bg-navy-800 px-3 py-1.5 text-xs font-bold text-white hover:opacity-90"
            >
              + حجز موعد جديد
            </button>
          </div>
          {file.appointments.length === 0 ? (
            <p className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-xs text-slate-400">
              لا توجد مواعيد مسجلة.
            </p>
          ) : (
            <ul className="space-y-2">
              {file.appointments.map((appointment) => (
                <li
                  key={appointment.id}
                  className="flex items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-3.5"
                >
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-extrabold text-navy-900">
                        {friendlyDateLong(appointment.scheduledDate)} · {friendlyTime(appointment.scheduledTime)}
                      </span>
                      {appointment.appointmentType ? (
                        <span
                          className={`rounded-lg border px-2 py-0.5 text-[10px] font-extrabold ${getAppointmentTypeBadge(
                            appointment.appointmentType,
                          )}`}
                        >
                          {getAppointmentTypeLabel(appointment.appointmentType)}
                        </span>
                      ) : null}
                    </div>
                    {appointment.note ? (
                      <p className="mt-0.5 text-xs text-slate-500">{appointment.note}</p>
                    ) : null}
                  </div>
                  <span className="rounded-lg bg-slate-100 px-2 py-1 text-xs font-bold text-slate-600">
                    {shortMinutes(appointment.durationMinutes)} · {STATUS_LABEL[appointment.status] ?? appointment.status}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : file.visits.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-200 bg-white p-8 text-center">
          <p className="text-sm font-bold text-slate-600">لا توجد زيارات مسجّلة بعد</p>
          <button
            onClick={handleStartTodayVisit}
            disabled={busyAction}
            className="mt-3 rounded-xl bg-brand-orange px-4 py-2 text-xs font-bold text-white hover:opacity-90"
          >
            بدء أول زيارة للمريض الآن
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-bold text-navy-900">الزيارات السريرية ({file.visits.length})</h3>
            <button
              onClick={handleStartTodayVisit}
              disabled={busyAction}
              className="rounded-xl bg-brand-orange px-3 py-1.5 text-xs font-bold text-white hover:opacity-90"
            >
              + بدء زيارة اليوم
            </button>
          </div>
          <ul className="space-y-2">
            {file.visits.map((visit) => (
              <li
                key={visit.id}
                className="flex items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-3.5"
              >
                <div>
                  <span className="text-sm font-extrabold text-navy-900">
                    {friendlyDateLong(dateOnly(visit.arrivedAt))}
                  </span>
                  <p className="mt-0.5 text-xs text-slate-500">
                    {visit.status === "done" ? "اكتملت الزيارة وتوقيعها" : "قيد المعاينة / انتظار"}
                    {visit.chair ? ` · كرسي رقم ${visit.chair}` : ""}
                  </p>
                </div>
                <a
                  href={`/today?visitId=${visit.id}`}
                  className="rounded-xl border border-slate-200 px-3 py-1.5 text-xs font-bold text-navy-800 hover:bg-slate-50"
                >
                  فتح الزيارة السريرية
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Modal لحجز موعد سريع */}
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
    </main>
  );
}

function Row({ label, value, ltr = false }: { label: string; value: string | null; ltr?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-slate-100 py-2.5 last:border-b-0">
      <span className="shrink-0 text-xs font-bold text-slate-500">{label}</span>
      <span className={`text-xs ${value ? "font-bold text-navy-900" : "text-slate-300"}`} dir={ltr ? "ltr" : undefined}>
        {value || "—"}
      </span>
    </div>
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
