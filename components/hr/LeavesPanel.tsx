"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useHrStaffSelection } from "./HrNavigation";
import { useSession } from "@/components/SessionProvider";
import { Modal } from "@/components/Modal";
import { CLINIC_ZONE_FALLBACK } from "@/lib/clinicZone";
import { clinicDateString } from "@/lib/schedule";
import {
  HR_LEAVE_STATUS_LABELS,
  type HrLeaveStatus,
} from "@/lib/hr-contracts-attendance-shared";

type LeaveRequestItem = import("@/lib/hr-contracts-attendance-shared").HrLeaveRequestView;
type LeaveBalanceItem = import("@/lib/hr-contracts-attendance-shared").HrLeaveBalanceView;
interface LeaveTypeItem { id: number; nameAr: string; code: string; isPaid: boolean; defaultDaysPerYear: number; requiresAttachment?: boolean; }

interface StaffOption {
  id: number;
  fullName: string;
  jobTitle: string;
}

function leaveReferenceLabel(value: unknown): string {
  const invalid = "مرجع قديم يحتاج مراجعة (غير صالح)";
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid;
  const { id, name } = value as Record<string, unknown>;
  if (typeof id !== "string" || !id.trim() || id.length > 200
    || typeof name !== "string" || !name.trim() || name.length > 200) return invalid;
  return `${name} (${id})`;
}

export function HrLeavesPanel(props: { isAdmin?: boolean }) {
  const session = useSession();
  // A new signed owner gets a new view, including forms, selections and readers.
  return <HrLeavesView key={session ? `${session.username}\u0000${session.role}` : "signed-out"} {...props} />;
}

