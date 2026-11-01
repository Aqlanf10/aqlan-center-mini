import { beforeEach, describe, expect, it, vi } from "vitest";
import { prescriptionPrescriberOptions } from "../lib/prescription-prescriber";
import { prescriberUnavailableMessage } from "../lib/prescription-prescriber-feedback";
const mock = vi.hoisted(() => ({ user: vi.fn(), party: vi.fn(), parties: vi.fn(), owner: vi.fn(), session: vi.fn(), access: vi.fn(), patient: vi.fn(), visit: vi.fn(), save: vi.fn(), query: vi.fn(), ensure: vi.fn(), revalidate: vi.fn(), stored: vi.fn() }));
vi.mock("../lib/db", () => ({ findUserByUsername: mock.user, getParty: mock.party, listParties: mock.parties, getPatient: mock.patient, getClinicalVisit: mock.visit, savePrescription: mock.save, ensureSchema: mock.ensure, getPrescription: mock.stored, getPool: () => ({ connect: async () => ({ query: mock.query, release: () => {} }) }) }));
vi.mock("../lib/prescription-owner", () => ({ getPrescriptionOwnerAuthority: mock.owner }));
vi.mock("../lib/session", () => ({ requireSession: mock.session, revalidateSessionInTransaction: mock.revalidate }));
vi.mock("../lib/patient-access", () => ({ canAccessPatient: mock.access }));
import { POST } from "../app/api/prescriptions/route";
const session = { userId: 7, username: "synthetic", role: "admin", expiresAt: Date.now() + 3600000 };
const user = { id: 7, username: "synthetic", role: "admin", isActive: true, partyId: 19 };
const party = { id: 19, name: "Synthetic clinician", kind: "doctor", isActive: true };
// Execute the real issuance transaction over a strict synthetic query adapter.
// This proves route/receipt composition, not SQL locking or durable commit behavior.
let receipt: Record<string, unknown> | null;
beforeEach(() => { vi.resetAllMocks(); receipt = null;
  mock.revalidate.mockResolvedValue(session);
  mock.stored.mockResolvedValue({ id: 701, patientId: 42, createdAt: "2026-10-31", status: "active" });
  mock.query.mockImplementation(async (sql: string, values: unknown[] = []) => {
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [] };
    if (sql.startsWith("INSERT INTO prescription_issuance_commands")) {
      receipt ??= { actor_user_id: values[1], actor_username: values[2], patient_id: values[3], visit_id: values[4], payload_sha256: values[5], prescription_id: null };
      return { rows: [] };
    }
    if (sql.startsWith("SELECT * FROM prescription_issuance_commands")) return { rows: receipt ? [receipt] : [] };
    if (sql.startsWith("SELECT id, kind, is_active, name FROM parties")) return { rows: [{ id: 19, kind: "doctor", is_active: true, name: "Synthetic clinician" }] };
    if (sql.startsWith("SELECT medical_alert FROM patients")) return { rows: [{ medical_alert: null }] };
    if (sql.startsWith("UPDATE prescription_issuance_commands")) { if (!receipt) throw new Error("Missing reserved command"); receipt.prescription_id = values[1]; return { rows: [] }; }
    throw new Error(`Unexpected synthetic issuance query: ${sql}`);
  }); mock.user.mockResolvedValue(user); mock.party.mockResolvedValue(party); mock.owner.mockResolvedValue(null); mock.session.mockResolvedValue(session); mock.access.mockResolvedValue(true); mock.patient.mockResolvedValue({ id: 42, medicalAlert: null }); mock.save.mockResolvedValue({ id: 701, createdAt: "2026-10-31" }); });
