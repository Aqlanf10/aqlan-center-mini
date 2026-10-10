"use client";

import { useCallback, useEffect, useState } from "react";
import { Modal } from "@/components/Modal";
import { CLINIC_ZONE_FALLBACK } from "@/lib/clinicZone";
import { clinicDateString, clinicLocalDateTimeToIso } from "@/lib/schedule";
import {
  HR_ATTENDANCE_STATUS_LABELS,
  type HrAttendanceStatus,
} from "@/lib/hr-contracts-attendance-shared";

type AttendanceItem = import("@/lib/hr-contracts-attendance-shared").HrAttendanceRecordView;
type CorrectionItem = import("@/lib/hr-contracts-attendance-shared").HrAttendanceCorrectionView;
type ScheduleItem = import("@/lib/hr-contracts-attendance-shared").HrWorkScheduleView;

interface StaffOption {
  id: number;
  fullName: string;
  jobTitle: string;
}

const clinicClock = (instant: string) => new Intl.DateTimeFormat("en-GB", {timeZone:CLINIC_ZONE_FALLBACK,hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).format(new Date(instant));

export function HrAttendancePanel({ isAdmin = false }: { isAdmin?: boolean }) {
  const [subTab, setSubTab] = useState<"records" | "corrections" | "schedules">("records");
  const [records, setRecords] = useState<AttendanceItem[]>([]);
  const [corrections, setCorrections] = useState<CorrectionItem[]>([]);
  const [schedules, setSchedules] = useState<ScheduleItem[]>([]);
  const [staffOptions, setStaffOptions] = useState<StaffOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [selectedDate, setSelectedDate] = useState(() => clinicDateString(new Date(), CLINIC_ZONE_FALLBACK));
  const [selectedStaff, setSelectedStaff] = useState("");
  const [statusFilter, setStatusFilter] = useState("");

  // Punch modal / quick punch
  const [punchModalOpen, setPunchModalOpen] = useState(false);
  const [punchStaffId, setPunchStaffId] = useState("");
  const [punchType, setPunchType] = useState<"check_in" | "check_out">("check_in");
  const [punchTime, setPunchTime] = useState("");
  const [punchNote, setPunchNote] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Correction request modal
  const [correctionModalOpen, setCorrectionModalOpen] = useState(false);
  const [selectedRecordForCorrection, setSelectedRecordForCorrection] = useState<AttendanceItem | null>(null);
  const [reqCheckIn, setReqCheckIn] = useState("");
  const [reqCheckOut, setReqCheckOut] = useState("");
  const [reqReason, setReqReason] = useState("");

  // Schedule create modal
  const [scheduleModalOpen, setScheduleModalOpen] = useState(false);
  const [schedName, setSchedName] = useState("");
  const [schedPattern, setSchedPattern] = useState("morning");
  const [schedStart, setSchedStart] = useState("08:00");
  const [schedEnd, setSchedEnd] = useState("16:00");

  const loadAttendance = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (selectedDate) {
        params.set("startDate", selectedDate);
        params.set("endDate", selectedDate);
      }
      if (selectedStaff) params.set("staffId", selectedStaff);
      if (statusFilter) params.set("status", statusFilter);

      const res = await fetch(`/api/hr/attendance?${params.toString()}`, { cache: "no-store" });
      if (!res.ok) throw new Error("تعذّر تحميل سجلات الدوام.");
      const data = await res.json();
      setRecords(data);
      setError(null);
    } catch (err: any) {
      setError(err?.message || "حدث خطأ أثناء تحميل الحضور.");
    } finally {
      setLoading(false);
    }
  }, [selectedDate, selectedStaff, statusFilter]);

  const loadCorrections = useCallback(async () => {
    if (!isAdmin) return;
    try {
      const res = await fetch("/api/hr/attendance/corrections", { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        setCorrections(data);
      }
    } catch {
      // Ignored
    }
  }, [isAdmin]);

  const loadSchedules = useCallback(async () => {
    try {
      const res = await fetch("/api/hr/schedules", { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        setSchedules(data);
      }
    } catch {
      // Ignored
    }
  }, []);

  const loadStaff = useCallback(async () => {
    try {
      const res = await fetch("/api/hr/directory", { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        setStaffOptions(data);
      }
    } catch {
      // Ignored
    }
  }, []);

  useEffect(() => {
    void loadAttendance();
    void loadCorrections();
    void loadSchedules();
    void loadStaff();
  }, [loadAttendance, loadCorrections, loadSchedules, loadStaff]);

  const handlePunch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!punchStaffId) {
      alert("يرجى اختيار الموظف.");
      return;
    }
    setSubmitting(true);
    try {
      const stamp = punchTime
        ? clinicLocalDateTimeToIso(selectedDate, punchTime, CLINIC_ZONE_FALLBACK)
        : new Date().toISOString();

      const res = await fetch("/api/hr/attendance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          staffId: punchStaffId,
          punchType,
          punchTime: stamp,
          source: "manual",
          note: punchNote || null,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || "تعذّر تسجيل البصمة.");
      }

      setPunchModalOpen(false);
      setPunchNote("");
      void loadAttendance();
    } catch (err: any) {
      alert(err.message || "حدث خطأ أثناء تسجيل البصمة.");
    } finally {
      setSubmitting(false);
    }
  };

  const handleRequestCorrection = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedRecordForCorrection || !reqReason) return;
    setSubmitting(true);
    try {
      const res = await fetch("/api/hr/attendance/corrections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "request",
          attendanceRecordId: selectedRecordForCorrection.id,
          fieldCorrected: "all",
          newCheckIn: reqCheckIn ? clinicLocalDateTimeToIso(selectedRecordForCorrection.attendanceDate, reqCheckIn, CLINIC_ZONE_FALLBACK) : null,
          newCheckOut: reqCheckOut ? clinicLocalDateTimeToIso(selectedRecordForCorrection.attendanceDate, reqCheckOut, CLINIC_ZONE_FALLBACK) : null,
          reason: reqReason,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || "تعذّر رفع طلب التصحيح.");
      }

      setCorrectionModalOpen(false);
      setSelectedRecordForCorrection(null);
      setReqReason("");
      void loadAttendance();
      void loadCorrections();
    } catch (err: any) {
      alert(err.message || "حدث خطأ أثناء رفع الطلب.");
    } finally {
      setSubmitting(false);
    }
  };

  const handleDecideCorrection = async (id: number, decision: "approved" | "rejected") => {
    const reason = prompt(decision === "approved" ? "ملاحظة الاعتماد (اختياري):" : "سبب الرفض:") || "";
    try {
      const res = await fetch("/api/hr/attendance/corrections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "decide",
          id,
          decision,
          reason,
        }),
      });
      if (!res.ok) throw new Error("تعذّر تنفيذ القرار.");
      void loadCorrections();
      void loadAttendance();
    } catch (err: any) {
      alert(err.message || "حدث خطأ أثناء معالجة القرار.");
    }
  };

  const handleCreateSchedule = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!schedName) return;
    if (!selectedStaff) { alert("اختر الموظف من مرشح الحضور قبل إضافة جدول عمل."); return; }
    setSubmitting(true);
    try {
      const res = await fetch("/api/hr/schedules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: schedName,
          scheduleType: schedPattern,
          staffId: selectedStaff ? Number(selectedStaff) : null,
          shiftStartTime: schedStart,
          shiftEndTime: schedEnd,
          crossesMidnight: schedEnd <= schedStart,
          workingDays: [0, 1, 2, 3, 4, 6], // All except Friday
          effectiveFrom: selectedDate,
        }),
      });
      if (!res.ok) throw new Error("تعذّر حفظ جدول العمل.");
      setScheduleModalOpen(false);
      setSchedName("");
      void loadSchedules();
    } catch (err: any) {
      alert(err.message || "حدث خطأ أثناء حفظ الجدول.");
    } finally {
      setSubmitting(false);
    }
  };

  const openCorrectionForRecord = (record: AttendanceItem) => {
    setSelectedRecordForCorrection(record);
    setReqCheckIn(record.checkInActual ? clinicClock(record.checkInActual) : "08:00");
    setReqCheckOut(record.checkOutActual ? clinicClock(record.checkOutActual) : "16:00");
    setCorrectionModalOpen(true);
  };

  return (
    <section aria-label="الدوام والحضور" className="space-y-4">
      {/* Sub Navigation */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-navy-100 pb-3">
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setSubTab("records")}
            className={`rounded-xl px-4 py-2 text-sm font-semibold transition ${
              subTab === "records" ? "bg-navy-800 text-white shadow-sm" : "bg-white text-navy-700 hover:bg-navy-50"
            }`}
          >
            سجل الحضور اليومي
          </button>
          {isAdmin && (
            <button
              type="button"
              onClick={() => setSubTab("corrections")}
              className={`flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold transition ${
                subTab === "corrections"
                  ? "bg-navy-800 text-white shadow-sm"
                  : "bg-white text-navy-700 hover:bg-navy-50"
              }`}
            >
              <span>طلبات التصحيح</span>
              {corrections.filter((c) => c.status === "pending").length > 0 && (
                <span className="rounded-full bg-rose-500 px-2 py-0.5 text-xs text-white">
                  {corrections.filter((c) => c.status === "pending").length}
                </span>
              )}
            </button>
          )}
          <button
            type="button"
            onClick={() => setSubTab("schedules")}
            className={`rounded-xl px-4 py-2 text-sm font-semibold transition ${
              subTab === "schedules" ? "bg-navy-800 text-white shadow-sm" : "bg-white text-navy-700 hover:bg-navy-50"
            }`}
          >
            جداول الدوام والورديات
          </button>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              const now = new Date();
              setPunchTime(clinicClock(now.toISOString()));
              setPunchModalOpen(true);
            }}
            className="flex items-center gap-2 rounded-xl bg-navy-800 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-navy-700"
          >
            <span>⏱️</span>
            <span>تسجيل بصمة يدوية</span>
          </button>
        </div>
      </div>

      {subTab === "records" && (
        <div className="space-y-4">
          {/* Filters Bar */}
          <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-navy-100 bg-white p-3 shadow-sm">
            <div>
              <label className="text-xs font-semibold text-navy-500 ml-2">التاريخ:</label>
              <input
                type="date"
                value={selectedDate}
                onChange={(e) => setSelectedDate(e.target.value)}
                className="rounded-xl border border-navy-200 bg-white px-3 py-1.5 text-sm text-navy-800 outline-none"
              />
            </div>
            <div>
              <label className="text-xs font-semibold text-navy-500 ml-2">الموظف:</label>
              <select
                value={selectedStaff}
                onChange={(e) => setSelectedStaff(e.target.value)}
                className="rounded-xl border border-navy-200 bg-white px-3 py-1.5 text-sm text-navy-800 outline-none"
              >
                <option value="">جميع الطاقم</option>
                {staffOptions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.fullName}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs font-semibold text-navy-500 ml-2">الحالة:</label>
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="rounded-xl border border-navy-200 bg-white px-3 py-1.5 text-sm text-navy-800 outline-none"
              >
                <option value="">جميع الحالات</option>
                {Object.entries(HR_ATTENDANCE_STATUS_LABELS).map(([k, label]) => (
                  <option key={k} value={k}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {error && (
            <div className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
              {error}
            </div>
          )}

          {loading ? (
            <div className="py-12 text-center text-sm text-navy-500">جاري تحميل سجلات الحضور...</div>
          ) : records.length === 0 ? (
            <div className="rounded-2xl border border-navy-100 bg-white p-8 text-center text-navy-500">
              لا توجد سجلات حضور مسجلة لهذا التاريخ.
            </div>
          ) : (
            <div className="overflow-x-auto rounded-2xl border border-navy-100 bg-white shadow-sm">
              <table className="w-full text-right text-sm">
                <thead className="border-b border-navy-100 bg-navy-50/60 text-xs font-semibold text-navy-600">
                  <tr>
                    <th className="px-4 py-3">الموظف</th>
                    <th className="px-4 py-3">الدخول</th>
                    <th className="px-4 py-3">الخروج</th>
                    <th className="px-4 py-3">ساعات العمل</th>
                    <th className="px-4 py-3">تأخير / إضافي</th>
                    <th className="px-4 py-3">الحالة</th>
                    <th className="px-4 py-3 text-center">إجراءات</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-navy-100">
                  {records.map((r) => {
                    const isIncomplete = r.status === "incomplete";
                    const isLate = r.lateMinutes > 0;
                    const hoursWorked = (r.workMinutes / 60).toFixed(1);

                    return (
                      <tr key={r.id} className="transition hover:bg-navy-50/40">
                        <td className="px-4 py-3 font-semibold text-navy-900">
                          <div>{r.staffName || `موظف #${r.staffId}`}</div>
                          {r.staffJobTitle && <div className="text-xs text-navy-500">{r.staffJobTitle}</div>}
                        </td>
                        <td className="px-4 py-3 font-mono text-xs">
                          {r.checkInActual ? clinicClock(r.checkInActual) : "—"}
                        </td>
                        <td className="px-4 py-3 font-mono text-xs">
                          {r.checkOutActual ? clinicClock(r.checkOutActual) : "—"}
                        </td>
                        <td className="px-4 py-3 text-xs">
                          <span className="font-semibold text-navy-800">{hoursWorked}</span> ساعة
                        </td>
                        <td className="px-4 py-3 text-xs">
                          {isLate && <div className="text-amber-700">تأخير: {r.lateMinutes} د</div>}
                          {r.overtimeMinutes > 0 && (
                            <div className="text-emerald-700">إضافي: {r.overtimeMinutes} د</div>
                          )}
                          {!isLate && r.overtimeMinutes === 0 && <div className="text-navy-400">—</div>}
                        </td>
                        <td className="px-4 py-3">
                          <span
                            className={`inline-block rounded-lg px-2.5 py-1 text-xs font-semibold ${
                              r.status === "present"
                                ? "bg-emerald-100 text-emerald-800"
                                : r.status === "late"
                                ? "bg-amber-100 text-amber-800"
                                : isIncomplete
                                ? "bg-rose-100 text-rose-800 font-bold animate-pulse"
                                : r.status === "on_leave"
                                ? "bg-blue-100 text-blue-800"
                                : "bg-navy-100 text-navy-700"
                            }`}
                          >
                            {HR_ATTENDANCE_STATUS_LABELS[r.status] || r.status}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-center">
                          <button
                            type="button"
                            onClick={() => openCorrectionForRecord(r)}
                            className="rounded-lg border border-navy-200 px-2.5 py-1 text-xs font-semibold text-navy-700 hover:bg-navy-100"
                          >
                            طلب تصحيح
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Corrections SubTab */}
      {subTab === "corrections" && (
        <div className="space-y-4">
          <div className="rounded-2xl border border-navy-100 bg-white p-4 shadow-sm">
            <h3 className="mb-3 text-sm font-bold text-navy-900">طلبات تعديل وتصحيح بصمات الحضور</h3>
            {corrections.length === 0 ? (
              <div className="p-8 text-center text-xs text-navy-400">لا توجد طلبات تصحيح حالية.</div>
            ) : (
              <div className="divide-y divide-navy-100">
                {corrections.map((c) => (
                  <div key={c.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-navy-900">{c.staffName || `موظف #${c.staffId}`}</span>
                        <span
                          className={`rounded-md px-2 py-0.5 text-xs font-semibold ${
                            c.status === "pending"
                              ? "bg-amber-100 text-amber-800"
                              : c.status === "approved"
                              ? "bg-emerald-100 text-emerald-800"
                              : "bg-rose-100 text-rose-800"
                          }`}
                        >
                          {c.status === "pending" ? "قيد المراجعة" : c.status === "approved" ? "معتمد" : "مرفوض"}
                        </span>
                      </div>
                      <div className="text-xs text-navy-600">
                        السبب: <span className="font-medium text-navy-800">{c.reason}</span>
                      </div>
                      <div className="font-mono text-xs text-navy-500">
                        المطلوب: دخول ({c.newCheckIn ? clinicClock(c.newCheckIn) : "—"}) | خروج (
                        {c.newCheckOut ? clinicClock(c.newCheckOut) : "—"})
                      </div>
                    </div>

                    {c.status === "pending" && (
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => void handleDecideCorrection(c.id, "approved")}
                          className="rounded-xl bg-emerald-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-800"
                        >
                          اعتماد التصحيح
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleDecideCorrection(c.id, "rejected")}
                          className="rounded-xl bg-rose-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-rose-700"
                        >
                          رفض
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Schedules SubTab */}
      {subTab === "schedules" && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-bold text-navy-900">جداول العمل وأنماط الورديات</h3>
            {isAdmin && (
              <button
                type="button"
                onClick={() => setScheduleModalOpen(true)}
                className="rounded-xl bg-navy-800 px-3 py-1.5 text-xs font-semibold text-white hover:bg-navy-700"
              >
                + إنشاء جدول وردية
              </button>
            )}
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {schedules.map((s) => (
              <div key={s.id} className="rounded-2xl border border-navy-100 bg-white p-4 shadow-sm">
                <div className="flex items-center justify-between">
                  <h4 className="font-bold text-navy-900">{s.name}</h4>
                  {s.isActive && (
                    <span className="rounded-md bg-blue-100 px-2 py-0.5 text-xs font-bold text-blue-800">
                      افتراضي
                    </span>
                  )}
                </div>
                <div className="mt-2 text-xs text-navy-600">
                  نمط الوردية: <span className="font-medium text-navy-800">{s.scheduleType}</span>
                </div>
                <div className="mt-1 font-mono text-xs text-navy-700">
                  {s.shiftStartTime && s.shiftEndTime && (
                    <div>
                      الفترة: {s.shiftStartTime} → {s.shiftEndTime}
                    </div>
                  )}
                  {s.secondShiftStart && s.secondShiftEnd && (
                    <div>
                      المساء: {s.secondShiftStart} → {s.secondShiftEnd}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Manual Punch Modal */}
      {punchModalOpen && (
        <Modal onClose={() => setPunchModalOpen(false)}>
          <form onSubmit={handlePunch} className="space-y-3">
            <h3 className="text-base font-bold text-navy-900">تسجيل بصمة يدوية</h3>
            <div>
              <label className="mb-1 block text-xs font-semibold text-navy-700">الموظف *</label>
              <select
                required
                value={punchStaffId}
                onChange={(e) => setPunchStaffId(e.target.value)}
                className="w-full rounded-xl border border-navy-200 p-2.5 text-sm outline-none"
              >
                <option value="">اختر الموظف...</option>
                {staffOptions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.fullName}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-xs font-semibold text-navy-700">نوع البصمة *</label>
                <select
                  value={punchType}
                  onChange={(e) => setPunchType(e.target.value as "check_in" | "check_out")}
                  className="w-full rounded-xl border border-navy-200 p-2.5 text-sm outline-none"
                >
                  <option value="check_in">تسجيل حضور (دخول)</option>
                  <option value="check_out">تسجيل انصراف (خروج)</option>
                </select>
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold text-navy-700">الوقت</label>
                <input
                  type="time"
                  value={punchTime}
                  onChange={(e) => setPunchTime(e.target.value)}
                  className="w-full rounded-xl border border-navy-200 p-2.5 text-sm outline-none"
                />
              </div>
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-navy-700">ملاحظة</label>
              <input
                type="text"
                value={punchNote}
                onChange={(e) => setPunchNote(e.target.value)}
                placeholder="مثلاً: تعطل جهاز البصمة / إذن مسبق"
                className="w-full rounded-xl border border-navy-200 p-2.5 text-sm outline-none"
              />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setPunchModalOpen(false)}
                className="rounded-xl border border-navy-200 px-3 py-1.5 text-xs font-semibold text-navy-700"
              >
                إلغاء
              </button>
              <button
                type="submit"
                disabled={submitting}
                className="rounded-xl bg-navy-800 px-4 py-1.5 text-xs font-semibold text-white"
              >
                {submitting ? "جاري التسجيل..." : "تسجيل البصمة"}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {/* Request Correction Modal */}
      {correctionModalOpen && selectedRecordForCorrection && (
        <Modal onClose={() => setCorrectionModalOpen(false)}>
          <form onSubmit={handleRequestCorrection} className="space-y-3">
            <h3 className="text-base font-bold text-navy-900">طلب تصحيح بصمة الحضور</h3>
            <div className="rounded-xl bg-navy-50/50 p-2.5 text-xs text-navy-700">
              الموظف: <span className="font-semibold">{selectedRecordForCorrection.staffName}</span> | التاريخ:{" "}
              <span className="font-semibold">{selectedRecordForCorrection.attendanceDate}</span>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-xs font-semibold text-navy-700">وقت الدخول الصحيح</label>
                <input
                  type="time"
                  value={reqCheckIn}
                  onChange={(e) => setReqCheckIn(e.target.value)}
                  className="w-full rounded-xl border border-navy-200 p-2.5 text-sm outline-none"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold text-navy-700">وقت الخروج الصحيح</label>
                <input
                  type="time"
                  value={reqCheckOut}
                  onChange={(e) => setReqCheckOut(e.target.value)}
                  className="w-full rounded-xl border border-navy-200 p-2.5 text-sm outline-none"
                />
              </div>
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-navy-700">سبب التصحيح *</label>
              <textarea
                required
                rows={3}
                value={reqReason}
                onChange={(e) => setReqReason(e.target.value)}
                placeholder="اكتب مبرر التصحيح للمدير..."
                className="w-full rounded-xl border border-navy-200 p-2.5 text-sm outline-none"
              />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setCorrectionModalOpen(false)}
                className="rounded-xl border border-navy-200 px-3 py-1.5 text-xs font-semibold text-navy-700"
              >
                إلغاء
              </button>
              <button
                type="submit"
                disabled={submitting}
                className="rounded-xl bg-navy-800 px-4 py-1.5 text-xs font-semibold text-white"
              >
                {submitting ? "جاري الرفع..." : "رفع طلب التصحيح"}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {/* Create Schedule Modal */}
      {scheduleModalOpen && (
        <Modal onClose={() => setScheduleModalOpen(false)}>
          <form onSubmit={handleCreateSchedule} className="space-y-3">
            <h3 className="text-base font-bold text-navy-900">إنشاء جدول عمل وردية</h3>
            <div>
              <label className="mb-1 block text-xs font-semibold text-navy-700">مسمى الجدول *</label>
              <input
                required
                type="text"
                value={schedName}
                onChange={(e) => setSchedName(e.target.value)}
                placeholder="مثلاً: وردية صباحية للتمريض أو دوام الأطباء"
                className="w-full rounded-xl border border-navy-200 p-2.5 text-sm outline-none"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-navy-700">نمط الوردية</label>
              <select
                value={schedPattern}
                onChange={(e) => setSchedPattern(e.target.value)}
                className="w-full rounded-xl border border-navy-200 bg-white p-2.5 text-sm outline-none"
              >
                <option value="morning">وردية صباحية</option>
                <option value="evening">وردية مسائية</option>
                <option value="split">فترتان (صباح ومساء)</option>
                <option value="night">وردية ليلية</option>
              </select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-xs font-semibold text-navy-700">بداية الدوام</label>
                <input
                  type="time"
                  value={schedStart}
                  onChange={(e) => setSchedStart(e.target.value)}
                  className="w-full rounded-xl border border-navy-200 p-2.5 text-sm outline-none"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold text-navy-700">نهاية الدوام</label>
                <input
                  type="time"
                  value={schedEnd}
                  onChange={(e) => setSchedEnd(e.target.value)}
                  className="w-full rounded-xl border border-navy-200 p-2.5 text-sm outline-none"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setScheduleModalOpen(false)}
                className="rounded-xl border border-navy-200 px-3 py-1.5 text-xs font-semibold text-navy-700"
              >
                إلغاء
              </button>
              <button
                type="submit"
                disabled={submitting}
                className="rounded-xl bg-navy-800 px-4 py-1.5 text-xs font-semibold text-white"
              >
                {submitting ? "جاري الحفظ..." : "حفظ جدول العمل"}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </section>
  );
}
