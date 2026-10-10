"use client";

import { useCallback, useEffect, useState } from "react";
import { Modal } from "@/components/Modal";
import { CLINIC_ZONE_FALLBACK } from "@/lib/clinicZone";
import { clinicDateString } from "@/lib/schedule";
import {
  HR_LEAVE_STATUS_LABELS,
  type HrLeaveStatus,
} from "@/lib/hr-contracts-attendance-shared";

interface LeaveRequestItem {
  id: string;
  staffId: string;
  staffName?: string;
  jobTitle?: string;
  leaveTypeId: string;
  leaveTypeName?: string;
  startDate: string;
  endDate: string;
  daysCount: number;
  reason: string;
  status: HrLeaveStatus;
  approvedBy: string | null;
  decisionNotes: string | null;
  createdAt: string;
}

interface LeaveTypeItem {
  id: string;
  name: string;
  code: string;
  isPaid: boolean;
  defaultDaysPerYear: number;
}

interface LeaveBalanceItem {
  id: string;
  staffId: string;
  leaveTypeId: string;
  leaveTypeName: string;
  year: number;
  allocatedDays: number;
  usedDays: number;
  remainingDays: number;
}

interface StaffOption {
  id: number;
  fullName: string;
  jobTitle: string;
}

export function HrLeavesPanel({ isAdmin = false }: { isAdmin?: boolean }) {
  const [requests, setRequests] = useState<LeaveRequestItem[]>([]);
  const [leaveTypes, setLeaveTypes] = useState<LeaveTypeItem[]>([]);
  const [staffOptions, setStaffOptions] = useState<StaffOption[]>([]);
  const [balances, setBalances] = useState<LeaveBalanceItem[]>([]);
  const [selectedStaffForBalance, setSelectedStaffForBalance] = useState<string>("");
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Modals
  const [requestModalOpen, setRequestModalOpen] = useState(false);
  const [adjustModalOpen, setAdjustModalOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // New Request Form
  const [reqStaffId, setReqStaffId] = useState("");
  const [reqTypeId, setReqTypeId] = useState("");
  const [reqStartDate, setReqStartDate] = useState(() => clinicDateString(new Date(), CLINIC_ZONE_FALLBACK));
  const [reqEndDate, setReqEndDate] = useState(() => clinicDateString(new Date(), CLINIC_ZONE_FALLBACK));
  const [reqReason, setReqReason] = useState("");

  // Balance Adjust Form
  const [adjStaffId, setAdjStaffId] = useState("");
  const [adjTypeId, setAdjTypeId] = useState("");
  const [adjDays, setAdjDays] = useState("30");
  const [adjReason, setAdjReason] = useState("تخصيص رصيد سنوي");

  const loadLeaves = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (statusFilter) params.set("status", statusFilter);
      params.set("types", "true");

      const res = await fetch(`/api/hr/leaves?${params.toString()}`, { cache: "no-store" });
      if (!res.ok) throw new Error("تعذّر تحميل طلبات الإجازات.");
      const data = await res.json();
      setRequests(data.requests || []);
      setLeaveTypes(data.types || []);
      setError(null);
    } catch (err: any) {
      setError(err?.message || "حدث خطأ أثناء تحميل الإجازات.");
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

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

  const loadBalances = useCallback(async (staffId: string) => {
    if (!staffId) return;
    try {
      const res = await fetch(`/api/hr/leaves/balances?staffId=${staffId}`, { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        setBalances(data);
      }
    } catch {
      // Ignored
    }
  }, []);

  useEffect(() => {
    void loadLeaves();
    void loadStaff();
  }, [loadLeaves, loadStaff]);

  useEffect(() => {
    if (selectedStaffForBalance) {
      void loadBalances(selectedStaffForBalance);
    }
  }, [selectedStaffForBalance, loadBalances]);

  const handleCreateRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!reqStaffId || !reqTypeId || !reqStartDate || !reqEndDate || !reqReason) {
      alert("يرجى ملء جميع الحقول الإلزامية.");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/hr/leaves", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          staffId: reqStaffId,
          leaveTypeId: reqTypeId,
          startDate: reqStartDate,
          endDate: reqEndDate,
          reason: reqReason,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || "تعذّر رفع طلب الإجازة.");
      }

      setRequestModalOpen(false);
      setReqReason("");
      void loadLeaves();
      if (selectedStaffForBalance === reqStaffId) {
        void loadBalances(reqStaffId);
      }
    } catch (err: any) {
      alert(err.message || "حدث خطأ أثناء رفع الطلب.");
    } finally {
      setSubmitting(false);
    }
  };

  const handleDecideRequest = async (id: string, status: "approved" | "rejected") => {
    const notes = prompt(status === "approved" ? "ملاحظة الاعتماد (اختياري):" : "سبب رفض الإجازة:") || "";
    try {
      const res = await fetch(`/api/hr/leaves/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status,
          decisionNotes: notes,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || "تعذّر تنفيذ القرار.");
      }

      void loadLeaves();
      if (selectedStaffForBalance) {
        void loadBalances(selectedStaffForBalance);
      }
    } catch (err: any) {
      alert(err.message || "حدث خطأ أثناء معالجة القرار.");
    }
  };

  const handleAdjustBalance = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!adjStaffId || !adjTypeId) return;
    setSubmitting(true);
    try {
      const res = await fetch("/api/hr/leaves/balances", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          staffId: adjStaffId,
          leaveTypeId: adjTypeId,
          allocatedDays: parseInt(adjDays, 10) || 0,
          reason: adjReason,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || "تعذّر تعديل الرصيد.");
      }

      setAdjustModalOpen(false);
      if (selectedStaffForBalance === adjStaffId) {
        void loadBalances(adjStaffId);
      }
    } catch (err: any) {
      alert(err.message || "حدث خطأ أثناء تعديل الرصيد.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section aria-label="إدارة الإجازات والأرصدة" className="space-y-4">
      {/* Top action & balance selector */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-xs font-semibold text-navy-600">عرض رصيد الموظف:</label>
          <select
            value={selectedStaffForBalance}
            onChange={(e) => setSelectedStaffForBalance(e.target.value)}
            className="rounded-xl border border-navy-200 bg-white px-3 py-2 text-sm text-navy-800 outline-none"
          >
            <option value="">اختر الموظف لعرض أرصدته...</option>
            {staffOptions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.fullName}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-2">
          {isAdmin && (
            <button
              type="button"
              onClick={() => setAdjustModalOpen(true)}
              className="rounded-xl border border-navy-200 bg-white px-3 py-2 text-xs font-semibold text-navy-800 hover:bg-navy-50"
            >
              تعديل رصيد
            </button>
          )}
          <button
            type="button"
            onClick={() => setRequestModalOpen(true)}
            className="flex items-center gap-2 rounded-xl bg-navy-800 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-navy-700"
          >
            <span>+</span>
            <span>تقديم طلب إجازة</span>
          </button>
        </div>
      </div>

      {/* Balance Badges */}
      {selectedStaffForBalance && balances.length > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {balances.map((b) => (
            <div key={b.id} className="rounded-2xl border border-navy-100 bg-white p-3 shadow-sm">
              <div className="text-xs font-semibold text-navy-500">{b.leaveTypeName}</div>
              <div className="mt-1 flex items-baseline justify-between">
                <span className="text-xl font-bold text-navy-900">{b.remainingDays} يوم</span>
                <span className="text-xs text-navy-400">مستخدم: {b.usedDays} / {b.allocatedDays}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-navy-100 bg-white p-3 shadow-sm">
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="rounded-xl border border-navy-200 bg-white px-3 py-1.5 text-sm text-navy-800 outline-none"
        >
          <option value="">جميع الحالات</option>
          {Object.entries(HR_LEAVE_STATUS_LABELS).map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </select>
      </div>

      {error && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
          {error}
        </div>
      )}

      {/* Requests table */}
      {loading ? (
        <div className="py-12 text-center text-sm text-navy-500">جاري تحميل طلبات الإجازات...</div>
      ) : requests.length === 0 ? (
        <div className="rounded-2xl border border-navy-100 bg-white p-8 text-center text-navy-500">
          لا توجد طلبات إجازة مسجلة.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-navy-100 bg-white shadow-sm">
          <table className="w-full text-right text-sm">
            <thead className="border-b border-navy-100 bg-navy-50/60 text-xs font-semibold text-navy-600">
              <tr>
                <th className="px-4 py-3">الموظف</th>
                <th className="px-4 py-3">نوع الإجازة</th>
                <th className="px-4 py-3">الفترة (من - إلى)</th>
                <th className="px-4 py-3">الأيام</th>
                <th className="px-4 py-3">السبب</th>
                <th className="px-4 py-3">الحالة</th>
                <th className="px-4 py-3 text-center">إجراءات</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-navy-100">
              {requests.map((r) => (
                <tr key={r.id} className="transition hover:bg-navy-50/40">
                  <td className="px-4 py-3 font-semibold text-navy-900">
                    <div>{r.staffName || `موظف #${r.staffId}`}</div>
                    {r.jobTitle && <div className="text-xs text-navy-500">{r.jobTitle}</div>}
                  </td>
                  <td className="px-4 py-3">
                    <span className="rounded-lg bg-navy-100 px-2 py-0.5 text-xs font-semibold text-navy-700">
                      {r.leaveTypeName || "إجازة"}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs">
                    <div>من: {r.startDate}</div>
                    <div className="text-navy-500">إلى: {r.endDate}</div>
                  </td>
                  <td className="px-4 py-3 font-semibold text-navy-800">{r.daysCount} يوم</td>
                  <td className="px-4 py-3 text-xs text-navy-700 max-w-xs truncate">{r.reason}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-block rounded-lg px-2.5 py-1 text-xs font-semibold ${
                        r.status === "approved"
                          ? "bg-emerald-100 text-emerald-800"
                          : r.status === "pending"
                          ? "bg-amber-100 text-amber-800"
                          : r.status === "rejected"
                          ? "bg-rose-100 text-rose-800"
                          : "bg-navy-100 text-navy-700"
                      }`}
                    >
                      {HR_LEAVE_STATUS_LABELS[r.status] || r.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-center">
                    {r.status === "pending" ? (
                      <div className="flex items-center justify-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => void handleDecideRequest(r.id, "approved")}
                          className="rounded-lg bg-emerald-700 px-2.5 py-1 text-xs font-semibold text-white hover:bg-emerald-800"
                        >
                          قبول
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleDecideRequest(r.id, "rejected")}
                          className="rounded-lg bg-rose-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-rose-700"
                        >
                          رفض
                        </button>
                      </div>
                    ) : (
                      <span className="text-xs text-navy-400">مكتمل</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Request Leave Modal */}
      {requestModalOpen && (
        <Modal onClose={() => setRequestModalOpen(false)}>
          <form onSubmit={handleCreateRequest} className="space-y-3">
            <h3 className="text-base font-bold text-navy-900">طلب إجازة جديدة</h3>
            <div>
              <label className="mb-1 block text-xs font-semibold text-navy-700">الموظف *</label>
              <select
                required
                value={reqStaffId}
                onChange={(e) => setReqStaffId(e.target.value)}
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
            <div>
              <label className="mb-1 block text-xs font-semibold text-navy-700">نوع الإجازة *</label>
              <select
                required
                value={reqTypeId}
                onChange={(e) => setReqTypeId(e.target.value)}
                className="w-full rounded-xl border border-navy-200 p-2.5 text-sm outline-none"
              >
                <option value="">اختر نوع الإجازة...</option>
                {leaveTypes.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} {t.isPaid ? "(مدفوعة)" : "(غير مدفوعة)"}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-xs font-semibold text-navy-700">من تاريخ *</label>
                <input
                  required
                  type="date"
                  value={reqStartDate}
                  onChange={(e) => setReqStartDate(e.target.value)}
                  className="w-full rounded-xl border border-navy-200 p-2.5 text-sm outline-none"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold text-navy-700">إلى تاريخ *</label>
                <input
                  required
                  type="date"
                  value={reqEndDate}
                  onChange={(e) => setReqEndDate(e.target.value)}
                  className="w-full rounded-xl border border-navy-200 p-2.5 text-sm outline-none"
                />
              </div>
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-navy-700">سبب الإجازة *</label>
              <textarea
                required
                rows={3}
                value={reqReason}
                onChange={(e) => setReqReason(e.target.value)}
                placeholder="اكتب سبب طلب الإجازة..."
                className="w-full rounded-xl border border-navy-200 p-2.5 text-sm outline-none"
              />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setRequestModalOpen(false)}
                className="rounded-xl border border-navy-200 px-3 py-1.5 text-xs font-semibold text-navy-700"
              >
                إلغاء
              </button>
              <button
                type="submit"
                disabled={submitting}
                className="rounded-xl bg-navy-800 px-4 py-1.5 text-xs font-semibold text-white"
              >
                {submitting ? "جاري الرفع..." : "إرسال طلب الإجازة"}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {/* Adjust Balance Modal */}
      {adjustModalOpen && (
        <Modal onClose={() => setAdjustModalOpen(false)}>
          <form onSubmit={handleAdjustBalance} className="space-y-3">
            <h3 className="text-base font-bold text-navy-900">تعديل رصيد إجازة لموظف</h3>
            <div>
              <label className="mb-1 block text-xs font-semibold text-navy-700">الموظف *</label>
              <select
                required
                value={adjStaffId}
                onChange={(e) => setAdjStaffId(e.target.value)}
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
            <div>
              <label className="mb-1 block text-xs font-semibold text-navy-700">نوع الإجازة *</label>
              <select
                required
                value={adjTypeId}
                onChange={(e) => setAdjTypeId(e.target.value)}
                className="w-full rounded-xl border border-navy-200 p-2.5 text-sm outline-none"
              >
                <option value="">اختر النوع...</option>
                {leaveTypes.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-navy-700">عدد الأيام المخصصة *</label>
              <input
                required
                type="number"
                value={adjDays}
                onChange={(e) => setAdjDays(e.target.value)}
                className="w-full rounded-xl border border-navy-200 p-2.5 text-sm outline-none"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-navy-700">السبب</label>
              <input
                type="text"
                value={adjReason}
                onChange={(e) => setAdjReason(e.target.value)}
                className="w-full rounded-xl border border-navy-200 p-2.5 text-sm outline-none"
              />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setAdjustModalOpen(false)}
                className="rounded-xl border border-navy-200 px-3 py-1.5 text-xs font-semibold text-navy-700"
              >
                إلغاء
              </button>
              <button
                type="submit"
                disabled={submitting}
                className="rounded-xl bg-navy-800 px-4 py-1.5 text-xs font-semibold text-white"
              >
                {submitting ? "جاري التعديل..." : "حفظ الرصيد"}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </section>
  );
}