describe("non-sensitive prescriber availability feedback", () => {
  it.each([null, { ...user, isActive: false }, { ...user, id: 8 }, { ...user, role: "doctor" }])("rejects missing/inactive/stale session %j", async fresh => {
    mock.user.mockResolvedValue(fresh);
    expect(await prescriptionPrescriberOptions(session)).toEqual({ issuerId: null, canChooseAnyDoctor: false, doctors: [], unavailableReason: "session_unavailable" });
    expect(mock.party).not.toHaveBeenCalled(); expect(mock.owner).not.toHaveBeenCalled();
  });
  it("distinguishes ineligible role from missing link without granting authority", async () => {
    mock.user.mockResolvedValue({ ...user, role: "reception" });
    expect(await prescriptionPrescriberOptions({ ...session, role: "reception" })).toMatchObject({ unavailableReason: "role_ineligible", issuerId: null, canChooseAnyDoctor: false, doctors: [] });
    mock.user.mockResolvedValue({ ...user, partyId: null });
    expect(await prescriptionPrescriberOptions(session)).toEqual({ unavailableReason: "doctor_link_missing", issuerId: null, canChooseAnyDoctor: false, doctors: [] });
    expect(mock.owner).not.toHaveBeenCalled();
  });
  it.each([
    [null, "doctor_identity_invalid"], [{ ...party, kind: "lab" }, "doctor_identity_invalid"],
    [{ ...party, id: 20 }, "doctor_identity_invalid"], [{ ...party, isActive: false }, "doctor_identity_inactive"],
    [{ ...party, name: " " }, "doctor_name_missing"],
  ])("fails closed for unusable linked party %j", async (linked, reason) => {
    mock.party.mockResolvedValue(linked);
    expect(await prescriptionPrescriberOptions(session)).toEqual({ unavailableReason: reason, issuerId: null, canChooseAnyDoctor: false, doctors: [] });
    expect(mock.owner).not.toHaveBeenCalled(); expect(mock.parties).not.toHaveBeenCalled();
  });
  it("retains own-doctor issuance without granting an ordinary admin on-behalf rights", async () => {
    expect(await prescriptionPrescriberOptions(session)).toEqual({ issuerId: 19, canChooseAnyDoctor: false, doctors: [{ id: 19, name: party.name }] });
    expect(mock.owner).toHaveBeenCalledWith(user); expect(mock.parties).not.toHaveBeenCalled();
  });
  it("does not convert transport failure into a guessed identity reason", async () => {
    mock.user.mockRejectedValue(new Error("synthetic transport"));
    await expect(prescriptionPrescriberOptions(session)).rejects.toThrow("synthetic transport");
    for (const unknown of [null, {}, "__proto__", "constructor", "unknown"]) expect(prescriberUnavailableMessage(unknown)).toBeNull();
  });
});

const ownPrescriptionRequest = () => new Request("http://test.invalid/api/prescriptions", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
    commandKey: "11111111-1111-4111-8111-111111111111", patientId: 42, prescribingDoctorPartyId: 19, prescribingDoctorName: "UNTRUSTED DISPLAY",
    items: [{ name: "SYNTHETIC NOT FOR USE", dose: "fixture strength", form: "fixture form", frequency: "fixture interval", duration: "fixture duration",
      selection: { id: "manual", amount: "fixture amount", confirmed: true } }],
  }),
});
describe("fresh explicit-link state and unchanged issuance route", () => {
  it("blocks missing link then uses fresh own-doctor identity for the persisted snapshot", async () => {
    mock.user.mockResolvedValue({ ...user, partyId: null });
    expect((await prescriptionPrescriberOptions(session)).issuerId).toBeNull();
    expect((await POST(ownPrescriptionRequest())).status).toBe(403); expect(mock.save).not.toHaveBeenCalled();
    // Simulate the separately authorized settings save; this test never binds an account.
    mock.user.mockResolvedValue(user);
    expect(await prescriptionPrescriberOptions(session)).toEqual({ issuerId: 19, canChooseAnyDoctor: false, doctors: [{ id: 19, name: party.name }] });
    expect((await POST(ownPrescriptionRequest())).status).toBe(201);
    expect(mock.save).toHaveBeenCalledWith(expect.objectContaining({ patientId: 42, prescribingDoctorPartyId: 19, prescribingDoctorName: "Synthetic clinician" }), "synthetic", 19, expect.objectContaining({ query: mock.query }));
    expect(mock.owner).toHaveBeenCalledTimes(1); // options only; own issuance needs no delegation
    const replay = await POST(ownPrescriptionRequest());
    expect(replay.status).toBe(201); expect(await replay.json()).toMatchObject({ id: 701, replayed: true });
    expect(mock.save).toHaveBeenCalledTimes(1);
    const reservations = mock.query.mock.calls.filter(([sql]) => sql.startsWith("INSERT INTO prescription_issuance_commands"));
    expect(reservations).toHaveLength(2);
    expect(reservations[0][1]).toEqual(reservations[1][1]); // same key, actor, patient, visit and content hash
    mock.user.mockResolvedValue({ ...user, partyId: null });
    expect((await POST(ownPrescriptionRequest())).status).toBe(403);
    expect(mock.save).toHaveBeenCalledTimes(1);
  });
  it("keeps reception unable to issue even with a linked doctor record", async () => {
    mock.user.mockResolvedValue({ ...user, role: "reception" }); mock.session.mockResolvedValue({ ...session, role: "reception" });
    expect(await prescriptionPrescriberOptions({ ...session, role: "reception" })).toMatchObject({ unavailableReason: "role_ineligible" });
    expect((await POST(ownPrescriptionRequest())).status).toBe(403); expect(mock.save).not.toHaveBeenCalled();
  });
});
