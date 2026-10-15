"use client";

import { Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { HR_TABS, PROFILE_TABS, hrHref, hrId, type HrTab, type HrProfileTab } from '@/lib/hr-navigation';
import { HrNavigationContext } from '@/components/hr/HrNavigation';
import { createContractSaveAdmissionGate, type ContractSaveAdmissionLease, type PendingContractSave } from "@/lib/hr-contract-save-receipt";
import { useSession } from "@/components/SessionProvider";
import { PageHeader } from "@/components/PageHeader";
import { HrTasksPanel } from "@/components/hr/TasksPanel";
import { HrStaffPanel } from "@/components/hr/StaffPanel";
import { HrContractsPanel } from "@/components/hr/ContractsPanel";
import { HrAttendancePanel } from "@/components/hr/AttendancePanel";
import { HrLeavesPanel } from "@/components/hr/LeavesPanel";
import { HrPayrollPanel } from "@/components/hr/PayrollPanel";
import { HrReportsPanel } from "@/components/hr/ReportsPanel";
import { HrHistoryDraftProvider } from "@/components/hr/HistoryDraftProvider";
import { HrSettingsPanel } from "@/components/hr/SettingsPanel";
import { HrPayrollHistoryPanel } from "@/components/hr/PayrollHistoryPanel";
import { isAdmin } from "@/lib/roles";

// Server markup and the first hydration render stay non-interactive. React
// publishes the client snapshot only after it owns the mounted tab handlers.
const subscribeHydration = () => () => {};
const clientHydrated = () => true;
const serverHydrated = () => false;


/**
 * «الموارد البشرية والمهام» — الوحدة الشاملة والمترابطة لإدارة الطاقم في مركز عقلان.
 *
 * تصميم عالمي موحّد يربط دورة حياة الموظف كاملة:
 * ملف الموظف ← العقد وشروط الأجر ← جدول الدوام والورديات ← البصمات والحضور ←
 * الإجازات والأرصدة ← المهام اليومية ← المسير ومستحقات النسبة ← الصرف والتقارير المالية.
 */
export default function HrPage() {
  return <Suspense fallback={<p role="status">جارٍ تحميل الموارد البشرية…</p>}><HrPageView /></Suspense>;
}
function HrPageView() {
  const session = useSession();
  const searchParams = useSearchParams(), router = useRouter();
  const query = searchParams.toString();
  const requestedTab = searchParams.get('tab') as HrTab;
  const hydrated = useSyncExternalStore(subscribeHydration, clientHydrated, serverHydrated);
  const admin = isAdmin(session?.role);
  const allowed = (id: HrTab) => ['tasks', 'leaves'].includes(id) || admin || (id === 'attendance' && session?.role === 'reception');
  const tab = HR_TABS.includes(requestedTab) && allowed(requestedTab) ? requestedTab : 'tasks';
  const staffId = admin || session?.role === 'reception' ? hrId(searchParams.get('staffId')) : '';
  const contractId = admin ? hrId(searchParams.get('contractId')) : '';
  const requestedProfileTab = searchParams.get('profileTab') as HrProfileTab;
  const profileTab = PROFILE_TABS.includes(requestedProfileTab) ? requestedProfileTab : 'overview';
  const href = (patch: Record<string, string | null>) => hrHref(query, patch);
  const owner = session ? `${session.username}\u0000${session.role}` : "";
  // Private contract intent belongs to this HR page and signed owner, above
  // tab mounting. It is never written to browser storage or automatically retried.
  const [contractSaves, setContractSaves] = useState<Record<string, PendingContractSave | undefined>>({});
  const contractSavesRef = useRef(contractSaves);
  const [saveAdmissionGate] = useState(createContractSaveAdmissionGate);
  const saveAdmission = useMemo(() => Object.freeze({ owner, admin, contractsVisible: tab === "contracts" }), [owner, admin, tab]);
  // Commit, never render, advances the live owner/tab generation. An old A
  // callback is not admitted after A -> B -> A or a detach/reopen cycle.
  useLayoutEffect(() => saveAdmissionGate.commit(saveAdmission), [saveAdmissionGate, saveAdmission]);
  const reserveContractSave = (request: PendingContractSave, lease: ContractSaveAdmissionLease): boolean => {
    const owner = lease.view.owner;
    if (!lease.canAdmit() || request.owner !== owner || contractSavesRef.current[owner]) return false;
    const next = { ...contractSavesRef.current, [owner]: request };
    contractSavesRef.current = next;
    setContractSaves(next);
    return true;
  };
  const settleContractSave = (owner: string, expectedToken: string, request?: PendingContractSave): boolean => {
    const current = contractSavesRef.current[owner];
    if (!current || current.token !== expectedToken
      || (request && (request.owner !== owner || request.token !== expectedToken))) return false;
    const next = { ...contractSavesRef.current, [owner]: request };
    contractSavesRef.current = next;
    setContractSaves(next);
    return true;
  };
  useEffect(() => {
    if (!Object.values(contractSaves).some(Boolean)) return;
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [contractSaves]);

  const TABS = [
    { id: "tasks" as HrTab, label: "المهام", icon: "✓", visible: true },
    { id: "staff" as HrTab, label: "الطاقم", icon: "👥", visible: admin },
    { id: "contracts" as HrTab, label: "العقود", icon: "📄", visible: admin },
    { id: "attendance" as HrTab, label: "الدوام والحضور", icon: "⏱️", visible: admin || session?.role === "reception" },
    { id: "leaves" as HrTab, label: "الإجازات", icon: "🌴", visible: true },
    { id: "payroll" as HrTab, label: "المسير والصرف", icon: "💰", visible: admin },
    { id: "reports" as HrTab, label: "التقارير", icon: "📊", visible: admin },
    { id: "settings" as HrTab, label: "الإعدادات", icon: "⚙", visible: admin },
  ];

  return (
    <HrNavigationContext.Provider value={{ staffId, profileTab, contractId, href,
      selectStaff: id => router.push(href({ staffId: id || null, contractId: null }), { scroll: false }),
      selectContract: id => router.push(href({ contractId: id || null }), { scroll: false }),
      closeProfile: () => router.push(href({ staffId: null, contractId: null }), { scroll: false }) }}>
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
          aria-busy={!hydrated}
          className="flex gap-1.5 overflow-x-auto no-scrollbar scroll-smooth"
        >
          {TABS.filter((t) => t.visible).map((t) => {
            const isActive = tab === t.id;
            const className = `flex shrink-0 items-center gap-2 rounded-xl px-4 py-2.5 text-xs font-bold transition-all duration-200 ${
              isActive ? "bg-navy-900 text-white shadow-md shadow-navy-950/20" : "text-navy-600 hover:bg-navy-50 hover:text-navy-900"
            }`;
            const content = <><span>{t.icon}</span><span>{t.label}</span></>;
            // An aria-disabled anchor still navigates before React attaches.
            // Native disabled buttons make the initial server affordance honest.
            return hydrated ? (
              <Link
                key={t.id}
                role="tab"
                aria-selected={isActive}
                href={href({ tab: t.id })}
                prefetch={false}
                scroll={false}
                className={className}
              >
                {content}
              </Link>
            ) : (
              <button key={t.id} type="button" role="tab" aria-selected={isActive} disabled className={className}>
                {content}
              </button>
            );
          })}
        </div>
      </div>

      {/* Main Tab Panels with smooth mounting */}
      <main className="min-h-[500px]">
        <HrHistoryDraftProvider view={tab}>
        {tab === "tasks" && <HrTasksPanel session={session} />}
        {tab === "staff" && admin && <HrStaffPanel key={`${owner}:${staffId}`} />}
        {tab === "contracts" && admin && <HrContractsPanel key={`${owner}:${staffId}:${contractId}`} session={session} pendingSave={contractSaves[owner]} saveAdmission={saveAdmission} mountSaveAdmission={saveAdmissionGate.mount} onReserveSave={reserveContractSave} onSettleSave={settleContractSave} />}
        {tab === "attendance" && <HrAttendancePanel key={`${owner}:${staffId}`} isAdmin={admin} />}
        {tab === "leaves" && <HrLeavesPanel key={`${owner}:${staffId}`} isAdmin={admin} />}
        {tab === "payroll" && admin && <div key={owner} className="space-y-4"><HrPayrollHistoryPanel /><HrPayrollPanel /></div>}
        {tab === "reports" && admin && <HrReportsPanel key={owner} />}
        {tab === "settings" && admin && <HrSettingsPanel key={owner} />}
        </HrHistoryDraftProvider>
      </main>
    </div>
    </HrNavigationContext.Provider>
  );
}
