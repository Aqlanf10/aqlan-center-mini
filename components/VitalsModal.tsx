"use client";

import { clinicDateString } from "@/lib/schedule";
import { CLINIC_ZONE_FALLBACK } from "@/lib/clinicZone";
import { useState, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import {
  Activity,
  Heart,
  AlertTriangle,
  CheckCircle2,
  ShieldAlert,
  Droplet,
  Calendar,
  X,
  Save,
  Loader2,
} from "lucide-react";
import {
  type VitalSigns,
  getBloodPressureRisk,
  parsePatientVitals,
  serializeVitalsToAlert,
  BLOOD_GROUPS,
} from "@/lib/patient";

// The canonical POST/PATCH may commit even after dismissal or lost transport.
// Keep the latch until it settles, including across patient/authority remounts.
const pendingVitalsSaves = new Map<number, symbol>();
const uncertainVitalsSaves = new Set<number>();
const vitalsUnknownNotice = "نتيجة حفظ العلامات غير مؤكدة؛ قد تكون محفوظة بالفعل. الحفظ الجديد متوقف في هذه النافذة. راجع سجل المريض ولا تكرر الطلب قبل التحقق من النتيجة.";
const vitalsSaveListeners = new Set<() => void>();
const vitalsPendingNotice = "قد يستمر حفظ العلامات بعد إغلاق النافذة. راجع ملف المريض قبل تكرار الحفظ؛ الإغلاق لا يلغي الطلب.";

interface VitalsModalProps {
  isOpen: boolean;
  authorityKey?: string;
  onClose: () => void;
  patientId: number;
  patientName: string;
  currentMedicalAlert?: string | null;
  onSaved: (newMedicalAlert: string, vitals: VitalSigns) => void;
}

export function VitalsModal({
  isOpen,
  authorityKey = "",
  onClose,
  patientId,
  patientName,
  currentMedicalAlert,
  onSaved,
}: VitalsModalProps) {
  const [systolic, setSystolic] = useState<string>("");
  const [diastolic, setDiastolic] = useState<string>("");
  const [pulse, setPulse] = useState<string>("");
  const [bloodSugar, setBloodSugar] = useState<string>("");
  const [bloodGroup, setBloodGroup] = useState<string>("");
  const [recordedAt, setRecordedAt] = useState<string>("");
  const [medicalNote, setMedicalNote] = useState<string>("");

  const [saving, setSaving] = useState(false);
  const [reviewRequired, setReviewRequired] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const scope = JSON.stringify([patientId, patientName, authorityKey, currentMedicalAlert ?? null]);
  const openOwner = useMemo(() => ({ scope, isOpen }), [scope, isOpen]);
  const owner = useRef({ mounted: false, open: false, scope, generation: 0, token: null as typeof openOwner | null });
  useLayoutEffect(() => {
    const lifetime = owner.current;
    lifetime.token = openOwner; lifetime.mounted = true; lifetime.open = isOpen; lifetime.scope = scope;
    return () => { lifetime.token = null; lifetime.mounted = false; lifetime.open = false; ++lifetime.generation; };
  }, [scope, isOpen, openOwner]);
  const contextAlive = () => owner.current.token === openOwner && owner.current.mounted && owner.current.open && isOpen && owner.current.scope === scope;
  useLayoutEffect(() => {
    const reflectPending = () => {
      setSaving(pendingVitalsSaves.has(patientId));
      setReviewRequired(uncertainVitalsSaves.has(patientId));
    };
    reflectPending(); vitalsSaveListeners.add(reflectPending);
    return () => { vitalsSaveListeners.delete(reflectPending); };
  }, [patientId]);
  const close = () => {
    if (!contextAlive()) return;
    owner.current.token = null; owner.current.open = false; ++owner.current.generation;
    if (pendingVitalsSaves.has(patientId)) setError(vitalsPendingNotice);
    onClose();
  };

  // تحديث القيم الابتدائية عند فتح النافذة
  useEffect(() => {
    if (isOpen) {
      setError(pendingVitalsSaves.has(patientId) ? vitalsPendingNotice : null);
      const parsed = parsePatientVitals(currentMedicalAlert);
      if (parsed.vitals) {
        setSystolic(parsed.vitals.bpSystolic ? String(parsed.vitals.bpSystolic) : "");
        setDiastolic(parsed.vitals.bpDiastolic ? String(parsed.vitals.bpDiastolic) : "");
        setPulse(parsed.vitals.pulse ? String(parsed.vitals.pulse) : "");
        setBloodSugar(parsed.vitals.bloodSugar ? String(parsed.vitals.bloodSugar) : "");
        setBloodGroup(parsed.vitals.bloodGroup || "");
        setRecordedAt(parsed.vitals.recordedAt || clinicDateString(new Date(), CLINIC_ZONE_FALLBACK));
      } else {
        setSystolic("");
        setDiastolic("");
        setPulse("");
        setBloodSugar("");
        setBloodGroup("");
        setRecordedAt(clinicDateString(new Date(), CLINIC_ZONE_FALLBACK));
      }
      setMedicalNote(parsed.cleanAlert || "");
    }
  }, [isOpen, currentMedicalAlert, patientId, patientName, authorityKey]);

  if (!isOpen) return null;

  const numSys = systolic ? Number(systolic) : null;
  const numDia = diastolic ? Number(diastolic) : null;
  const numPulse = pulse ? Number(pulse) : null;
  const numSugar = bloodSugar ? Number(bloodSugar) : null;

  const bpRisk = getBloodPressureRisk(numSys, numDia);

  // تقييم السكر السريري
  let sugarRiskBadge: { label: string; color: string } | null = null;
  if (numSugar && numSugar > 0) {
    if (numSugar >= 200) {
      sugarRiskBadge = {
        label: "مرتفع (تأخير التئام الجروح وخطر عدوى)",
        color: "bg-rose-100 text-rose-800 border-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:border-rose-800/40",
      };
    } else if (numSugar >= 140) {
      sugarRiskBadge = {
        label: "مرتفع طفيف (متابعة سريرية)",
        color: "bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-800/40",
      };
    } else if (numSugar < 70) {
      sugarRiskBadge = {
        label: "منخفض (خطر هبوط أو إغماء)",
        color: "bg-rose-100 text-rose-800 border-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:border-rose-800/40",
      };
    } else {
      sugarRiskBadge = {
        label: "طبيعي ومستقر",
        color: "bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800/40",
      };
    }
  }

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!contextAlive() || pendingVitalsSaves.has(patientId) || uncertainVitalsSaves.has(patientId)) return;

    const generation = owner.current.generation;
    const actionAlive = () => contextAlive() && owner.current.generation === generation;
    const token = Symbol(); pendingVitalsSaves.set(patientId, token);
    vitalsSaveListeners.forEach((listener) => listener());
    setError(null);

    const vitalsData: VitalSigns = {
      bpSystolic: numSys,
      bpDiastolic: numDia,
      pulse: numPulse,
      bloodSugar: numSugar,
      bloodGroup: bloodGroup || null,
      recordedAt: recordedAt || clinicDateString(new Date(), CLINIC_ZONE_FALLBACK),
    };

    const serializedAlert = serializeVitalsToAlert(vitalsData, medicalNote);

    let confirmedRejection = false;
    try {
      const hasReading = numSys !== null || numDia !== null || numPulse !== null || numSugar !== null;
      if (hasReading) {
        const recorded = await fetch(`/api/patients/${patientId}/vitals`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            bpSystolic: numSys, bpDiastolic: numDia, pulse: numPulse, glucose: numSugar,
            recordedAt: vitalsData.recordedAt, medicalAlert: serializedAlert,
          }),
        });
        const saved = await recorded.json().catch(() => null);
        if (!recorded.ok) {
          confirmedRejection = [400, 401, 403, 404, 413, 415, 422, 429].includes(recorded.status);
          throw new Error(saved?.message || "تعذّر حفظ القراءة.");
        }
        if (recorded.status !== 201 || !Number.isSafeInteger(saved?.id) || saved.id <= 0 || saved.patientId !== patientId
          || saved.bpSystolic !== numSys || saved.bpDiastolic !== numDia || saved.pulse !== numPulse || saved.glucose !== numSugar) {
          throw new Error("استجابة حفظ القراءة غير مكتملة.");
        }
      } else {
        const res = await fetch(`/api/patients/${patientId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ medicalAlert: serializedAlert }),
        });
        const saved = await res.json().catch(() => null);
        if (!res.ok) {
          confirmedRejection = [400, 401, 403, 404, 413, 415, 422, 429].includes(res.status);
          throw new Error(saved?.message || "تعذّر حفظ العلامات الحيوية.");
        }
        if (res.status !== 200 || saved?.id !== patientId || saved.medicalAlert !== serializedAlert) {
          throw new Error("استجابة حفظ التنبيه غير مكتملة.");
        }
      }

      if (!actionAlive()) return;
      onSaved(serializedAlert, vitalsData);
      if (actionAlive()) close();
    } catch (err: unknown) {
      if (!confirmedRejection) {
        uncertainVitalsSaves.add(patientId);
        vitalsSaveListeners.forEach((listener) => listener());
      }
      if (actionAlive()) setError(err instanceof Error ? `${err.message} قد تكون نتيجة الحفظ غير مؤكدة؛ راجع ملف المريض قبل تكرار الطلب.` : "نتيجة الحفظ غير مؤكدة؛ راجع ملف المريض قبل تكرار الطلب.");
    } finally {
      if (pendingVitalsSaves.get(patientId) === token) {
        pendingVitalsSaves.delete(patientId);
        vitalsSaveListeners.forEach((listener) => listener());
      }
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-sm animate-in fade-in duration-200"
      dir="rtl"
    >
      <div
        className="w-full max-w-xl overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl transition-all dark:border-slate-800 dark:bg-slate-900"
        role="dialog"
        aria-modal="true"
      >
        {/* شريط العنوان */}
        <div className="flex items-center justify-between border-b border-slate-100 bg-gradient-to-r from-emerald-50 to-teal-50 px-6 py-4 dark:border-slate-800 dark:from-emerald-950/30 dark:to-teal-950/30">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-600 text-white shadow-md shadow-emerald-600/20">
              <Activity className="h-5 w-5" />
            </div>
            <div>
              <h3 className="font-bold text-slate-900 dark:text-slate-100">
                محطة العلامات الحيوية والمخاطر الطبية
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                الملف السريري للمريض: <span className="font-semibold text-emerald-700 dark:text-emerald-400">{patientName}</span>
              </p>
            </div>
          </div>
          <button
            onClick={close}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-200/60 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200 transition-colors"
            title="إغلاق"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <form onSubmit={handleSave} className="p-6 space-y-5">
          {reviewRequired ? <p role="alert" className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs font-medium text-amber-900">{vitalsUnknownNotice}</p> : null}
          {error && !reviewRequired && (
            <div className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs font-medium text-rose-800 dark:border-rose-900/50 dark:bg-rose-950/40 dark:text-rose-200 flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 shrink-0 text-rose-600" />
              <span>{error}</span>
            </div>
          )}

          {/* قياس ضغط الدم */}
          <div className="rounded-xl border border-slate-200 bg-slate-50/50 p-4 dark:border-slate-800 dark:bg-slate-900/50 space-y-3">
            <div className="flex items-center justify-between">
              <label className="flex items-center gap-2 text-xs font-bold text-slate-700 dark:text-slate-300">
                <Heart className="h-4 w-4 text-rose-500" />
                <span>ضغط الدم (Blood Pressure - mmHg)</span>
              </label>
              <span className="text-[11px] text-slate-500 dark:text-slate-400">الانقباضي / الانبساطي</span>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <div className="relative">
                  <input
                    type="number"
                    min="50"
                    max="260"
                    value={systolic}
                    onChange={(e) => setSystolic(e.target.value)}
                    placeholder="الانقباضي (120)"
                    className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-center text-sm font-semibold tracking-wide text-slate-900 focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                  />
                  <span className="absolute left-3 top-2.5 text-[10px] text-slate-400">SYS</span>
                </div>
              </div>
              <div>
                <div className="relative">
                  <input
                    type="number"
                    min="30"
                    max="180"
                    value={diastolic}
                    onChange={(e) => setDiastolic(e.target.value)}
                    placeholder="الانبساطي (80)"
                    className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-center text-sm font-semibold tracking-wide text-slate-900 focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                  />
                  <span className="absolute left-3 top-2.5 text-[10px] text-slate-400">DIA</span>
                </div>
              </div>
            </div>

            {/* تصنيف المخاطر المباشر لضغط الدم */}
            {bpRisk.category !== "unknown" && (
              <div
                className={`rounded-lg border p-3 text-xs transition-all ${
                  bpRisk.category === "normal"
                    ? "border-emerald-200 bg-emerald-50/80 text-emerald-800 dark:border-emerald-900/50 dark:bg-emerald-950/30 dark:text-emerald-300"
                    : bpRisk.category === "elevated"
                    ? "border-yellow-200 bg-yellow-50/80 text-yellow-800 dark:border-yellow-900/50 dark:bg-yellow-950/30 dark:text-yellow-300"
                    : bpRisk.category === "stage1"
                    ? "border-amber-200 bg-amber-50/80 text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-300"
                    : "border-rose-300 bg-rose-50/90 text-rose-900 dark:border-rose-900 dark:bg-rose-950/50 dark:text-rose-200"
                }`}
              >
                <div className="flex items-center gap-2 font-bold mb-1">
                  {bpRisk.severity === "critical" ? (
                    <ShieldAlert className="h-4 w-4 text-rose-600 animate-pulse shrink-0" />
                  ) : bpRisk.severity === "high" ? (
                    <AlertTriangle className="h-4 w-4 text-rose-500 shrink-0" />
                  ) : bpRisk.severity === "medium" ? (
                    <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0" />
                  ) : (
                    <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0" />
                  )}
                  <span>{bpRisk.label}</span>
                </div>
                <p className="text-[11px] leading-relaxed opacity-90">{bpRisk.clinicalNote}</p>
              </div>
            )}
          </div>

          {/* النبض والسكر العشوائي */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
                النبض (HR - bpm)
              </label>
              <div className="relative">
                <input
                  type="number"
                  min="40"
                  max="220"
                  value={pulse}
                  onChange={(e) => setPulse(e.target.value)}
                  placeholder="مثال: 72"
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                />
                <span className="absolute left-3 top-2.5 text-[10px] text-slate-400">bpm</span>
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
                السكر العشوائي (RBS - mg/dL)
              </label>
              <div className="relative">
                <input
                  type="number"
                  min="30"
                  max="600"
                  value={bloodSugar}
                  onChange={(e) => setBloodSugar(e.target.value)}
                  placeholder="مثال: 110"
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                />
                <span className="absolute left-3 top-2.5 text-[10px] text-slate-400">mg/dL</span>
              </div>
              {sugarRiskBadge && (
                <div className={`mt-1.5 rounded border px-2 py-0.5 text-[10px] font-medium ${sugarRiskBadge.color}`}>
                  {sugarRiskBadge.label}
                </div>
              )}
            </div>
          </div>

          {/* فصيلة الدم وسجل القياس */}
          <div>
            <label className="flex items-center gap-1.5 text-xs font-semibold text-slate-700 dark:text-slate-300 mb-2">
              <Droplet className="h-3.5 w-3.5 text-rose-500" />
              <span>فصيلة الدم (Blood Group)</span>
            </label>
            <div className="grid grid-cols-4 sm:grid-cols-8 gap-1.5">
              {BLOOD_GROUPS.map((bg) => {
                const isSelected = bloodGroup === bg;
                return (
                  <button
                    key={bg}
                    type="button"
                    onClick={() => setBloodGroup(isSelected ? "" : bg)}
                    className={`rounded-lg py-1.5 text-xs font-bold transition-all ${
                      isSelected
                        ? "bg-rose-600 text-white shadow-md shadow-rose-600/25 scale-105"
                        : "border border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
                    }`}
                  >
                    {bg}
                  </button>
                );
              })}
            </div>
          </div>

          {/* تاريخ القياس وتنبيهات السوابق الطبية */}
          <div className="space-y-3 pt-1">
            <div className="flex items-center gap-2">
              <Calendar className="h-3.5 w-3.5 text-slate-400" />
              <span className="text-xs text-slate-500 dark:text-slate-400">تاريخ تسجيل القياس:</span>
              <input
                type="date"
                value={recordedAt}
                onChange={(e) => setRecordedAt(e.target.value)}
                className="rounded border border-slate-300 bg-white px-2 py-1 text-xs text-slate-900 focus:border-emerald-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                تنبيهات السوابق الطبية والحساسية (Medical Alert Notes)
              </label>
              <textarea
                rows={2}
                value={medicalNote}
                onChange={(e) => setMedicalNote(e.target.value)}
                placeholder="حساسية بنسلين، سوابق ربو، أمراض قلب أو كلى..."
                className="w-full rounded-lg border border-slate-300 bg-white p-2.5 text-xs leading-relaxed text-slate-900 placeholder:text-slate-400 focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
              />
            </div>
          </div>

          {/* أزرار الإجراء */}
          <div className="flex items-center justify-end gap-3 pt-3 border-t border-slate-100 dark:border-slate-800">
            <button
              type="button"
              onClick={close}
              className="rounded-xl border border-slate-200 px-4 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              إلغاء
            </button>
            <button
              type="submit"
              disabled={saving || reviewRequired}
              className="flex items-center gap-2 rounded-xl bg-emerald-600 px-5 py-2 text-xs font-bold text-white shadow-md shadow-emerald-600/20 hover:bg-emerald-700 active:scale-95 disabled:opacity-50 transition-all"
            >
              {saving ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>جاري الحفظ...</span>
                </>
              ) : (
                <>
                  <Save className="h-4 w-4" />
                  <span>حفظ العلامات في ملف المريض</span>
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
