import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { PRESCRIBING_DOCTOR_SNAPSHOT_SQL, PRESCRIBING_DOCTOR_IDENTITY_SQL } from "@/lib/prescribing-doctor-schema";
import { canonicalPrescriptionForAck } from "@/lib/prescription-safety-ack";
vi.stubEnv("USE_LOCAL_DB", "true");
vi.stubEnv("NODE_ENV", "test");
vi.stubEnv("RAILWAY_PROJECT_ID", "");
const db = await import("../lib/db");
beforeAll(async () => { await db.ensureSchema(); }, 60000);
afterAll(async () => { await db.resetPoolForTesting(); });

describe("prescribing clinician snapshot persistence", () => {
  it("migration and runtime DDL match", () => {
    expect(readFileSync(new URL("../migrations/0091_prescribing_doctor_identity.sql", import.meta.url), "utf8")).toBe(PRESCRIBING_DOCTOR_IDENTITY_SQL);
    expect(readFileSync(new URL("../migrations/0092_prescribing_doctor_snapshot.sql", import.meta.url), "utf8")).toBe(PRESCRIBING_DOCTOR_SNAPSHOT_SQL);
  });
  it("saves immutable clinician name independently from actor and registry updates", async () => {
    const pool = db.getPool();
    const { rows: [patient] } = await pool.query<{ id: number }>("INSERT INTO patients (patient_number, full_name) VALUES ('RX-SNAPSHOT-SYN', 'Synthetic') RETURNING id");
    const { rows: [party] } = await pool.query<{ id: number }>("INSERT INTO parties (name, kind) VALUES ('Dr Snapshot', 'doctor') RETURNING id");
    const draft = { patientId: patient.id, visitId: null, prescribingDoctorName: "Dr Snapshot", prescribingDoctorPartyId: 99, diagnosis: "", notes: "", instructionsLang: "both" as const, items: [{ name: "SYNTHETIC NOT FOR USE", dose: "", form: "", frequency: "", duration: "", instructions: "", instructionsEn: "" }] };
    const record = await db.savePrescription(draft, "admin-entry-actor", party.id);
    await pool.query("UPDATE parties SET name='Changed registry' WHERE id=$1", [party.id]);
    const reopened = await db.getPrescription(record.id);
    expect(reopened).toMatchObject({ prescribingDoctorName: "Dr Snapshot", prescribingDoctorPartyId: 99, createdBy: "admin-entry-actor", doctorPartyId: party.id });
    expect((await db.listPatientPrescriptions(patient.id))[0]).toMatchObject({ prescribingDoctorName: "Dr Snapshot" });
    expect(canonicalPrescriptionForAck(draft)).not.toBe(canonicalPrescriptionForAck({ ...draft, prescribingDoctorName: "Another name" }));
  });
  it("reads new stored print settings without cache or blank fallbacks", async () => {
    const pool = db.getPool();
    await pool.query("INSERT INTO settings (key,value) VALUES ('clinic.name','Synthetic initial'),('clinic.phone','123'),('clinic.address','') ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value");
    await db.getSettings(); // Populate ordinary process cache deliberately.
    await pool.query("UPDATE settings SET value=CASE WHEN key='clinic.name' THEN 'Synthetic latest' ELSE '' END WHERE key IN ('clinic.name','clinic.phone')");
    const settings = await db.getPrescriptionPrintSettings();
    expect(settings["clinic.name"]).toBe("Synthetic latest");
    expect(settings["clinic.phone"]).toBe(""); expect(settings["clinic.address"]).toBe("");
  });
});
