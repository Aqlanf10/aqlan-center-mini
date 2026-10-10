"use client";

import { useState } from "react";
import { useSession } from "@/components/SessionProvider";
import { PageHeader } from "@/components/PageHeader";
import { HrTasksPanel } from "@/components/hr/TasksPanel";
import { HrStaffPanel } from "@/components/hr/StaffPanel";
import { HrContractsPanel } from "@/components/hr/ContractsPanel";
import { HrAttendancePanel } from "@/components/hr/AttendancePanel";
import { HrLeavesPanel } from "@/components/hr/LeavesPanel";
import { HrPayrollPanel } from "@/components/hr/PayrollPanel";
import { HrReportsPanel } from "@/components/hr/ReportsPanel";
import { isAdmin } from "@/lib/roles";

type HrTab = "tasks" | "staff" | "contracts" | "attendance" | "leaves" | "payroll" | "reports";

/**
 * «الموارد البشرية والمهام» — الوحدة الشاملة والمترابطة لإدارة الطاقم في مركز عقلان.
 *
 * تصميم عالمي موحّد يربط دورة حياة الموظف كاملة:
 * ملف الموظف ← العقد وشروط الأجر ← جدول الدوام والورديات ← البصمات والحضور ←
 * الإجازات والأرصدة ← المهام اليومية ← المسير ومستحقات النسبة ← الصرف والتقارير المالية.
 */
export default function HrPage() {
  const session = useSession();
  const [tab, setTab] = useState<HrTab>("tasks");
  const admin = isAdmin(session?.role);

  const TABS = [
    { id: "tasks" as HrTab, label: "المهام", icon: "✓", visible: true },
    { id: "staff" as HrTab, label: "الطاقم", icon: "👥", visible: admin },
    { id: "contracts" as HrTab, label: "العقود", icon: "📄", visible: admin },
    { id: "attendance" as HrTab, label: "الدوام والحضور", icon: "⏱️", visible: admin || session?.role === "reception" },
    { id: "leaves" as HrTab, label: "الإجازات", icon: "🌴", visible: true },
    { id: "payroll" as HrTab, label: "المسير والصرف", icon: "💰", visible: admin },
    { id: "reports" as HrTab, label: "التقارير", icon: "📊", visible: admin },
  ];

  return (
    <div className="mx-auto w-full max-w-7xl px-3 pb-20 pt-4 sm:px-6">
      <PageHeader
        title="الموارد البشرية والمهام"
        subtitle="وحدة تشغيلية مترابطة لإدارة الطاقم الطبي والإداري، العقود، الدوام، الإجازات، مسير الرواتب ونسب الأطباء."
      />

      {/* World-Class Modern Tabs Navigation */}
      <div className="mb-6 overflow-hidden rounded-2xl border border-navy-100 bg-white p-1.5 shadow-sm">
        <div
          role="tablist"
          aria-label="أقسام الموارد البشرية"
          className="flex gap-1.5 overflow-x-auto no-scrollbar scroll-smooth"
        >
          {TABS.filter((t) => t.visible).map((t) => {
            const isActive = tab === t.id;
            return (
              <button
                key={t.id}
                role="tab"
                aria-selected={isActive}
                onClick={() => setTab(t.id)}
                className={`flex shrink-0 items-center gap-2 rounded-xl px-4 py-2.5 text-xs font-bold transition-all duration-200 ${
                  isActive
                    ? "bg-navy-900 text-white shadow-md shadow-navy-950/20"
                    : "text-navy-600 hover:bg-navy-50 hover:text-navy-900"
                }`}
              >
                <span>{t.icon}</span>
                <span>{t.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Main Tab Panels with smooth mounting */}
      <main className="min-h-[500px]">
        {tab === "tasks" && <HrTasksPanel session={session} />}
        {tab === "staff" && admin && <HrStaffPanel />}
        {tab === "contracts" && admin && <HrContractsPanel />}
        {tab === "attendance" && <HrAttendancePanel isAdmin={admin} />}
        {tab === "leaves" && <HrLeavesPanel isAdmin={admin} />}
        {tab === "payroll" && admin && <HrPayrollPanel />}
        {tab === "reports" && admin && <HrReportsPanel />}
      </main>
    </div>
  );
}
