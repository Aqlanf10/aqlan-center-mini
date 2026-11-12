import "server-only";
import { CLINIC_TIME_ZONE, getSettingsWith, listPendingProposalSummariesWith } from "./db";
import { runCanonicalReadSnapshot } from "./canonical-read-snapshot";
import { CanonicalPatientReadRefusal, patientDirectoryProjection } from "./canonical-patient-reads";
import { followUpDaysFrom, proposalTiming, sortProposals } from "./consultation-followup";
import { clinicDateString } from "./schedule";
import { isCurrency } from "./money";
import { proposalContactVersion } from "./canonical-proposal-version";
import type { VerifiedDurableSession } from "./staff-durable-session";
import type { CanonicalProposal, CanonicalProposalFeed } from "./canonical-proposal-projection";
export function canonicalProposalQuery(params: URLSearchParams) {
  if ([...params.keys()].length) throw new CanonicalPatientReadRefusal("invalid_patient_query", "مرشحات عروض العلاج غير مدعومة.");
}
export function readCanonicalProposals(session: VerifiedDurableSession) {
  return runCanonicalReadSnapshot(session, "read:plans.proposals", async (q, scope): Promise<CanonicalProposalFeed> => {
    const canSeeMoney = patientDirectoryProjection(scope).balances;
    const settings = await getSettingsWith(q), followUpDays = followUpDaysFrom(settings["followup.proposal_days"]);
    const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
    const source = await listPendingProposalSummariesWith(q, scope.patientScope.kind === "own" ? scope.patientScope.clinicianPartyId : null, canSeeMoney);
    const proposals: CanonicalProposal[] = source.rows.map(row => {
      const out: CanonicalProposal = { planId: row.planId, patientId: row.patientId, patientName: row.patientName, patientPhone: row.patientPhone,
        title: row.title, doctorName: row.doctorName, createdOn: row.createdOn, lastContactOn: row.lastContactOn, items: row.items,
        timing: proposalTiming({ createdOn: row.createdOn, lastContactOn: row.lastContactOn, today, followUpDays }), contactVersion: proposalContactVersion(row) };
      if (canSeeMoney) {
        const totalMinor = Number(row.totalMinor);
        if (row.totalMinor === null || !Number.isSafeInteger(totalMinor) || !isCurrency(row.currency)) throw new Error("STAFF_READ_READ_FAILED");
        out.money = { totalMinor, currency: row.currency };
      }
      return out;
    });
    return { projection: "pending-plan-proposals", proposals: sortProposals(proposals), today, followUpDays, hasMore: source.hasMore, limit: 300, canSeeMoney };
  }, { errorPrefix: "STAFF_READ", maxBytes: 1024 * 1024 });
}