function HrLeavesView({ isAdmin = false }: { isAdmin?: boolean }) {
  const [requests, setRequests] = useState<LeaveRequestItem[]>([]);
  const [leaveTypes, setLeaveTypes] = useState<LeaveTypeItem[]>([]);
  const [staffOptions, setStaffOptions] = useState<StaffOption[]>([]);
  const [balances, setBalances] = useState<LeaveBalanceItem[]>([]);
  const [selectedStaffForBalance, setSelectedStaffForBalance] = useHrStaffSelection();
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [balanceError, setBalanceError] = useState<string | null>(null);
  const [balancesLoading, setBalancesLoading] = useState(false);
  const alive = useRef(true), leavesGeneration = useRef(0), balancesGeneration = useRef(0);
  const balanceSelection = useRef(selectedStaffForBalance), filterSelection = useRef("");
  const decisionInFlight = useRef(false);
  useLayoutEffect(() => {
    balanceSelection.current = selectedStaffForBalance;
    leavesGeneration.current++; balancesGeneration.current++;
    setRequests([]); setBalances([]); setLoading(true);
  }, [selectedStaffForBalance]);
  useLayoutEffect(() => {
    alive.current = true;
    return () => { alive.current = false; leavesGeneration.current++; balancesGeneration.current++; };
  }, []);

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
  const [reqAttachmentRef, setReqAttachmentRef] = useState("");

  // Balance Adjust Form
  const [adjStaffId, setAdjStaffId] = useState("");
  const [adjTypeId, setAdjTypeId] = useState("");
  const [adjDays, setAdjDays] = useState("");
  const [adjReason, setAdjReason] = useState("تخصيص رصيد سنوي");

  const loadLeaves = useCallback(async () => {
    if (!alive.current || statusFilter !== filterSelection.current || selectedStaffForBalance !== balanceSelection.current) return;
    const generation = ++leavesGeneration.current;
    const current = () => alive.current && generation === leavesGeneration.current && statusFilter === filterSelection.current && selectedStaffForBalance === balanceSelection.current;
    setLoading(true); setRequests([]); setError(null);
    try {
      const params = new URLSearchParams();
      if (statusFilter) params.set("status", statusFilter);
      if (selectedStaffForBalance) params.set("staffId", selectedStaffForBalance);
      params.set("types", "true");

      const res = await fetch(`/api/hr/leaves?${params.toString()}`, { cache: "no-store" });
      if (!res.ok) throw new Error("تعذّر تحميل طلبات الإجازات.");
      const data = await res.json();
      if (!current()) return;
      if (!Array.isArray(data.requests) || !Array.isArray(data.types) || !Array.isArray(data.staff)) throw new Error("تعذّر التحقق من بيانات الإجازات.");
      setRequests(data.requests || []);
      setLeaveTypes(data.types || []);
      setStaffOptions(data.staff || []);
      setError(null);
    } catch (err: any) {
      if (current()) { setRequests([]); setLeaveTypes([]); setStaffOptions([]); setError(err?.message || "حدث خطأ أثناء تحميل الإجازات."); }
    } finally {
      if (current()) setLoading(false);
    }
  }, [statusFilter, selectedStaffForBalance]);

  const loadBalances = useCallback(async (staffId: string) => {
    if (!alive.current || staffId !== balanceSelection.current) return;
    const generation = ++balancesGeneration.current;
    const current = () => alive.current && generation === balancesGeneration.current && staffId === balanceSelection.current;
    setBalances([]); setBalanceError(null); setBalancesLoading(Boolean(staffId));
    if (!staffId) return;
    try {
      const res = await fetch(`/api/hr/leaves/balances?staffId=${staffId}`, { cache: "no-store" });
      if (!res.ok) throw new Error("تعذّر تحميل رصيد الموظف المختار.");
      const data = await res.json();
      if (!Array.isArray(data) || data.some(row => String(row.staffId) !== staffId)) throw new Error("تعذّر التحقق من رصيد الموظف المختار.");
      if (current()) setBalances(data);
    } catch {
      if (current()) { setBalances([]); setBalanceError("تعذّر تحميل رصيد الموظف المختار."); }
    } finally { if (current()) setBalancesLoading(false); }
  }, []);

  useEffect(() => {
    void loadLeaves();
    return () => { leavesGeneration.current++; };
  }, [loadLeaves]);

  useEffect(() => {
    void loadBalances(selectedStaffForBalance);
    return () => { balancesGeneration.current++; };
  }, [selectedStaffForBalance, loadBalances]);

  const handleCreateRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!alive.current) return;
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
          leaveTypeCode: reqTypeId,
          startDate: reqStartDate,
          endDate: reqEndDate,
          reason: reqReason,
          attachmentRefs: reqAttachmentRef.trim() ? [{id:reqAttachmentRef.trim(),name:"مستند مقدم للمراجعة — " + reqAttachmentRef.trim()}] : [],
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || "تعذّر رفع طلب الإجازة.");
      }

      if (!alive.current) return;
      setRequestModalOpen(false);
      setReqReason("");
      setReqAttachmentRef("");
      void loadLeaves();
      if (selectedStaffForBalance === reqStaffId) {
        void loadBalances(reqStaffId);
      }
    } catch (err: any) {
      if (alive.current) alert(err.message || "حدث خطأ أثناء رفع الطلب.");
    } finally {
      setSubmitting(false);
    }
  };

  const handleDecideRequest = async (id: number, status: "approved" | "rejected" | "cancelled") => {
    if (!alive.current || !isAdmin || decisionInFlight.current) return;
    const notes = prompt(status === "approved" ? "ملاحظة الاعتماد (اختياري):" : status === "cancelled" ? "سبب إلغاء الإجازة:" : "سبب رفض الإجازة:");
    if (notes === null || !alive.current) return;
    decisionInFlight.current = true; setSubmitting(true);
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

      if (!alive.current) return;
      void loadLeaves();
      if (selectedStaffForBalance) {
        void loadBalances(selectedStaffForBalance);
      }
    } catch (err: any) {
      if (alive.current) alert(err.message || "حدث خطأ أثناء معالجة القرار.");
    } finally { decisionInFlight.current = false; if (alive.current) setSubmitting(false); }
  };

  const handleAdjustBalance = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!alive.current || !isAdmin) return;
    if (!adjStaffId || !adjTypeId) return;
    const allocatedDays = Number(adjDays);
    if (!adjDays.trim() || !Number.isFinite(allocatedDays) || allocatedDays < 0 || allocatedDays > 366) {
      alert("أدخل عدد أيام صالحًا بين 0 و366.");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/hr/leaves/balances", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          staffId: adjStaffId,
          leaveTypeId: adjTypeId,
          allocatedDays,
          reason: adjReason,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || "تعذّر تعديل الرصيد.");
      }

      if (!alive.current) return;
      setAdjustModalOpen(false);
      if (selectedStaffForBalance === adjStaffId) {
        void loadBalances(adjStaffId);
      }
    } catch (err: any) {
      if (alive.current) alert(err.message || "حدث خطأ أثناء تعديل الرصيد.");
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
            aria-label="عرض رصيد الموظف"
            onChange={(e) => { balanceSelection.current = e.target.value; balancesGeneration.current++; setBalances([]); setBalanceError(null); setBalancesLoading(Boolean(e.target.value)); setSelectedStaffForBalance(e.target.value); }}
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
      {balancesLoading && <p role="status" className="text-sm text-navy-500">جارٍ تحميل رصيد الموظف المختار…</p>}
      {balanceError && <p role="alert" className="text-sm text-rose-700">{balanceError}</p>}
      {selectedStaffForBalance && balances.length > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {balances.map((b) => (
            <div key={b.id} className="rounded-2xl border border-navy-100 bg-white p-3 shadow-sm">
              <div className="text-xs font-semibold text-navy-500">{b.leaveTypeName}</div>
              <div className="mt-1 flex items-baseline justify-between">
                <span className="text-xl font-bold text-navy-900">{b.availableDays} يوم</span>
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
          aria-label="حالة طلب الإجازة"
          onChange={(e) => { filterSelection.current = e.target.value; leavesGeneration.current++; setRequests([]); setLoading(true); setStatusFilter(e.target.value); }}
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
                    {r.staffJobTitle && <div className="text-xs text-navy-500">{r.staffJobTitle}</div>}
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
                  <td className="px-4 py-3 text-xs text-navy-700 max-w-xs">{r.reason}{r.attachmentRefs?.length>0 && <ul aria-label="مراجع مستندات مقدمة للمراجعة" className="mt-1 text-navy-500">{r.attachmentRefs.map((ref,index)=><li key={index}>{leaveReferenceLabel(ref)}</li>)}</ul>}</td>
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
                    {isAdmin && r.status === "pending" ? (
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
                      isAdmin && r.status === "approved" ? <button type="button" onClick={() => void handleDecideRequest(r.id,"cancelled")} className="rounded-lg bg-rose-600 px-2.5 py-1 text-white">إلغاء الإجازة وعكس الرصيد</button> : <span className="text-xs text-navy-400">مكتمل</span>
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
        <Modal alignTop onClose={() => setRequestModalOpen(false)}>
          <form onSubmit={handleCreateRequest} className="mx-auto w-full min-w-0 max-w-3xl rounded-2xl border border-navy-100 bg-white p-4 shadow-raised sm:p-5 [overflow-wrap:anywhere] [&_div]:min-w-0 [&_fieldset]:min-w-0 [&_input]:min-w-0 [&_select]:min-w-0 [&_textarea]:min-w-0 space-y-3">
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
                  <option key={t.id} value={t.code}>
                    {t.nameAr} {t.isPaid ? "(مدفوعة)" : "(غير مدفوعة)"}
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
            <label className="block text-xs font-semibold text-navy-700">مرجع المستند المقدم للمراجع
              <input type="text" maxLength={160} required={leaveTypes.find(type=>type.code===reqTypeId)?.requiresAttachment===true} value={reqAttachmentRef} onChange={e=>setReqAttachmentRef(e.target.value)} className="mt-1 w-full rounded-xl border border-navy-200 p-2.5 text-sm" />
              <span className="mt-1 block font-normal">يسجل مرجع مستند ورقي أو محفوظ لدى المركز؛ لا يرفع ملفًا ولا يثبت فحص محتواه. يراجعه المسؤول قبل الاعتماد.</span>
            </label>
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
                {submitting ? "جاري الحفظ..." : "إرسال طلب الإجازة"}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {/* Adjust Balance Modal */}
      {adjustModalOpen && (
        <Modal alignTop onClose={() => setAdjustModalOpen(false)}>
          <form onSubmit={handleAdjustBalance} className="mx-auto w-full min-w-0 max-w-3xl rounded-2xl border border-navy-100 bg-white p-4 shadow-raised sm:p-5 [overflow-wrap:anywhere] [&_div]:min-w-0 [&_fieldset]:min-w-0 [&_input]:min-w-0 [&_select]:min-w-0 [&_textarea]:min-w-0 space-y-3">
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
                  <option key={t.id} value={t.code}>
                    {t.nameAr}
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
                min={0}
                max={366}
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
