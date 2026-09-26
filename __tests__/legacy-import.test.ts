import { readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { readFirstSheet } from "../lib/xlsx-reader";
import { legacyMatcher, parseLegacySessions, parseLegacyTreatments, planLegacyImport, type LegacyPatientRef } from "../lib/legacy-import";

/** (P1-5c) Old-system treatments and sessions — synthetic fixtures only. */

const read = async (name: string) => readFirstSheet(
  new Uint8Array(readFileSync(`__tests__/fixtures/${name}`)), async (bytes) => new Uint8Array(inflateRawSync(bytes)));

const patients: LegacyPatientRef[] = [
  { id: 1, patientNumber: "P-00001", fullName: "سالم تجربة احمد", phone: "967771000001", altPhone: null },
  { id: 2, patientNumber: "P-00002", fullName: "منى تجربة سعيد", phone: null, altPhone: "967733000002" },
];

describe("parseLegacyTreatments", () => {
  it("reads each treatment in its own currency, keeping the old rate for display only", async () => {
    const { records, problems } = parseLegacyTreatments(await read("old-treatments.xlsx"));
    expect(problems).toEqual([]);
    expect(records[0]).toMatchObject({
      legacyNumber: 1, treatedOn: "2026-01-17", patientName: "سالم تجربة احمد", doctorName: "دكتور تجربة",
      service: "تقويم اسنان", currency: "SAR", priceMinor: 200000, rate: 425, paidMinor: 50000, remainingMinor: 150000,
      phone: "771000001",
    });
    expect(records[2]).toMatchObject({ currency: "USD", remainingMinor: 10000 });
    expect(records[4]).toMatchObject({ currency: "SAR", remainingMinor: 17122 });
  });

  it("refuses a file that is not the treatments export", () => {
    expect(parseLegacyTreatments([["الاسم", "الهاتف"], ["x", "1"]]).problems[0].reason).toContain("ليس ملف معالجات");
  });
});

describe("parseLegacySessions", () => {
  it("reads the payment, its currency (first «العملة» column) and its parent treatment", async () => {
    const { records, problems } = parseLegacySessions(await read("old-sessions.xlsx"));
    expect(problems).toEqual([]);
    expect(records[0]).toMatchObject({
      legacyNumber: 1, paidOn: "2026-01-17", treatmentNumber: 1, currency: "SAR", amountMinor: 50000, rate: 425,
      method: "نقدا", cashBox: "1220109-صندوق تجربة",
    });
  });
});

describe("planLegacyImport", () => {
  it("links rows to patients, sums remaining per patient and currency without converting, and lists the unmatched", async () => {
    const treatments = parseLegacyTreatments(await read("old-treatments.xlsx")).records;
    const sessions = parseLegacySessions(await read("old-sessions.xlsx")).records;
    const plan = planLegacyImport(treatments, sessions, patients);
    expect(plan.summary).toMatchObject({ treatments: 5, treatmentsMatched: 4, treatmentsUnmatched: 1, sessions: 2, sessionsMatched: 2 });
    expect(plan.balances).toEqual(expect.arrayContaining([
      { patientId: 1, currency: "SAR", amountMinor: 150000 + 17122, treatmentNumbers: [1, 5] },
      { patientId: 1, currency: "USD", amountMinor: 10000, treatmentNumbers: [3] },
      { patientId: 2, currency: "YER", amountMinor: 1250, treatmentNumbers: [2] },
    ]));
    expect(plan.summary.balancesByCurrency).toEqual({ SAR: 167122, USD: 10000, YER: 1250 });
  });

  it("uses the phone to tell apart two patients with the same name, and never guesses", () => {
    const twins: LegacyPatientRef[] = [
      { id: 7, patientNumber: "P-7", fullName: "محمد علي", phone: "967771111111", altPhone: null },
      { id: 8, patientNumber: "P-8", fullName: "محمد علي", phone: "967772222222", altPhone: null },
    ];
    const match = legacyMatcher(twins);
    expect(match("محمد علي", "772222222")).toMatchObject({ kind: "matched", patient: { id: 8 } });
    expect(match("محمد علي", null).kind).toBe("ambiguous");
    expect(match("محمد علي سالم", "771111111").kind).toBe("unmatched");
  });

  it("an owner's assignment never re-attributes a treatment the matcher already linked (stale choice from another file)", async () => {
    const { applyLegacyAssignments } = await import("../lib/db");
    const treatments = parseLegacyTreatments(await read("old-treatments.xlsx")).records;
    const sessions = parseLegacySessions(await read("old-sessions.xlsx")).records;
    const plan = planLegacyImport(treatments, sessions, patients);
    const matched = plan.treatments.find((row) => row.match.kind === "matched")!;
    const originalOwner = matched.match.kind === "matched" ? matched.match.patient.id : -1;
    const intruder = patients.find((patient) => patient.id !== originalOwner)!;
    const applied = applyLegacyAssignments(plan, { [matched.record.legacyNumber]: intruder.id }, patients);
    const after = applied.treatments.find((row) => row.record.legacyNumber === matched.record.legacyNumber)!;
    expect(after.match).toMatchObject({ kind: "matched", patient: { id: originalOwner } });
  });
});
