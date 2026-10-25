"use client";
import { useCallback, useState } from "react";
import dynamic from "next/dynamic";
import { PageHeader } from "@/components/PageHeader";
import { useSession } from "@/components/SessionProvider";
import { isAdmin } from "@/lib/roles";
import { canDoctorViewClinicProfits } from "@/lib/doctor-permissions";
import { LeadershipOverview, type LeadershipSection } from "@/components/leadership/LeadershipOverview";
import { LeadershipOperationalOverview } from "@/components/leadership/LeadershipOperationalOverview";
import { LabBacklogOverview } from "@/components/leadership/LabBacklogOverview";
import { LeadershipReadAccessContext } from "@/components/leadership/useLeadershipRead";
import styles from "@/components/leadership/leadership.module.css";
const FinancialOverview = dynamic(() => import("@/components/leadership/ExecutiveFinancialOverview"), { loading: () => <p role="status">جارٍ فتح الملخص المالي…</p> });
const Team = dynamic(() => import("@/components/leadership/LeadershipTeam").then(module => module.LeadershipTeam), { loading: () => <p role="status">جارٍ فتح متابعة الفريق…</p> });
const sections: {id:LeadershipSection;label:string}[] = [
 {id:"overview",label:"نظرة شاملة"},{id:"reviews",label:"مراجعات اليوم"},{id:"lab",label:"متابعة المعمل"},{id:"team",label:"الفريق والمهام"},{id:"finance",label:"المالية"},
];
/** Principal change unmounts every sensitive read, including legacy finance. No shared cross-request cache. */
export default function ExecutivePage() {
 const session=useSession();
 if (!session) return <main className="p-4"><p role="alert">سجّل الدخول لفتح القيادة.</p></main>;
 if (!isAdmin(session.role)) return session.role === "doctor" && canDoctorViewClinicProfits(session.permissions,session.role)
  ? <main className={styles.workspace}><FinancialOverview standalone key={`${session.username}:${session.role}`} /></main>
  : <main className="p-4"><p role="alert">غرفة القيادة للإدارة فقط.</p><a href="/">العودة إلى اليوم</a></main>;
 return <ExecutiveWorkspace key={`${session.username}:${session.role}`} />;
}
export function ExecutiveWorkspace() {
 const [accessDenied, setAccessDenied] = useState(false);
 const onForbidden = useCallback(() => setAccessDenied(true), []);
 const [section,setSection]=useState<LeadershipSection>("overview");
 const choose=(next:LeadershipSection)=>{setSection(next);};
 if (accessDenied) return <main className={styles.workspace}><p role="alert">انتهت الجلسة أو تغيّرت الصلاحية. أُخفيت بيانات القيادة. أعد تحميل الصفحة للتحقق.</p><a className={styles.headerLink} href="/executive">إعادة التحقق من الجلسة</a></main>;
 return <LeadershipReadAccessContext.Provider value={onForbidden}><main className={styles.workspace} data-testid="leadership-workspace">
  <PageHeader title="وحدة القيادة" subtitle="تشغيل العيادة والمتابعات والمالية، لكل مصدر نطاق واضح وسجل يمكن الرجوع إليه."><a className={styles.headerLink} href="/reports/daily-clinic">كشف إقفال اليوم</a></PageHeader>
  <nav className={styles.sectionNav} aria-label="أقسام وحدة القيادة">{sections.map(item=><button key={item.id} type="button" aria-pressed={section===item.id} onClick={()=>choose(item.id)}>{item.label}</button>)}</nav>
  {section === "overview" && <LeadershipOverview onSection={choose} />}
  {section === "reviews" && <LeadershipOperationalOverview />}
  {section === "lab" && <LabBacklogOverview />}
  {section === "team" && <Team />}
  {section === "finance" && <FinancialOverview />}
 </main></LeadershipReadAccessContext.Provider>;
}
