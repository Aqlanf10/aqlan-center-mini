import { describe, expect, it, vi } from "vitest";
const readers = vi.hoisted(() => ({ searchPatients: vi.fn(), readOperationalPatient: vi.fn() }));
vi.mock("../lib/db", () => ({ searchPatients: readers.searchPatients }));
vi.mock("../lib/patient-operational-read", () => ({ readOperationalPatient: readers.readOperationalPatient }));
import { receptionPatientLookup } from "../lib/ai-tools/reception-patient";
describe("reception assistant patient projection", () => {
  it("returns only operational fields from a broad reader", async () => {
    const row = { id: 23, fullName: "Synthetic", patientNumber: "SYN-23", phone: null };
    readers.searchPatients.mockResolvedValue([{ ...row, medicalAlert: "synthetic clinical note", amountMinor: 3700 }]);
    const result = await receptionPatientLookup("Synthetic");
    expect(result.matches).toEqual([row]);
    expect(result.text).not.toMatch(/3700|clinical note/);
  });
  it("reads an explicit six-digit patient id within the same operational scope", async () => {
    const row = { id: 100023, fullName: "Synthetic", patientNumber: "SYN-42", phone: null };
    readers.readOperationalPatient.mockResolvedValue(row);
    expect((await receptionPatientLookup(row.id)).matches).toEqual([row]);
    expect(readers.readOperationalPatient).toHaveBeenCalledWith(row.id, "reception");
  });
  it("does not substitute another patient for a missing explicit file", async () => {
    readers.readOperationalPatient.mockResolvedValue(null);
    readers.searchPatients.mockClear();
    expect((await receptionPatientLookup(23)).matches).toEqual([]);
    expect(readers.readOperationalPatient).toHaveBeenCalledWith(23, "reception");
    expect(readers.searchPatients).not.toHaveBeenCalled();
  });
});
