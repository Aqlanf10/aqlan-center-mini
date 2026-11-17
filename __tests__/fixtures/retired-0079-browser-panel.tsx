import { createRoot } from "react-dom/client";
import { SessionProvider } from "../../components/SessionProvider";
import { OrthoFollowupCoveragePanel } from "../../components/OrthoFollowupCoveragePanel";
import { makeCanonicalCoverageDraft } from "../../lib/canonical-ortho-coverage-draft";
import { readFinancialJournal, reserveFinancialCommand } from "../../lib/financial-command-journal";
import { followupCoverageJournal, type FollowupCoverageAttempt } from "../../lib/ortho-followup-coverage-recovery";

declare global { interface Window { __retired0079Attempt: FollowupCoverageAttempt; __retired0079: { saved: number; acknowledgments: number; journal: () => ReturnType<typeof readFinancialJournal> } } }
const attempt=window.__retired0079Attempt, scope={actor:attempt.actor,patientId:attempt.patientId};
const state=window.__retired0079={saved:0,acknowledgments:0,journal:()=>readFinancialJournal(scope)};
window.addEventListener("synthetic-coverage-acknowledgment",()=>{state.acknowledgments++;});
const draft=makeCanonicalCoverageDraft({authorized:()=>true,deny:()=>undefined});
void reserveFinancialCommand(scope,0,followupCoverageJournal(attempt)).then(()=>{
 createRoot(document.getElementById("root")!).render(<SessionProvider value={{username:attempt.actor,role:"doctor",canonical:true,patientScope:"own",capabilities:["finance.agreements.manage","finance.invoices.view","clinical.plans.view","clinical.ortho.view"]}}>
  <OrthoFollowupCoveragePanel canonical patientId={attempt.patientId} orthoCaseId={attempt.orthoCaseId} draftOwner={draft} onSaved={()=>{state.saved++;}} />
 </SessionProvider>);
});
