import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { authedGet, baseUrl, harness, TEST_USERS } from "./_server";

// Uses the existing built-server harness, real cookie authentication, PostgreSQL,
// multipart parsing and its isolated documents directory. No route/storage mocks.
let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let ownPatient: number, foreignPatient: number;
let ownVisit: number, foreignVisit: number, unlinkedVisit: number;
let ownCase: number, foreignCase: number, ownAdjustment: number, foreignAdjustment: number;
const stamp = Date.now();
const title = "Synthetic document association HTTP proof";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  const doctors = (await db.query<{ username: string; party_id: number }>(
    "SELECT username, party_id FROM users WHERE username = ANY($1::text[])",
    [[TEST_USERS.doctorA.username, TEST_USERS.doctorB.username]],
  )).rows;
  const doctorA = doctors.find(row => row.username === TEST_USERS.doctorA.username)?.party_id;
  const doctorB = doctors.find(row => row.username === TEST_USERS.doctorB.username)?.party_id;
  expect(doctorA).toBeGreaterThan(0);
  expect(doctorB).toBeGreaterThan(0);
  // Private patients keep these foreign keys out of other suites' shared-patient
  // visit cleanup. Primary doctor ownership uses the canonical harness schema.
  const patients = await db.query<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name, primary_doctor_id) VALUES
      ($1, 'Synthetic document association patient A', $3),
      ($2, 'Synthetic document association patient B', $4) RETURNING id`,
    [`DOCASSOC-A-${stamp}`, `DOCASSOC-B-${stamp}`, doctorA, doctorB],
  );
  [ownPatient, foreignPatient] = patients.rows.map(row => row.id);
  const visits = await db.query<{ id: number }>(
    `INSERT INTO visits (patient_id, patient_name, status) VALUES
      ($1, 'Synthetic document A', 'done'), ($2, 'Synthetic document B', 'done'),
      (NULL, 'Synthetic unlinked document visit', 'done') RETURNING id`,
    [ownPatient, foreignPatient],
  );
  [ownVisit, foreignVisit, unlinkedVisit] = visits.rows.map(row => row.id);
  // Completed cases remain valid historical document targets.
  const cases = await db.query<{ id: number }>(
    `INSERT INTO ortho_cases (patient_id, status, created_by) VALUES
      ($1, 'completed', 'document-http-test'), ($2, 'completed', 'document-http-test') RETURNING id`,
    [ownPatient, foreignPatient],
  );
  [ownCase, foreignCase] = cases.rows.map(row => row.id);
  const adjustments = await db.query<{ id: number }>(
    `INSERT INTO ortho_adjustments (case_id, visit_id, done_on, elastics, next_weeks, recorded_by)
      VALUES ($1, $3, CURRENT_DATE, 'none', 4, 'document-http-test'),
             ($2, $4, CURRENT_DATE, 'none', 4, 'document-http-test') RETURNING id`,
    [ownCase, foreignCase, ownVisit, foreignVisit],
  );
  [ownAdjustment, foreignAdjustment] = adjustments.rows.map(row => row.id);
});
afterAll(async () => { await db?.end(); });

function upload(links: Record<string, string | undefined> = {}) {
  const form = new FormData();
  form.set("file", new Blob([new Uint8Array(png)], { type: "image/png" }), "synthetic.png");
  form.set("kind", "photo");
  form.set("title", title);
  for (const [key, value] of Object.entries(links)) {
    if (value !== undefined) form.set(key, value);
  }
  return fetch(`${baseUrl}/api/patients/${ownPatient}/documents`, {
    method: "POST",
    headers: { Cookie: h.sessions.doctorA.cookie, Origin: baseUrl, "Sec-Fetch-Site": "same-origin" },
    body: form,
    redirect: "manual",
  });
}
const count = async () => (await db.query<{ n: number }>(
  "SELECT COUNT(*)::int AS n FROM patient_documents WHERE title = $1", [title],
)).rows[0].n;
const refusal = { message: "تعذّر ربط المستند بالسجل المحدد." };

describe("document association boundary over real authenticated HTTP", () => {
  it("keeps private fixture patients within their canonical doctor ownership", async () => {
    expect((await authedGet(`/api/patients/${ownPatient}`, h.sessions.doctorA)).status).toBe(200);
    expect((await authedGet(`/api/patients/${ownPatient}`, h.sessions.doctorB)).status).toBe(403);
    expect((await authedGet(`/api/patients/${foreignPatient}`, h.sessions.doctorB)).status).toBe(200);
    expect((await authedGet(`/api/patients/${foreignPatient}`, h.sessions.doctorA)).status).toBe(403);
  });

  it("stores and serves a same-patient document with coherent optional links", async () => {
    const before = await count();
    const response = await upload({ visitId: String(ownVisit), orthoCaseId: String(ownCase), adjustmentId: String(ownAdjustment) });
    expect(response.status).toBe(201);
    const document = await response.json() as { id: number };
    expect(document).toMatchObject({
      patientId: ownPatient, visitId: ownVisit, orthoCaseId: ownCase,
      adjustmentId: ownAdjustment, uploadedBy: TEST_USERS.doctorA.username,
      mimeType: "image/png", sizeBytes: png.length,
    });
    expect(await count()).toBe(before + 1);
    expect((await db.query("SELECT patient_id,visit_id,ortho_case_id,adjustment_id FROM patient_documents WHERE id=$1", [document.id])).rows).toEqual([{
      patient_id: ownPatient, visit_id: ownVisit, ortho_case_id: ownCase, adjustment_id: ownAdjustment,
    }]);
    const download = await authedGet(`/api/documents/${document.id}`, h.sessions.doctorA);
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toBe("image/png");
    expect(download.headers.get("content-length")).toBe(String(png.length));
    expect(download.headers.get("cache-control")).toContain("private");
    expect(download.headers.get("cache-control")).toContain("no-store");
    expect(download.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await download.arrayBuffer())).toEqual(png);
    expect((await authedGet(`/api/documents/${document.id}`, h.sessions.doctorB)).status).toBe(403);
  });

  it("rejects foreign, missing, unlinked and mismatched references without revealing their identity or inserting rows", async () => {
    const before = await count();
    for (const links of [{ visitId: String(foreignVisit) }, { orthoCaseId: String(foreignCase) },
      { adjustmentId: String(foreignAdjustment) }, { visitId: "2147483647" },
      { visitId: String(unlinkedVisit) }, { orthoCaseId: String(ownCase), adjustmentId: String(foreignAdjustment) }]) {
      const response = await upload(links);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual(refusal);
      expect(await count()).toBe(before);
    }
  });

  it("rejects malformed explicit IDs instead of silently storing unassociated documents", async () => {
    const before = await count();
    for (const field of ["visitId", "orthoCaseId", "adjustmentId"]) {
      for (const value of ["abc", "0", "1.5", "2147483648"]) {
        const response = await upload({ [field]: value });
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual(refusal);
      }
    }
    expect(await count()).toBe(before);
  });
});
