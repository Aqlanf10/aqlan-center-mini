import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createSessionToken, sessionCredentialVersion } from "../../lib/auth";
import type { Role } from "../../lib/roles";
import { GET } from "../../app/api/ortho/followups/route";
import { openPeriodontalFixture } from "./_periodontal-fixture";

const request = vi.hoisted(() => ({ token: "" }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => name === "aqlan_flow_session" ? { value: request.token } : undefined }),
  headers: async () => new Headers(),
}));
let fixture: Awaited<ReturnType<typeof openPeriodontalFixture>>;
let parties: number[], patients: number[];
const names = ["Synthetic first follow-up patient", "Synthetic second follow-up patient"];
const phones = ["770111111", "770222222"];
const wires = ["Synthetic first wire", "Synthetic second wire"];
beforeAll(async () => {
  vi.stubEnv("SESSION_SECRET", "synthetic-followup-board-access-only");
  fixture = await openPeriodontalFixture(process.env, { pristine: true });
  await fixture.db.ensureSchema();
  parties = []; patients = [];
  for (let i = 0; i < 2; i++) {
    const party = (await fixture.pool.query("INSERT INTO parties(kind,name) VALUES('doctor',$1) RETURNING id", [`Synthetic follow-up doctor ${i}`])).rows[0].id;
    parties.push(party);
    const patient = (await fixture.pool.query("INSERT INTO patients(patient_number,full_name,phone,primary_doctor_id) VALUES($1,$2,$3,$4) RETURNING id", [randomUUID(), names[i], phones[i], party])).rows[0].id;
    patients.push(patient);
    const ortho = (await fixture.pool.query("INSERT INTO ortho_cases(patient_id,status,phase,start_date,created_by) VALUES($1,'active','aligning','2026-01-01','synthetic-followup-access') RETURNING id", [patient])).rows[0].id;
    await fixture.pool.query("INSERT INTO ortho_adjustments(case_id,done_on,upper_wire,recorded_by) VALUES($1,'2026-10-01',$2,'synthetic-followup-access')", [ortho, wires[i]]);
    await fixture.pool.query("INSERT INTO appointments(patient_id,scheduled_date,scheduled_time,status,appointment_type) VALUES($1,'2099-01-01','10:00','booked','follow_up')", [patient]);
  }
});
afterAll(async () => { try { await fixture?.close(); } finally { vi.unstubAllEnvs(); } });

async function actor(options: { role?: Role; partyId?: number | null; global?: boolean } = {}) {
  const username = `synthetic-${randomUUID()}`, password = "synthetic-only-not-a-real-password-hash", role = options.role ?? "doctor";
  const id = (await fixture.pool.query("INSERT INTO users(username,display_name,password_hash,role,party_id,permissions) VALUES($1,'Synthetic follow-up account',$2,$3,$4,$5) RETURNING id", [username, password, role, options.partyId ?? null, JSON.stringify({ canViewAllPatients: options.global === true })])).rows[0].id;
  request.token = createSessionToken({ userId: id, username, role, partyId: options.partyId ?? null,
    expiresAt: Date.now() + 3_600_000, credentialVersion: sessionCredentialVersion(password) });
  return id;
}
async function footprint() {
  const state: Record<string, unknown> = {};
  for (const table of ["patients", "appointments", "visits", "ortho_cases", "ortho_adjustments", "treatment_plans", "plan_items", "visit_procedures", "invoices", "payments", "audit_log"]) {
    state[table] = (await fixture.pool.query(`SELECT to_jsonb(t)::text value FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
  }
  return state;
}
async function checkedRead(status: number) {
  const before = await footprint(), response = await GET(), payload = await response.json();
  expect(response.status).toBe(status);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(await footprint()).toEqual(before);
  return payload;
}
function noClinicalData(payload: unknown) {
  expect(payload).not.toHaveProperty("buckets");
  for (const value of [...names, ...phones, ...wires]) expect(JSON.stringify(payload)).not.toContain(value);
}

it("denies a valid signed-cookie doctor without a party link, with no clinical, booking or financial writes", async () => {
  await actor();
  noClinicalData(await checkedRead(403));
});
it("uses actual current ownership and honors a changed account mapping on the same signed cookie", async () => {
  const id = await actor({ partyId: parties[0] });
  let payload = JSON.stringify(await checkedRead(200));
  expect(payload).toContain(names[0]); expect(payload).toContain(phones[0]); expect(payload).toContain(wires[0]);
  expect(payload).not.toContain(names[1]); expect(payload).not.toContain(phones[1]); expect(payload).not.toContain(wires[1]);
  await fixture.pool.query("UPDATE users SET party_id=$2 WHERE id=$1", [id, parties[1]]);
  payload = JSON.stringify(await checkedRead(200));
  expect(payload).toContain(names[1]); expect(payload).not.toContain(names[0]); expect(payload).not.toContain(phones[0]);
  await fixture.pool.query("UPDATE users SET party_id=NULL WHERE id=$1", [id]);
  noClinicalData(await checkedRead(403));
});
it("honors only a current global grant for an unlinked doctor and revokes it on the next read", async () => {
  const id = await actor({ global: true });
  const payload = JSON.stringify(await checkedRead(200));
  for (const name of names) expect(payload).toContain(name);
  await fixture.pool.query("UPDATE users SET permissions=$2 WHERE id=$1", [id, JSON.stringify({ canViewAllPatients: false })]);
  noClinicalData(await checkedRead(403));
});
it.each(["admin", "reception"] as const)("preserves authenticated %s visibility without writes", async role => {
  await actor({ role });
  const payload = JSON.stringify(await checkedRead(200));
  for (const name of names) expect(payload).toContain(name);
});
it("denies the authenticated clinical assistant at the handler boundary too", async () => {
  await actor({ role: "assistant" });
  noClinicalData(await checkedRead(403));
});
it("does not retain board access after actual account deactivation", async () => {
  const id = await actor({ partyId: parties[0] });
  await fixture.pool.query("UPDATE users SET is_active=FALSE WHERE id=$1", [id]);
  noClinicalData(await checkedRead(401));
});
