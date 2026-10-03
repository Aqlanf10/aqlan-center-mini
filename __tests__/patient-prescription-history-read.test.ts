import { readFileSync } from "node:fs";
import { types } from "pg";
import { describe, expect, it } from "vitest";
import { readPatientPrescriptionHistory, savedPrescriptionPrintHref, savedPrescriptionIssuedAt, type SavedPrescription } from "../lib/patient-prescription-history";

const item = { name: "Synthetic medication", dose: "stored dose", form: "stored form", frequency: "stored frequency", duration: "stored duration", instructions: "تعليمات محفوظة", instructionsEn: "Stored instructions" };
const row: SavedPrescription = { id: 311, patientId: 91, visitId: null, diagnosis: "Synthetic diagnosis", notes: "Original notes", instructionsLang: "both", items: [item], status: "active", voidReason: null, voidedBy: null, voidedAt: null, createdBy: "original-issuer", doctorPartyId: 7, createdAt: "2026-10-01T10:20:30.000Z" };
const parse = (rows: unknown = [row]) => readPatientPrescriptionHistory({ prescriptions: rows }, 91);

describe("saved prescription history strict read projection", () => {
  it("tracks actual SERIAL/INTEGER producer identity rather than assumed BIGSERIAL mocks", () => {
    const schema = readFileSync(new URL("../migrations/0001_baseline_schema.sql", import.meta.url), "utf8");
    const table = schema.match(/CREATE TABLE IF NOT EXISTS prescriptions \(([\s\S]*?)\n\s*\);/)?.[1];
    expect(table).toMatch(/id\s+SERIAL PRIMARY KEY/);
    for (const field of ["patient_id", "visit_id", "doctor_party_id"]) expect(table).toMatch(new RegExp(`${field}\\s+INTEGER`));
    const parseInt4 = types.getTypeParser(23, "text");
    expect(parseInt4("311")).toBe(311); expect(parse([{ ...row, id: parseInt4("311"), patientId: parseInt4("91") }])).toEqual([row]);
    const source = readFileSync(new URL("../lib/db.ts", import.meta.url), "utf8");
    const producer = source.match(/const toPrescription = \(row: PrescriptionRow\): PrescriptionRecord => \(\{([\s\S]*?)\n\}\);/)?.[1];
    expect(producer).toContain("id: row.id"); expect(producer).toContain("patientId: row.patient_id");
    expect(producer).toContain("items: sanitizeRxItems(row.items)"); expect(producer).toContain("createdAt: row.created_at.toISOString()");
  });
  it("preserves original stored fields, null visit and order, without suggestions", () => {
    const voided: SavedPrescription = { ...row, id: 312, status: "void", visitId: 201, doctorPartyId: null, voidReason: "Stored correction reason", voidedBy: "original-void-actor", voidedAt: "2026-10-02T11:00:00.000Z" };
    const payload = { prescriptions: [voided, row], get suggestions(): never { throw new Error("Suggestions must not be inspected"); } };
    expect(readPatientPrescriptionHistory(payload, 91)).toEqual([voided, row]);
    expect(parse()[0]).not.toBe(row); expect(parse()[0].items[0]).not.toBe(item);
  });
  it("accepts an explicit empty list and exactly 50 latest rows", () => {
    expect(parse([])).toEqual([]);
    expect(parse(Array.from({ length: 50 }, (_, index) => ({ ...row, id: index + 1 })))).toHaveLength(50);
  });
  it("preserves legacy TEXT and an explicit empty canonical items projection without reapplying writer policy", () => {
    const original = { ...row, items: [], createdBy: "", diagnosis: "x".repeat(3000), notes: "x".repeat(3000), voidReason: "x".repeat(3000) };
    expect(parse([original])).toEqual([original]);
  });
  it.each([null, {}, [], { prescriptions: null }, { prescriptions: "none" }, { suggestions: [] }])("rejects incomplete top-level success %j", (payload) => {
    expect(() => readPatientPrescriptionHistory(payload, 91)).toThrow();
  });
  it.each([
    { id: 0 }, { id: "311" }, { id: 1.5 }, { id: 2147483648 }, { patientId: 92 }, { patientId: "91" },
    { visitId: 0 }, { visitId: "201" }, { visitId: undefined }, { doctorPartyId: undefined },
    { status: "signed" }, { status: null }, { diagnosis: 7 }, { notes: [] }, { instructionsLang: "unknown" },
    { createdBy: null }, { createdBy: {} }, { createdAt: "yesterday" }, { createdAt: "2026-02-30T10:20:30.000Z" },
    { createdAt: "2026-10-01" }, { voidedAt: "2026-10-01" }, { voidedBy: {} }, { voidReason: 3 },
    { items: {} }, { items: null }, { items: [null] }, { items: [{ ...item, name: "" }] },
    { items: [{ ...item, instructionsEn: undefined }] }, { items: [{ ...item, frequency: 3 }] },
    { items: [{ ...item, dose: "x".repeat(201) }] }, { items: Array.from({ length: 21 }, () => item) },
  ])("rejects malformed or foreign saved row %j without partial success", (change) => {
    expect(() => parse([row, { ...row, id: 312, ...change }])).toThrow();
  });
  it("rejects duplicates, oversized windows and invalid requested identity", () => {
    expect(() => parse([row, row])).toThrow();
    expect(() => parse(Array.from({ length: 51 }, (_, index) => ({ ...row, id: index + 1 })))).toThrow();
    for (const id of [0, -1, 1.1, NaN, 2147483648]) expect(() => readPatientPrescriptionHistory({ prescriptions: [] }, id)).toThrow();
  });
  it("builds only the canonical exact patient and stored-original URL", () => {
    expect(savedPrescriptionPrintHref(91, row)).toBe("/print/prescription/91?rx=311");
    expect(savedPrescriptionPrintHref(92, row)).toBeNull();
    expect(savedPrescriptionPrintHref(91, { ...row, id: 0 })).toBeNull();
    expect(savedPrescriptionIssuedAt(row.createdAt)).toBe("2026-10-01 10:20:30 UTC");
  });
});
