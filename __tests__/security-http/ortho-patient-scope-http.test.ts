import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { hashPassword } from "../../lib/auth";
import { DEFAULT_DOCTOR_PERMISSIONS } from "../../lib/doctor-permissions";
import type { OrthoCase } from "../../lib/db";
import { authedGet, baseUrl, harness, loginStaff } from "./_server";

/** Real built-server requests, proxy, sessions and PostgreSQL patient ownership; synthetic fixtures only. */
let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let patientA = 0; let patientB = 0; let caseA = 0; let caseB = 0; let photoA = 0; let photoB = 0;
let noImages: { cookie: string }; let allPatients: { cookie: string };
let allWithoutImages: { cookie: string }; let assistant: { cookie: string };
const stamp = Date.now();
const privateB = `ORTHO_SCOPE_PRIVATE_B_${stamp}`;
type VisibleCase = OrthoCase & { photosVisible: boolean };
async function listAs(session: { cookie: string }, suffix = "") {
  const response = await authedGet(`/api/ortho${suffix}`, session);
  expect(response.status).toBe(200);
  return await response.json() as { cases: VisibleCase[]; today: string };
}
const withoutPhotos = (row: VisibleCase) => ({
  ...row, photosVisible: false, adjustments: row.adjustments.map((entry) => ({ ...entry, photos: [] })),
});

beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  const doctors = (await db.query<{ username: string; party_id: number }>(
    `SELECT username, party_id FROM users WHERE username IN ('secdoctora', 'secdoctorb')`,
  )).rows;
  const partyA = doctors.find((row) => row.username === "secdoctora")!.party_id;
  const partyB = doctors.find((row) => row.username === "secdoctorb")!.party_id;
  const addPatient = async (label: string, doctor: number) => (await db.query<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name, primary_doctor_id) VALUES ($1, $2, $3) RETURNING id`,
    [`OSP-${label}-${stamp}`, label === "B" ? privateB : `Ortho scope patient ${label}`, doctor],
  )).rows[0].id;
  patientA = await addPatient("A", partyA); patientB = await addPatient("B", partyB);
  const addCase = async (patient: number, note: string) => (await db.query<{ id: number }>(
    `INSERT INTO ortho_cases (patient_id, created_by, note, upper_wire) VALUES ($1, 'secadmin', $2, '014 NiTi') RETURNING id`,
    [patient, note],
  )).rows[0].id;
  caseA = await addCase(patientA, "Synthetic case A clinical note"); caseB = await addCase(patientB, privateB);
  const addPhoto = async (patient: number, caseId: number, label: string) => {
    const adjustment = (await db.query<{ id: number }>(
      `INSERT INTO ortho_adjustments (case_id, done_on, recorded_by, done, note, upper_wire)
       VALUES ($1, CURRENT_DATE, 'secadmin', $2, 'Synthetic adjustment clinical note', '014 NiTi') RETURNING id`,
      [caseId, `Synthetic clinical procedure ${label}`],
    )).rows[0].id;
    return (await db.query<{ id: number }>(
      `INSERT INTO patient_documents
         (patient_id, ortho_case_id, adjustment_id, kind, title, mime_type, size_bytes, sha256, storage_key,
          uploaded_by, note, photo_stage, photo_view)
       VALUES ($1, $2, $3, 'photo', $4, 'image/png', 1, $5, $6, 'secadmin', $7, 'initial', 'intraoral_frontal') RETURNING id`,
      [patient, caseId, adjustment, `Synthetic image ${label}`, "0".repeat(64), `synthetic-ortho-${stamp}-${label}`,
        label === "B" ? privateB : "Synthetic private image A note"],
    )).rows[0].id;
  };
  photoA = await addPhoto(patientA, caseA, "A"); photoB = await addPhoto(patientB, caseB, "B");
  const password = "OrthoScope#Pass1";
  const hash = await hashPassword(password);
  async function addUser(label: string, role: string, partyId: number | null, permissions: unknown) {
    const username = `os${label}${stamp}`;
    await db.query(
      `INSERT INTO users (username, display_name, password_hash, role, party_id, permissions)
       VALUES ($1, $1, $2, $3, $4, $5)`, [username, hash, role, partyId, JSON.stringify(permissions)],
    );
    return loginStaff(username, password);
  }
  // Separate users prevent rights mutations from affecting the suite's shared doctors.
  noImages = await addUser("noimg", "doctor", partyA, { ...DEFAULT_DOCTOR_PERMISSIONS, canViewXrays: false });
  allPatients = await addUser("all", "doctor", null, { ...DEFAULT_DOCTOR_PERMISSIONS, canViewAllPatients: true });
  allWithoutImages = await addUser("allnoimg", "doctor", null, {
    ...DEFAULT_DOCTOR_PERMISSIONS, canViewAllPatients: true, canViewXrays: false,
  });
  assistant = await addUser("assist", "assistant", null, {});
}, 120_000);
afterAll(async () => { await db?.end(); });

describe("ortho list patient and image isolation over real HTTP", () => {
  it("returns only the doctor's patient cases when patientId is omitted", async () => {
    const a = await listAs(h.sessions.doctorA);
    expect(a.cases.map((row) => row.id)).toContain(caseA);
    expect(a.cases.map((row) => row.id)).not.toContain(caseB);
    expect(JSON.stringify(a)).not.toContain(privateB);
    expect(a.cases.find((row) => row.id === caseA)).toMatchObject({
      photosVisible: true, adjustments: [expect.objectContaining({ photos: [expect.objectContaining({ id: photoA })] })],
    });
    const b = await listAs(h.sessions.doctorB);
    expect(b.cases.map((row) => row.id)).toContain(caseB);
    expect(b.cases.map((row) => row.id)).not.toContain(caseA);
  });

  it("preserves explicit patient and direct case access boundaries", async () => {
    expect((await authedGet(`/api/ortho?patientId=${patientB}`, h.sessions.doctorA)).status).toBe(403);
    expect((await authedGet(`/api/ortho/${caseB}`, h.sessions.doctorA)).status).toBe(403);
    expect((await listAs(h.sessions.doctorA, `?patientId=${patientA}`)).cases.map((row) => row.id)).toEqual([caseA]);
    expect((await authedGet(`/api/ortho/${caseA}`, h.sessions.doctorA)).status).toBe(200);
    expect((await authedGet(`/api/documents/${photoB}`, h.sessions.doctorA)).status).toBe(403);
  });

  it.each(["", "abc", "0", "-1", "1.5", "1e2", "9007199254740992"])(
    "returns Arabic 400 for malformed supplied filter %j without leaking data", async (filter) => {
      const response = await authedGet(`/api/ortho?patientId=${encodeURIComponent(filter)}`, h.sessions.doctorA);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ message: "رقم المريض غير صالح." });
    },
  );

  it("rejects ambiguous duplicate filters", async () => {
    const response = await authedGet(`/api/ortho?patientId=${patientA}&patientId=abc`, h.sessions.doctorA);
    expect(response.status).toBe(400);
  });

  it.each(["admin", "reception"] as const)("preserves %s list and direct metadata access", async (who) => {
    const body = await listAs(h.sessions[who]);
    expect(body.cases.map((row) => row.id)).toEqual(expect.arrayContaining([caseA, caseB]));
    const response = await authedGet(`/api/ortho/${caseB}`, h.sessions[who]);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ photosVisible: true,
      adjustments: [expect.objectContaining({ photos: [expect.objectContaining({ id: photoB })] })],
    });
  });

  it("preserves the explicit all-patient grant even without a linked doctor party", async () => {
    const body = await listAs(allPatients);
    expect(body.cases.map((row) => row.id)).toEqual(expect.arrayContaining([caseA, caseB]));
    expect(body.cases.find((row) => row.id === caseB)?.photosVisible).toBe(true);
    expect((await authedGet(`/api/ortho/${caseB}`, allPatients)).status).toBe(200);
  });

  it("withholds photos with an explicit marker, preserving clinical data on all three read forms", async () => {
    const visible = (await listAs(h.sessions.doctorA, `?patientId=${patientA}`)).cases[0];
    for (const suffix of ["", `?patientId=${patientA}`]) {
      const hidden = await listAs(noImages, suffix);
      expect(hidden.cases.find((row) => row.id === caseA)).toEqual(withoutPhotos(visible));
      expect(hidden.cases.map((row) => row.id)).not.toContain(caseB);
      expect(JSON.stringify(hidden)).not.toContain("Synthetic private image A note");
    }
    const response = await authedGet(`/api/ortho/${caseA}`, noImages);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(withoutPhotos(visible));
    expect((await authedGet(`/api/patients/${patientA}/documents`, noImages)).status).toBe(403);
    expect((await authedGet(`/api/documents/${photoA}`, noImages)).status).toBe(403);
  });

  it("does not turn an all-patient grant into image permission", async () => {
    const body = await listAs(allWithoutImages);
    for (const id of [caseA, caseB]) {
      const row = body.cases.find((one) => one.id === id)!;
      expect(row).toBeDefined(); expect(row.photosVisible).toBe(false);
      expect(row.adjustments).toHaveLength(1); expect(row.adjustments[0].photos).toEqual([]);
    }
    expect((await authedGet(`/api/documents/${photoB}`, allWithoutImages)).status).toBe(403);
  });

  it("keeps anonymous and non-clinical roles outside both endpoints", async () => {
    for (const path of ["/api/ortho", `/api/ortho/${caseA}`]) {
      expect((await fetch(`${baseUrl}${path}`, { redirect: "manual" })).status).toBe(401);
      for (const session of [h.sessions.cashier, h.sessions.accountant, assistant]) {
        expect((await authedGet(path, session)).status).toBe(403);
      }
    }
  });
});
