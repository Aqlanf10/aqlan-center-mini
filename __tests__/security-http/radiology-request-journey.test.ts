/** Actual built-app HTTP + isolated native PostgreSQL journey. No production data,
 * no browser mock, no receipt deletion: global harness teardown owns the test DB. */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { authedGet, authedMutation, harness } from "./_server";
const KEY = "clinical.radiology_centers";
let h: Awaited<ReturnType<typeof harness>>, db: Client;
beforeAll(async () => { h = await harness(); db = new Client({ connectionString: h.seeded.dbUrl, ssl: false }); await db.connect(); }, 240_000);
afterAll(async () => { await db?.end(); });
type Actor = "doctorA" | "doctorB" | "admin" | "reception";
const read = (path: string, actor: Actor = "doctorA") => authedGet(path, h.sessions[actor]);
const post = (path: string, body: unknown, actor: Actor = "doctorA") => authedMutation(path, h.sessions[actor], "POST", JSON.stringify(body));
async function settings() {
  const response = await read("/api/settings", "admin"); expect(response.status).toBe(200);
  return response.json() as Promise<Record<string, string> & { __versions: Record<string, string | null> }>;
}
async function saveSettings(values: Record<string, string>) {
  const current = await settings();
  return authedMutation("/api/settings", h.sessions.admin, "PATCH", JSON.stringify({ ...values, __versions: Object.fromEntries(Object.keys(values).map(key => [key, current.__versions[key] ?? null])) }));
}
it("retains issued radiology snapshots and rechecks settings, clinical scope and reception print grant over real HTTP", async () => {
  const original = await settings();
  const { rows: doctors } = await db.query<{ username: string; party_id: number }>("SELECT username,party_id FROM users WHERE username=ANY($1::text[])", [["secdoctora", "secdoctorb"]]);
  const doctorA = doctors.find(row => row.username === "secdoctora")!.party_id;
  const doctorB = doctors.find(row => row.username === "secdoctorb")!.party_id;
  const { rows: [reception] } = await db.query<{ id: number; permissions: Record<string, unknown> | null }>("SELECT id,permissions FROM users WHERE username='secreception'");
  const patientName = `SYN-RAD-PATIENT-${randomUUID()}`;
  const { rows: [patient] } = await db.query<{ id: number }>("INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES($1,$2,$3) RETURNING id", [`RAD-${randomUUID()}`, patientName, doctorA]);
  const { rows: [other] } = await db.query<{ id: number }>("INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES($1,'SYN-RAD-OTHER',$2) RETURNING id", [`RAD-${randomUUID()}`, doctorB]);
  const { rows: [visit] } = await db.query<{ id: number }>("INSERT INTO visits(patient_id,patient_name,doctor_id) VALUES($1,$2,$3) RETURNING id", [patient.id, patientName, doctorA]);
  const { rows: [wrongVisit] } = await db.query<{ id: number }>("INSERT INTO visits(patient_id,patient_name,doctor_id) VALUES($1,'SYN-RAD-OTHER',$2) RETURNING id", [other.id, doctorB]);
  const center = { id: randomUUID(), name: "SYN-RAD-CENTER", address: "SYN-RAD-ADDRESS شارع اصطناعي", active: true };
  const commandKey = randomUUID();
  const body = { commandKey, patientId: patient.id, visitId: visit.id, centerId: center.id, examination: "SYN-RAD-EXAM", region: "SYN-RAD-REGION", notes: "SYN-RAD-NOTES" };
  const history = `/api/patients/${patient.id}/radiology-requests?visitId=${visit.id}`;
  const recovery = `/api/radiology-requests/commands/${commandKey}?patientId=${patient.id}&visitId=${visit.id}`;
  const printPath = `/print/radiology-request/${commandKey}?patientId=${patient.id}`;
  const auditCount = async (action: string) => Number((await db.query("SELECT count(*)::int AS n FROM audit_log WHERE action=$1 AND entity_id=$2", [action, commandKey])).rows[0].n);
  const grant = async (enabled: boolean) => {
    const result = await authedMutation(`/api/users/${reception.id}`, h.sessions.admin, "PATCH", JSON.stringify({ permissions: { ...(reception.permissions ?? {}), canPrintRadiologyRequests: enabled } }));
    expect(result.status, await result.text()).toBe(200);
  };
  try {
    await grant(false);
    const before = await settings();
    for (const actor of ["doctorA", "reception"] as const) {
      const denied = await authedMutation("/api/settings", h.sessions[actor], "PATCH", JSON.stringify({ [KEY]: JSON.stringify([center]), __versions: { [KEY]: before.__versions[KEY] ?? null } }));
      expect(denied.status).toBe(403);
    }
    expect((await saveSettings({ [KEY]: JSON.stringify([center]), "clinic.name": "SYN-RAD-CLINIC" })).status).toBe(200);
    const stale = await authedMutation("/api/settings", h.sessions.admin, "PATCH", JSON.stringify({ [KEY]: "[]", __versions: { [KEY]: before.__versions[KEY] ?? null } })); expect(stale.status).toBe(409);
    expect((await read(history, "reception")).status).toBe(403);
    const options = await read(`${history}&mode=options`); expect(options.status).toBe(200); expect((await options.json()).centers).toEqual([center]);
    expect((await post("/api/radiology-requests", { ...body, visitId: wrongVisit.id })).status).toBe(404);
    expect((await post("/api/radiology-requests", body, "doctorB")).status).toBe(403);
    const issued = await post("/api/radiology-requests", body); expect(issued.status).toBe(200);
    const saved = await issued.json(); expect(saved).toMatchObject({ id: commandKey, patientId: patient.id, visitId: visit.id, replayed: false, snapshot: { version: 1, patientName, centerName: center.name, centerAddress: center.address, doctorId: doctorA } });
    const replay = await post("/api/radiology-requests", body); expect(replay.status).toBe(200); expect(await replay.json()).toEqual({ ...saved, replayed: true });
    expect((await post("/api/radiology-requests", { ...body, notes: "DIFFERENT" })).status).toBe(409);
    const recovered = await read(recovery); expect(recovered.status).toBe(200); expect(recovered.headers.get("cache-control")).toContain("no-store"); expect(await recovered.json()).toMatchObject({ state: "completed", id: commandKey });
    const unknown = await read(`/api/radiology-requests/commands/${randomUUID()}?patientId=${patient.id}&visitId=${visit.id}`); expect(unknown.status).toBe(200); expect(await unknown.json()).toEqual({ state: "unknown" });
    expect((await read(recovery, "doctorB")).status).toBe(403);
    const listed = await read(history); expect(listed.status).toBe(200); expect(await listed.json()).toMatchObject({ canIssue: true, requests: [{ id: commandKey }], nextCursor: null });
    expect((await read(`/api/patients/${patient.id}/radiology-requests?visitId=${wrongVisit.id}`)).status).toBe(404);
    const immutable = (await db.query("SELECT to_jsonb(r)::text AS row FROM radiology_requests r WHERE command_key=$1", [commandKey])).rows[0].row;
    expect((await saveSettings({ [KEY]: JSON.stringify([{ ...center, name: "CHANGED-CENTER", address: "CHANGED-ADDRESS", active: false }]) })).status).toBe(200);
    const html = await read(printPath); expect(html.status).toBe(200); const source = await html.text();
    for (const marker of ["radiology-a6", patientName, center.name, center.address, body.examination, body.notes, commandKey]) expect(source).toContain(marker);
    expect(source).not.toContain("CHANGED-CENTER");
    expect((await read(`/print/radiology-request/${commandKey}?patientId=${other.id}`)).status).toBe(404);
    expect((await post("/api/radiology-requests", { ...body, commandKey: randomUUID() })).status).toBe(409);
    await grant(true);
    const receptionList = await read(history, "reception"); expect(receptionList.status).toBe(200); expect(await receptionList.json()).toMatchObject({ canIssue: false, requests: [{ id: commandKey }] });
    expect((await read(printPath, "reception")).status).toBe(200);
    expect((await post("/api/radiology-requests", { ...body, commandKey: randomUUID() }, "reception")).status).toBe(403);
    expect((await read(`${history}&mode=options`, "reception")).status).toBe(403);
    expect((await read(recovery, "reception")).status).toBe(403);
    expect((await post(`/api/radiology-requests/${commandKey}/print`, { patientId: other.id }, "reception")).status).toBe(404);
    expect(await auditCount("radiology_request.print")).toBe(0);
    const authorized = await post(`/api/radiology-requests/${commandKey}/print`, { patientId: patient.id }, "reception"); expect(authorized.status).toBe(200); expect(await authorized.json()).toEqual({ allowed: true, id: commandKey, patientId: patient.id });
    expect(await auditCount("radiology_request.print")).toBe(1);
    await grant(false);
    expect((await post(`/api/radiology-requests/${commandKey}/print`, { patientId: patient.id }, "reception")).status).toBe(403);
    expect((await read(history, "reception")).status).toBe(403); expect((await read(printPath, "reception")).status).toBe(404);
    expect(await auditCount("radiology_request.print")).toBe(1); expect(await auditCount("radiology_request.create")).toBe(1);
    expect((await db.query("SELECT to_jsonb(r)::text AS row FROM radiology_requests r WHERE command_key=$1", [commandKey])).rows).toEqual([{ row: immutable }]);
    expect(Number((await db.query("SELECT count(*)::int AS n FROM radiology_requests WHERE patient_id=$1", [patient.id])).rows[0].n)).toBe(1);
  } finally {
    // Restore only mutable isolated-harness settings/grants; never erase issued history.
    try { const restored = await saveSettings({ [KEY]: original[KEY], "clinic.name": original["clinic.name"] }); expect(restored.status).toBe(200); }
    finally { await db.query("UPDATE users SET permissions=$1 WHERE id=$2", [reception.permissions, reception.id]); }
  }
}, 120_000);

it("rejects disallowed reception before malformed clinical fields while retaining admitted validation", async () => {
  expect((await post('/api/radiology-requests', {}, 'reception')).status).toBe(403);
  expect((await read('/api/radiology-requests/commands/invalid', 'reception')).status).toBe(403);
  expect((await post('/api/radiology-requests', {}, 'doctorA')).status).toBe(400);
  expect((await read('/api/radiology-requests/commands/invalid', 'doctorA')).status).toBe(400);
  expect((await post('/api/radiology-requests/invalid/print', {}, 'doctorA')).status).toBe(400);
  expect((await read('/api/patients/invalid/radiology-requests', 'doctorA')).status).toBe(400);
});
