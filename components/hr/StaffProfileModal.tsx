"use client";

import { useEffect, useState } from "react";
import { Modal } from "@/components/Modal";
import { HR_DEPARTMENT_LABEL, HR_WORK_STATUS_LABEL } from "@/lib/hr-shared";
import {
  HR_CONTRACT_KIND_LABELS,
  HR_CONTRACT_STATUS_LABELS,
} from "@/lib/hr-contracts-attendance-shared";
import { formatAmount, CURRENCY_SHORT, type Currency } from "@/lib/money";

interface StaffProfileModalProps {
  staffId: string | number | null;
  open: boolean;
  onClose: () => void;
}

export function StaffProfileModal({ staffId, open, onClose }: StaffProfileModalProps) {
  const [data, setData] = useState<any>(null);
  const [contracts, setContracts] = useState<any[]>([]);
  const [balances, setBalances] = useState<any[]>([]);
  const [recentAttendance, setRecentAttendance] = useState<any[]>([]);
  const [activeTab, setActiveTab] = useState<"overview" | "contract" | "attendance" | "leaves">("overview");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!open || !staffId) return;
    setLoading(true);

    Promise.all([
      fetch(`/api/hr/staff/${staffId}`, { cache: "no-store" }).then((r) => r.json()).catch(() => null),
      fetch(`/api/hr/contracts?staffId=${staffId}`, { cache: "no-store" }).then((r) => r.json()).catch(() => []),
      fetch(`/api/hr/leaves/balances?staffId=${staffId}`, { cache: "no-store" }).then((r) => r.json()).catch(() => []),
      fetch(`/api/hr/attendance?staffId=${staffId}`, { cache: "no-store" }).then((r) => r.json()).catch(() => []),
    ])
      .then(([staffData, contractsData, balancesData, attendanceData]) => {
        setData(staffData);
        setContracts(Array.isArray(contractsData) ? contractsData : []);
        setBalances(Array.isArray(balancesData) ? balancesData : []);
        setRecentAttendance(Array.isArray(attendanceData) ? attendanceData.slice(0, 7) : []);
      })
      .finally(() => {
        setLoading(false);
      });
  }, [open, staffId]);

  if (!open) return null;

  const staff = data?.staff;
  const activeContract = contracts.find((c) => c.status === "active") || contracts[0];

  return (
    <Modal open={open} onClose={onClose}>
      <div className="space-y-4">
        {loading ? (
          <div className="py-16 text-center text-sm text-navy-500">جاري تحميل الملف الشامل للموظف...</div>
        ) : !staff ? (
          <div className="p-6 text-center text-sm text-rose-600">تعذّر العثور على بيانات الموظف.</div>
        ) : (
          <>
            {/* Executive Hero Header */}
            <div className="relative overflow-hidden rounded-2xl bg-gradient-to-l from-navy-900 via-navy-800 to-navy-950 p-5 text-white shadow-md">
              <div className="relative z-10 flex flex-wrap items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-white/10 text-2xl font-bold backdrop-blur-sm">
                    {staff.fullName.slice(0, 1)}
                  </div>
                  <div>
                    <h3 className="text-xl font-bold tracking-tight">{staff.fullName}</h3>
                    <div className="mt-0.5 text-xs text-navy-200">
                      <span>{staff.jobTitle || "طاقم طبي/إداري"}</span>
                      <span className="mx-1.5">•</span>
                      <span>
                        {HR_DEPARTMENT_LABEL[staff.department as keyof typeof HR_DEPARTMENT_LABEL] || staff.department}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <span
                    className={`rounded-xl px-3 py-1 text-xs font-bold ${
                      staff.workStatus === "active"
                        ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30"
                        : "bg-amber-500/20 text-amber-300 border border-amber-500/30"
                    }`}
                  >
                    {HR_WORK_STATUS_LABEL[staff.workStatus as keyof typeof HR_WORK_STATUS_LABEL] || staff.workStatus}
                  </span>
                  {activeContract && (
                    <a
                      href={`/print/hr/contracts/${activeContract.id}`}
                      target="_blank"
                      rel="noreferrer"
                      className="rounded-xl bg-white/10 px-3 py-1 text-xs font-semibold text-white backdrop-blur-sm transition hover:bg-white/20"
                    >
                      طباعة العقد
                    </a>
                  )}
                </div>
              </div>
            </div>

            {/* Navigation Tabs */}
            <div className="flex gap-2 border-b border-navy-100 pb-2">
              <button
                type="button"
                onClick={() => setActiveTab("overview")}
                className={`rounded-xl px-4 py-2 text-xs font-bold transition ${
                  activeTab === "overview"
                    ? "bg-navy-800 text-white shadow-sm"
                    : "bg-navy-50 text-navy-700 hover:bg-navy-100"
                }`}
              >
                نظرة شاملة
              </button>
              <button
                type="button"
                onClick={() => setActiveTab("contract")}
                className={`rounded-xl px-4 py-2 text-xs font-bold transition ${
                  activeTab === "contract"
                    ? "bg-navy-800 text-white shadow-sm"
                    : "bg-navy-50 text-navy-700 hover:bg-navy-100"
                }`}
              >
                العقد وشروط الأجر ({contracts.length})
              </button>
              <button
                type="button"
                onClick={() => setActiveTab("leaves")}
                className={`rounded-xl px-4 py-2 text-xs font-bold transition ${
                  activeTab === "leaves"
                    ? "bg-navy-800 text-white shadow-sm"
                    : "bg-navy-50 text-navy-700 hover:bg-navy-100"
                }`}
              >
                رصيد الإجازات ({balances.length})
              </button>
              <button
                type="button"
                onClick={() => setActiveTab("attendance")}
                className={`rounded-xl px-4 py-2 text-xs font-bold transition ${
                  activeTab === "attendance"
                    ? "bg-navy-800 text-white shadow-sm"
                    : "bg-navy-50 text-navy-700 hover:bg-navy-100"
                }`}
              >
                سجل الدوام الأخير
              </button>
            </div>

            {/* Tab: Overview */}
            {activeTab === "overview" && (
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <div className="rounded-xl border border-navy-100 bg-white p-3 shadow-xs">
                    <span className="text-xs text-navy-400">تاريخ الالتحاق</span>
                    <div className="mt-1 font-semibold text-navy-800">{staff.hireDate || "—"}</div>
                  </div>
                  <div className="rounded-xl border border-navy-100 bg-white p-3 shadow-xs">
                    <span className="text-xs text-navy-400">رقم الهاتف</span>
                    <div className="mt-1 font-semibold text-navy-800 font-mono">{staff.phone || "غير مسجل"}</div>
                  </div>
                  <div className="rounded-xl border border-navy-100 bg-white p-3 shadow-xs">
                    <span className="text-xs text-navy-400">نوع التعاقد</span>
                    <div className="mt-1 font-semibold text-navy-800">
                      {HR_CONTRACT_KIND_LABELS[staff.contractKind as keyof typeof HR_CONTRACT_KIND_LABELS] ||
                        staff.contractKind}
                    </div>
                  </div>
                  <div className="rounded-xl border border-navy-100 bg-white p-3 shadow-xs">
                    <span className="text-xs text-navy-400">حساب النظام</span>
                    <div className="mt-1 font-semibold text-navy-800">
                      {data?.linkedUser ? `${data.linkedUser.displayName}` : "غير مربوط"}
                    </div>
                  </div>
                </div>

                {staff.note && (
                  <div className="rounded-xl border border-navy-100 bg-navy-50/50 p-3 text-xs">
                    <span className="font-bold text-navy-700">ملاحظات الإدارة:</span>
                    <p className="mt-1 text-navy-600 leading-relaxed">{staff.note}</p>
                  </div>
                )}
              </div>
            )}

            {/* Tab: Contract */}
            {activeTab === "contract" && (
              <div className="space-y-3">
                {contracts.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-navy-200 p-8 text-center text-xs text-navy-400">
                    لا يوجد عقد رسمي مسجل لهذا الموظف حتى الآن.
                  </div>
                ) : (
                  contracts.map((c) => (
                    <div key={c.id} className="rounded-xl border border-navy-100 bg-white p-4 shadow-xs">
                      <div className="flex items-center justify-between border-b border-navy-100 pb-2">
                        <div>
                          <div className="font-bold text-navy-900">{c.title}</div>
                          <div className="text-xs text-navy-500 font-mono">رقم العقد: {c.contractNumber}</div>
                        </div>
                        <span
                          className={`rounded-lg px-2.5 py-1 text-xs font-bold ${
                            c.status === "active" ? "bg-emerald-100 text-emerald-800" : "bg-navy-100 text-navy-700"
                          }`}
                        >
                          {HR_CONTRACT_STATUS_LABELS[c.status as keyof typeof HR_CONTRACT_STATUS_LABELS] || c.status}
                        </span>
                      </div>

                      <div className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4 font-mono">
                        <div>
                          <span className="text-navy-400 font-sans">الراتب الأساسي:</span>
                          <div className="font-bold text-navy-800">
                            {c.baseSalary > 0
                              ? `${formatAmount(c.baseSalary, c.currency as Currency)} ${
                                  CURRENCY_SHORT[c.currency as Currency] || c.currency
                                }`
                              : "—"}
                          </div>
                        </div>
                        <div>
                          <span className="text-navy-400 font-sans">نسبة الطبيب:</span>
                          <div className="font-bold text-emerald-700">
                            {c.commissionRate > 0 ? `${c.commissionRate}%` : "—"}
                          </div>
                        </div>
                        <div>
                          <span className="text-navy-400 font-sans">ساعات العمل:</span>
                          <div className="font-bold text-navy-800">{c.workingHoursPerWeek} ساعة/أسبوع</div>
                        </div>
                        <div>
                          <span className="text-navy-400 font-sans">السريان:</span>
                          <div className="font-bold text-navy-800">
                            {c.startDate} → {c.endDate || "مستمر"}
                          </div>
                        </div>
                      </div>

                      {c.clauses && (
                        <div className="mt-3 border-t border-navy-50 pt-2 text-xs text-navy-600">
                          <span className="font-bold text-navy-700">أبرز البنود: </span>
                          <span className="line-clamp-2">{c.clauses}</span>
                        </div>
                      )}
                    </div>
                  ))
                )}
              </div>
            )}

            {/* Tab: Leaves */}
            {activeTab === "leaves" && (
              <div className="space-y-3">
                {balances.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-navy-200 p-8 text-center text-xs text-navy-400">
                    لم يتم تخصيص أرصدة إجازات لهذا الموظف بعد.
                  </div>
                ) : (
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                    {balances.map((b) => (
                      <div key={b.id} className="rounded-xl border border-navy-100 bg-white p-3 shadow-xs">
                        <div className="text-xs font-semibold text-navy-500">{b.leaveTypeName}</div>
                        <div className="mt-2 flex items-baseline justify-between">
                          <span className="text-2xl font-bold text-navy-900">{b.remainingDays}</span>
                          <span className="text-xs text-navy-400">
                            مستخدم: {b.usedDays} / {b.allocatedDays}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Tab: Attendance */}
            {activeTab === "attendance" && (
              <div className="space-y-3">
                {recentAttendance.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-navy-200 p-8 text-center text-xs text-navy-400">
                    لا توجد سجلات دوام حديثة مسجلة.
                  </div>
                ) : (
                  <div className="overflow-x-auto rounded-xl border border-navy-100 bg-white">
                    <table className="w-full text-right text-xs">
                      <thead className="bg-navy-50 font-semibold text-navy-600">
                        <tr>
                          <th className="p-2">التاريخ</th>
                          <th className="p-2">الدخول</th>
                          <th className="p-2">الخروج</th>
                          <th className="p-2">الساعات</th>
                          <th className="p-2">الحالة</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-navy-50 font-mono">
                        {recentAttendance.map((a) => (
                          <tr key={a.id}>
                            <td className="p-2">{a.date}</td>
                            <td className="p-2">{a.checkIn ? a.checkIn.slice(11, 16) : "—"}</td>
                            <td className="p-2">{a.checkOut ? a.checkOut.slice(11, 16) : "—"}</td>
                            <td className="p-2 font-sans font-semibold">{(a.actualMinutes / 60).toFixed(1)} س</td>
                            <td className="p-2 font-sans">
                              <span className="rounded px-2 py-0.5 text-xs font-semibold bg-navy-100 text-navy-800">
                                {a.status}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}

            <div className="flex justify-end border-t border-navy-100 pt-3">
              <button
                type="button"
                onClick={onClose}
                className="rounded-xl bg-navy-100 px-5 py-2 text-xs font-bold text-navy-800 transition hover:bg-navy-200"
              >
                إغلاق الملف
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
