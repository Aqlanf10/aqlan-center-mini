import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { randomBytes } from "node:crypto";
import { authedGet, authedMutation, harness, loginStaff, TEST_USERS, type Session } from "./_server";

// Built-server HTTP, canonical cookie/CSRF authorization and isolated PostgreSQL.
// No route/DB mocks, production target, or real patient data.
let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let patient: number, foreignPatient: number, caseA: number, caseB: number, foreignCase: number;
let assistant: Pick<Session, "cookie">;
const stamp = Date.now();
const post = (session: Pick<Session, "cookie">, links: Record<string, unknown> = {}) =>
  authedMutation(`/api/patients/${patient}/diagnoses`, session, "POST", JSON.stringify({ content: { note: "Synthetic HTTP diagnosis" }, ...links }));
const snapshot = async () => (await db.query("SELECT * FROM patient_diagnoses WHERE patient_id=ANY($1::int[]) ORDER BY id", [[patient, foreignPatient]])).rows;

beforeAll(async () => {
  h = await harness(); db = new Client({ connectionString: h.seeded.dbUrl, ssl: false }); await db.connect();
  const doctors = (await db.query<{ username: string; party_id: number }>(
    "SELECT username,party_id FROM users WHERE username=ANY($1::text[])", [[TEST_USERS.doctorA.username, TEST_USERS.doctorB.username]])).rows;
  const doctorA = doctors.find(row => row.username === TEST_USERS.doctorA.username)?.party_id;
  const doctorB = doctors.find(row => row.username === TEST_USERS.doctorB.username)?.party_id;
  expect(doctorA).toBeGreaterThan(0); expect(doctorB).toBeGreaterThan(0);
  const patients = await db.query<{ id: number }>(`INSERT INTO patients (patient_number,full_name,primary_doctor_id)
    VALUES ($1,'Synthetic diagnosis HTTP A',$3),($2,'Synthetic diagnosis HTTP B',$4) RETURNING id`,
  [`DXHTTP-A-${stamp}`, `DXHTTP-B-${stamp}`, doctorA, doctorB]);
  [patient, foreignPatient] = patients.rows.map(row => row.id);
  const cases = await db.query<{ id: number }>(`INSERT INTO ortho_cases (patient_id,status,created_by)
    VALUES ($1,'completed','synthetic-diagnosis-http'),($1,'completed','synthetic-diagnosis-http'),($2,'completed','synthetic-diagnosis-http') RETURNING id`,
  [patient, foreignPatient]);
  [caseA, caseB, foreignCase] = cases.rows.map(row => row.id);
  // A today visit gives the assistant legitimate patient read access; diagnosis
  // creation must still fail because read access is not authoring authority.
  await db.query("INSERT INTO visits (patient_id,patient_name,doctor_id,status) VALUES ($1,'Synthetic diagnosis HTTP A',$2,'in_chair')", [patient, doctorA]);
  const username = `dxassistant${stamp}`;
  const password = `Dx!${randomBytes(16).toString("hex")}`;
  const created = await authedMutation("/api/users", h.sessions.admin, "POST", JSON.stringify({ username, displayName: "Synthetic diagnosis assistant", password, role: "assistant" }));
  expect(created.status).toBeLessThan(300); assistant = await loginStaff(username, password);
}, 120_000);
afterAll(async () => { await db?.end(); });

describe("diagnosis ownership and authoring on authenticated built HTTP", () => {
  it("preserves canonical doctor/patient isolation", async () => {
    expect((await authedGet(`/api/patients/${patient}/diagnoses`, h.sessions.doctorA)).status).toBe(200);
    expect((await authedGet(`/api/patients/${patient}/diagnoses`, h.sessions.doctorB)).status).toBe(403);
    expect((await post(h.sessions.doctorB, { orthoCaseId: caseA })).status).toBe(403);
    expect(await snapshot()).toEqual([]);
  });
  it("saves standalone and two case diagnoses with one immutable patient-wide chain and scoped history", async () => {
    const saved: Array<{ id: number; version: number }> = [];
    for (const orthoCaseId of [null, caseA, caseB, caseA]) {
      const response = await post(h.sessions.doctorA, { orthoCaseId }); expect(response.status).toBe(201); saved.push(await response.json());
    }
    const rows = await snapshot(); expect(rows.map(row => row.version)).toEqual([1, 2, 3, 4]);
    expect(rows.map(row => row.supersedes)).toEqual([null, ...saved.slice(0, -1).map(row => row.id)]);
    expect(rows.every(row => row.created_by === TEST_USERS.doctorA.username)).toBe(true);
    const allResponse = await authedGet(`/api/patients/${patient}/diagnoses`, h.sessions.doctorA);
    expect(allResponse.status).toBe(200);
    const all = await allResponse.json() as { diagnoses: Array<{ id: number }> };
    expect(all.diagnoses.map(row => row.id)).toEqual(saved.map(row => row.id).reverse());
    const scopedResponse = await authedGet(`/api/patients/${patient}/diagnoses?orthoCaseId=${caseA}`, h.sessions.doctorA);
    expect(scopedResponse.status).toBe(200);
    const scoped = await scopedResponse.json() as { diagnoses: Array<{ id: number; orthoCaseId: number }> };
    expect(scoped.diagnoses.map(row => row.id)).toEqual([saved[3].id, saved[1].id]);
    expect(scoped.diagnoses.every(row => row.orthoCaseId === caseA)).toBe(true);
    expect(await snapshot()).toEqual(rows);
  });
  it("refuses reception/assistant/financial roles without changing any diagnosis", async () => {
    const before = await snapshot();
    for (const session of [h.sessions.reception, assistant, h.sessions.cashier, h.sessions.accountant]) {
      expect((await post(session, { orthoCaseId: caseA })).status).toBe(403);
    }
    expect(await snapshot()).toEqual(before);
  });
  it("rejects foreign or missing cases identically, including for an admin who can read both patients", async () => {
    const before = await snapshot(); const failures: unknown[] = [];
    for (const session of [h.sessions.doctorA, h.sessions.admin]) {
      for (const orthoCaseId of [foreignCase, 2147483647]) {
        const response = await post(session, { orthoCaseId }); expect(response.status).toBe(400); failures.push(await response.json());
      }
    }
    expect(failures.every(value => JSON.stringify(value) === JSON.stringify(failures[0]))).toBe(true);
    for (const orthoCaseId of ["bad", 0, true, [caseA]]) expect((await post(h.sessions.doctorA, { orthoCaseId })).status).toBe(400);
    expect(await snapshot()).toEqual(before);
  });
});
