import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authedGet, harness, TEST_USERS } from "./_server";

let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let patientId: number, otherPatientId: number;
let first: number, second: number, other: number, discarded: number;
const patientMarker = "SYNTHETIC-CEPH-PRIVATE-PATIENT";
const diagnosisMarker = "SYNTHETIC-CEPH-PRIVATE-DIAGNOSIS";
const landmarkMarker = "SYNTHETIC-CEPH-PRIVATE-LANDMARK";
const markers = [patientMarker, diagnosisMarker, landmarkMarker];
const otherPatientMarker = "SYNTHETIC-CEPH-OTHER-PATIENT";

beforeAll(async () => {
  h = await harness();
  const url = new URL(h.seeded.dbUrl);
  expect(url.hostname).toBe("127.0.0.1");
  expect(url.pathname).toBe("/aqlan_sec_http");
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  const doctor = (await db.query("SELECT party_id FROM users WHERE username=$1", [TEST_USERS.doctorA.username])).rows[0].party_id;
  async function patient(name: string) {
    return Number((await db.query("INSERT INTO patients (patient_number,full_name,primary_doctor_id) VALUES ($1,$2,$3) RETURNING id",
      [name, name, doctor])).rows[0].id);
  }
  patientId = await patient(patientMarker);
  otherPatientId = await patient(otherPatientMarker);
  async function study(owner: number, status = "completed") {
    const document = (await db.query("INSERT INTO patient_documents (patient_id,kind,title,mime_type,size_bytes,sha256,storage_key,uploaded_by) VALUES ($1,'xray','synthetic','image/png',1,$2,$3,'synthetic') RETURNING id",
      [owner, "0".repeat(64), `synthetic-ceph/${owner}/${status}/${Math.random()}`])).rows[0].id;
    return Number((await db.query("INSERT INTO ceph_analyses (patient_id,document_id,status,created_by) VALUES ($1,$2,$3,'synthetic') RETURNING id",
      [owner, document, status])).rows[0].id);
  }
  first = await study(patientId);
  second = await study(patientId);
  other = await study(otherPatientId);
  discarded = await study(patientId, "discarded");
  await db.query("INSERT INTO ceph_landmarks (analysis_id,code,x,y,confirmed_by) VALUES ($1,'S',123.456,789.123,$2)", [first, landmarkMarker]);
  await db.query("INSERT INTO ceph_diagnoses (analysis_id,final_dx,created_by) VALUES ($1,$2,'synthetic')", [first, diagnosisMarker]);
});
afterAll(async () => { await db?.end(); });

const compare = (a: number, b: number, patient?: number) => `/ceph/compare?first=${a}&second=${b}${patient === undefined ? "" : `&patient=${patient}`}`;
async function payload(path: string, role: keyof typeof h.sessions, rsc: boolean) {
  // Next validates the RSC cache key; with no router-state headers its value is empty.
  const requestPath = rsc ? `${path}${path.includes("?") ? "&" : "?"}_rsc=` : path;
  const response = await authedGet(requestPath, h.sessions[role], rsc ? { RSC: "1" } : {});
  expect(response.status).toBeLessThan(500);
  expect(response.headers.get("content-type")).toContain(rsc ? "text/x-component" : "text/html");
  return response.text();
}
function privateDataAbsent(body: string) {
  expect([...markers, otherPatientMarker].filter((marker) => body.includes(marker)), "private markers in response").toEqual([]);
}

describe.each([false, true])("Ceph page authorization (RSC=%s)", (rsc) => {
  it.each(["workspace", "comparison"])("does not serialize unrelated doctor data: %s", async (page) => {
    const path = page === "workspace" ? `/ceph/${first}` : compare(first, second, patientId);
    privateDataAbsent(await payload(path, "doctorB", rsc));
  });
  it.each(["workspace", "comparison"])("requires canViewXrays for the patient's doctor: %s", async (page) => {
    const original = (await db.query("SELECT permissions FROM users WHERE username=$1", [TEST_USERS.doctorA.username])).rows[0].permissions;
    try {
      await db.query("UPDATE users SET permissions=$1 WHERE username=$2", [JSON.stringify({ ...JSON.parse(original), canViewXrays: false }), TEST_USERS.doctorA.username]);
      const path = page === "workspace" ? `/ceph/${first}` : compare(first, second, patientId);
      privateDataAbsent(await payload(path, "doctorA", rsc));
    } finally {
      await db.query("UPDATE users SET permissions=$1 WHERE username=$2", [original, TEST_USERS.doctorA.username]);
    }
  });
  it.each(["doctorA", "admin", "reception"] as const)("preserves authorized %s access", async (role) => {
    const body = await payload(`/ceph/${first}`, role, rsc);
    for (const marker of markers) expect(body.includes(marker), `authorized response missing ${marker}`).toBe(true);
    expect((await payload(compare(first, second, patientId), role, rsc)).includes(patientMarker)).toBe(true);
    expect((await payload(compare(first, second), role, rsc)).includes(patientMarker)).toBe(true);
  });
  it("rejects missing, invalid, discarded, same and mismatched comparison identities", async () => {
    for (const path of [
      "/ceph/invalid", "/ceph/0", "/ceph/999999999", `/ceph/${discarded}`,
      "/ceph/compare", "/ceph/compare?a=1&b=2", `/ceph/compare?first=invalid&second=${second}`,
      compare(first, first, patientId), compare(first, 999999999, patientId),
      compare(first, discarded, patientId), compare(first, other, patientId),
      compare(first, second, otherPatientId), compare(first, second, 0),
      `${compare(first, second)}&patient=invalid`,
    ]) privateDataAbsent(await payload(path, "admin", rsc));
  });
  it("keeps API patient checks intact", async () => {
    expect((await authedGet(`/api/ceph/${first}`, h.sessions.doctorB)).status).toBe(403);
    expect((await authedGet(`/api/ceph/compare?first=${first}&second=${second}`, h.sessions.doctorB)).status).toBe(403);
  });
});

// These are the real print routes, not the workspace page or its API.
describe("positive ceph print HTTP documents", () => {
  it.each(["study", "comparison"])("renders the persisted %s document", async (kind) => {
    const path = kind === "study" ? `/print/ceph/${first}` : `/print/ceph-compare?first=${first}&second=${second}`;
    const response = await authedGet(path, h.sessions.admin);
    const body = (await response.text()).replace(/<script[\s\S]*?<\/script>/g, "");
    expect(response.status).toBe(200);
    expect(body).toContain(patientMarker);
    expect(body).toContain(kind === "study" ? "تقرير التحليل السيفالومتري" : "مقارنة");
    expect(body).not.toMatch(/Application error|server error occurred/);
    expect((await authedGet(path, h.sessions.doctorB)).status).toBe(404);
  });
});
