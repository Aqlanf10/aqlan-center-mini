import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

/** (PAT-3) البريد والأعلام والصورة وسجل موافقات التواصل — على PostgreSQL 18. */

assertRealPostgresUrl();
stubPostgresEnv();

const {
  getPool, resetPoolForTesting, ensureSchema, updatePatient, getPatient, setPatientPhoto, removeDocument,
  recordContactConsent, listContactConsents, contactConsentStates, mergeDuplicatePatient, patientMessagingConsent,
} = await import("../../lib/db");

const newPatient = async (number: string) => (await getPool().query<{ id: number }>(
  `INSERT INTO patients (patient_number, full_name) VALUES ($1, 'مريض') RETURNING id`, [number])).rows[0].id;

const newDocument = async (patientId: number, mime = "image/jpeg") => (await getPool().query<{ id: number }>(
  `INSERT INTO patient_documents (patient_id, kind, title, mime_type, size_bytes, sha256, storage_key, uploaded_by)
   VALUES ($1, 'photo', 'صورة', $2, 10, repeat('a', 64), 'k/' || gen_random_uuid(), 'reception') RETURNING id`,
  [patientId, mime])).rows[0].id;

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
}, 120_000);
afterAll(async () => { await resetPoolForTesting(); });

describe("(PAT-3) identity fields", () => {
  it("saves email, preferred channel and flags; untouched fields stay as they were", async () => {
    const id = await newPatient("ID-1");
    await updatePatient(id, { email: "a@b.co", preferredChannel: "whatsapp", flags: ["VIP"] });
    const updated = await updatePatient(id, { note: "ملاحظة" });
    expect(updated).toMatchObject({ email: "a@b.co", preferredChannel: "whatsapp", flags: ["VIP"], note: "ملاحظة" });
    expect((await updatePatient(id, { flags: [] }))?.flags).toEqual([]);
    await expect(getPool().query(`UPDATE patients SET preferred_channel = 'fax' WHERE id = $1`, [id])).rejects.toThrow();
  });
});

describe("(PAT-3) patient photo", () => {
  it("accepts only an image document of the same patient that is not hidden", async () => {
    const id = await newPatient("PH-1");
    const other = await newPatient("PH-2");
    const photo = await newDocument(id);
    expect(await setPatientPhoto(id, await newDocument(other))).toEqual({ ok: false, reason: "document_not_found" });
    expect(await setPatientPhoto(id, await newDocument(id, "application/pdf"))).toEqual({ ok: false, reason: "not_image" });
    expect(await setPatientPhoto(999999, photo)).toEqual({ ok: false, reason: "not_found" });
    const set = await setPatientPhoto(id, photo);
    expect(set.ok && set.patient.photoDocumentId).toBe(photo);
  });

  it("hiding the photo document clears the patient photo", async () => {
    const id = await newPatient("PH-3");
    const photo = await newDocument(id);
    await setPatientPhoto(id, photo);
    expect(await removeDocument({ id: photo, actor: "admin", note: "صورة خاطئة" })).toEqual({ ok: true });
    expect((await getPatient(id))?.photoDocumentId).toBeNull();
    expect(await setPatientPhoto(id, photo)).toEqual({ ok: false, reason: "document_not_found" });
  });
});

describe("(PAT-3) contact consents", () => {
  it("keeps a dated log; the latest event per channel is the state", async () => {
    const id = await newPatient("CC-1");
    await recordContactConsent({ patientId: id, channel: "whatsapp", granted: true, source: "in_person", note: null, actor: "reception" });
    await recordContactConsent({ patientId: id, channel: "whatsapp", granted: false, source: "inbound_stop", note: null, actor: "system" });
    await recordContactConsent({ patientId: id, channel: "sms", granted: true, source: "written", note: "إقرار", actor: "reception" });
    const log = await listContactConsents(id);
    expect(log.map((event) => [event.channel, event.granted])).toEqual([["sms", true], ["whatsapp", false], ["whatsapp", true]]);
    expect((await contactConsentStates([id])).get(id)).toEqual({ whatsapp: "withdrawn", sms: "granted", email: "unknown" });
    expect(await patientMessagingConsent(id, "whatsapp")).toEqual({ state: "withdrawn", mode: "opt_out" });
    expect(await recordContactConsent({ patientId: 999999, channel: "sms", granted: true, source: "phone", note: null, actor: "x" })).toBeNull();
  });

  it("is append-only: an event can be neither edited nor deleted, but goes with its patient", async () => {
    const id = await newPatient("CC-2");
    const event = await recordContactConsent({ patientId: id, channel: "email", granted: true, source: "portal", note: null, actor: "x" });
    await expect(getPool().query(`UPDATE patient_contact_consents SET granted = false WHERE id = $1`, [event!.id])).rejects.toThrow();
    await expect(getPool().query(`DELETE FROM patient_contact_consents WHERE id = $1`, [event!.id])).rejects.toThrow();
    await getPool().query(`DELETE FROM patients WHERE id = $1`, [id]);
    expect(await listContactConsents(id)).toEqual([]);
  });
});

describe("(PAT-3) merging a duplicate file", () => {
  it("moves consents and the photo, fills email/channel, and unions flags in order", async () => {
    const keep = await newPatient("MG-K");
    const dup = await newPatient("MG-D");
    await updatePatient(keep, { flags: ["VIP"] });
    await updatePatient(dup, { email: "dup@x.co", preferredChannel: "sms", flags: ["قلق من العلاج", "VIP"] });
    const photo = await newDocument(dup);
    await setPatientPhoto(dup, photo);
    await recordContactConsent({ patientId: dup, channel: "whatsapp", granted: false, source: "phone", note: null, actor: "x" });

    const result = await mergeDuplicatePatient(dup, keep, { actor: "admin", actorRole: "admin", reason: "تكرار" });
    expect(result.ok).toBe(true);
    expect(await getPatient(keep)).toMatchObject({
      email: "dup@x.co", preferredChannel: "sms", photoDocumentId: photo, flags: ["VIP", "قلق من العلاج"],
    });
    expect((await contactConsentStates([keep])).get(keep)?.whatsapp).toBe("withdrawn");
  });
});
