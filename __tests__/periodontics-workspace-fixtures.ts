import type { PerioExamView } from "../lib/periodontics-db";
export function examFixture(patch: Partial<PerioExamView> = {}): PerioExamView {
  return { id: 101, patientId: 1, visitId: 11, doctorId: 7, doctorName: "Actual doctor", caseId: null, caseTitle: null,
    revision: 3, recordedAt: "2026-10-03T08:00:00Z", recordedBy: "recorder", updatedAt: null, updatedBy: null,
    signedAt: null, signedBy: null, sites: [{ toothCode: 11, site: "MB", probingDepthMm: 0, bleedingOnProbing: false },
      { toothCode: 48, site: "DL", probingDepthMm: 2.25, bleedingOnProbing: null }], addenda: [],
    summary: { recordedDepthSites: 2, recordedBleedingSites: 1, bleedingSites: 0, bleedingPercent: 0 }, ...patch };
}
