import { Client } from "pg";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { seedCanonicalCephComparison } from "../fixtures/canonical-ceph-comparison";
import { authedGet, harness, TEST_USERS } from "./_server";

let h: Awaited<ReturnType<typeof harness>>, db: Client;
let ids: Awaited<ReturnType<typeof seedCanonicalCephComparison>>;
beforeAll(async () => {
  h = await harness(); db = new Client({ connectionString: h.seeded.dbUrl, ssl: false }); await db.connect();
  const doctor = (await db.query("SELECT party_id FROM users WHERE username=$1", [TEST_USERS.doctorA.username])).rows[0].party_id;
  const patient = (await db.query("INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES($1,'SYN legacy ceph order',$2) RETURNING id", [`SYN-CEPH-ORDER-${randomUUID()}`, doctor])).rows[0].id;
  ids = await seedCanonicalCephComparison(db, patient);
}, 120_000);
afterAll(async () => { await db?.end(); });
// Staging's rule wins over the earlier expectation here: completed history without an immutable
// provenance witness (units, algorithm, source identity) is never compared or overlaid by the legacy
// routes, in either order, and nothing is recomputed with today's definitions. Imaging-date ordering of
// saved facts is covered by the canonical comparison journey on the same fixture.
const unwitnessed = /غير موثقة بإصدار الحساب والوحدات|تعذّر التحقق من سلامة مصدر الدراسة المعتمدة/;
it.each(["compare", "superimpose"])("legacy %s refuses unwitnessed completed studies in both orders without computed values", async endpoint => {
  for (const [first, second] of [[ids.before, ids.after], [ids.after, ids.before]]) {
    const response = await authedGet(`/api/ceph/${endpoint}?first=${first}&second=${second}`, h.sessions.doctorA);
    expect(response.status).toBe(409); const body = await response.json();
    expect(Object.keys(body)).toEqual(["message"]); expect(body.message).toMatch(unwitnessed);
  }
});
it("legacy comparison never replaces missing approved measurements with today's computed values", async () => {
  const empty = await seedCanonicalCephComparison(db, ids.patientId);
  await db.query("DELETE FROM ceph_measurements WHERE analysis_id=$1", [empty.before]);
  const response = await authedGet(`/api/ceph/compare?first=${empty.before}&second=${empty.after}`, h.sessions.doctorA);
  expect(response.status).toBe(409); const body = await response.json();
  expect(Object.keys(body)).toEqual(["message"]); expect(body.message).toMatch(unwitnessed);
  expect((await db.query("SELECT count(*)::int n FROM ceph_measurements WHERE analysis_id=$1", [empty.before])).rows[0].n).toBe(0);
});
