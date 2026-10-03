"use client";

import { Activity, ClipboardList, Layers3, Stethoscope, ScanLine, FolderOpen, FlaskConical, Pill, Send, History, Wallet, Package, UserRound, Printer, LayoutDashboard, CircleDot } from "lucide-react";
import { WORKSPACE_GROUPS, WORKSPACE_SECTIONS, type WorkspaceSection } from "@/lib/patient-workspace-navigation";
import type { WorkspaceSummary } from "./usePatientWorkspace";
import { workflowDocuments, WORKFLOW_DOCUMENT_COUNT_UNAVAILABLE } from "@/lib/patient-workflow-documents";
import styles from "./workspace.module.css";

const ICONS = { summary: LayoutDashboard, today: Activity, plans: ClipboardList, specialties: Layers3, cases: Stethoscope,
  chart: CircleDot, endo: Activity, perio: Stethoscope, ortho: ScanLine, files: FolderOpen, lab: FlaskConical, prescriptions: Pill,
  referrals: Send, timeline: History, account: Wallet, materials: Package, identity: UserRound, reports: Printer };

export function WorkspaceNavigation({ current, sections, summary, onNavigate }: {
  current: WorkspaceSection; sections: readonly WorkspaceSection[]; summary: WorkspaceSummary | null;
  onNavigate: (target: string) => void;
}) {
  const documents = workflowDocuments(summary ?? {});
  const badge = (id: WorkspaceSection) => {
    if (!summary) return null;
    if (id === "today" && summary.openVisit) return "●";
    if (id === "plans" && summary.planVisible === true && summary.activePlans.length) return summary.activePlans.length;
    if (id === "lab" && summary.counts.openLabOrders) return summary.counts.openLabOrders;
    if (id === "files") return documents.documents;
    return null;
  };
  return <>
    <nav className={styles.sidebar} aria-label="أقسام ملف المريض">
      {WORKSPACE_GROUPS.map((group) => {
        const visible = WORKSPACE_SECTIONS.filter((section) => section.group === group.id && sections.includes(section.id));
        if (!visible.length) return null;
        return <div className={styles.navGroup} key={group.id}>
          <p className={styles.navGroupLabel}>{group.label}</p>
          {visible.map((section) => {
            const Icon = ICONS[section.id]; const count = badge(section.id);
            return <button type="button" key={section.id} onClick={() => onNavigate(section.id)}
              className={styles.navButton} aria-current={current === section.id ? "page" : undefined}
              title={section.id === "files" && documents.documents === null ? WORKFLOW_DOCUMENT_COUNT_UNAVAILABLE : undefined}
              data-testid={`workspace-nav-${section.id}`}>
              <Icon size={16} className={styles.navIcon} aria-hidden="true" /><span>{section.label}</span>
              {count !== null ? <span className={styles.badge}
                aria-label={section.id === "files" ? `عدد المستندات غير المحذوفة: ${count}` : undefined}>{count}</span> : null}
            </button>;
          })}
        </div>;
      })}
    </nav>
    <div className={styles.mobileNav}>
      <label htmlFor="patient-workspace-section">انتقل إلى قسم</label>
      <select id="patient-workspace-section" value={current} onChange={(event) => onNavigate(event.target.value)} data-testid="workspace-mobile-navigation">
        {!sections.includes(current) ? <option value={current} disabled>القسم المطلوب غير متاح</option> : null}
        {WORKSPACE_GROUPS.map((group) => <optgroup key={group.id} label={group.label}>
          {WORKSPACE_SECTIONS.filter((section) => section.group === group.id && sections.includes(section.id))
            .map((section) => <option key={section.id} value={section.id}>{section.label}</option>)}
        </optgroup>)}
      </select>
    </div>
  </>;
}
