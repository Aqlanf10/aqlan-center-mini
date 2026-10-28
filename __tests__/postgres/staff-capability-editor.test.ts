/** Synthetic trusted-ready evidence ONLY for the canonical permission editor and
 * session admission. No owner provenance, activation or live grant is implied. */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { assertRealPostgresUrl } from "./_setup";
import { readVerifiedDurableSession, type VerifiedDurableSession } from "../../lib/staff-durable-session";
import { issueDurableStaffSessionIn } from "../../lib/staff-durable-issuer";
import { admitCanonicalStaffSessionIn } from "../../lib/staff-session-admission";
import { readStaffCapabilityTargetIn, updateStaffCapabilitiesIn, StaffCapabilityEditError } from "../../lib/staff-capability-editor";
import { withStaffOperation } from "../../lib/staff-operation-runtime";
import { dropSyntheticSchema, installSyntheticCanonicalFixture, syntheticClaims, syntheticPool, syntheticSchemaName, syntheticSign, waitForBlockedBy, type SyntheticAccount } from "./_canonical-ready-fixture";
assertRealPostgresUrl();

const accounts: SyntheticAccount[] = [
 { id: 1, username: "synthetic-owner", role: "admin", password: "owner-pass" },
 { id: 2, username: "synthetic-manager", role: "reception", password: "manager-pass", patientScope: "all", appointmentScope: "all",
   grants: { "staff.view": true, "staff.permissions.edit": true, "appointments.create": true, "appointments.edit": true } },
 { id: 3, username: "synthetic-doctor", role: "doctor", password: "doctor-pass", partyId: 20, grants: { "staff.view": true } },
 { id: 4, username: "synthetic-peer", role: "reception", password: "peer-pass", grants: { "staff.view": true, "staff.permissions.edit": true } },
 { id: 5, username: "synthetic-assistant", role: "assistant", password: "assistant-pass", grants: {} },
];
const schema = syntheticSchemaName();
const pool = syntheticPool(schema, 10);
const fence = () => `aqlan.canonical.identity.substrate.v1:${schema}`;
async function login(username: string, password: string): Promise<VerifiedDurableSession> {
 const outcome = await issueDurableStaffSessionIn(pool, schema, { username, password, headers: new Headers() });
 if (outcome.kind !== "issued") throw new Error(`synthetic login failed: ${outcome.kind}`);
 return readVerifiedDurableSession(outcome.token)!;
}
const admit = (handle: VerifiedDurableSession) => admitCanonicalStaffSessionIn(pool, schema, handle);
const edit = (handle: VerifiedDurableSession, input: Parameters<typeof updateStaffCapabilitiesIn>[3]) => updateStaffCapabilitiesIn(pool, schema, handle, input);
async function revision(userId: number) { return Number((await pool.query(`SELECT (permissions::jsonb->>'revision')::int AS r FROM ${schema}.users WHERE id=$1`, [userId])).rows[0].r); }
async function audits() { return Number((await pool.query(`SELECT count(*) FROM ${schema}.audit_log WHERE action='staff.capabilities.update'`)).rows[0].count); }
async function refusal(promise: Promise<unknown>) {
 try { await promise; } catch (error) { return error; }
 throw new Error("expected refusal");
}

beforeAll(async () => { await installSyntheticCanonicalFixture(pool, schema, { ownerId: 1, accounts, doctorParties: [20] }); });
beforeEach(async () => { vi.restoreAllMocks(); await pool.query(`DELETE FROM ${schema}.login_limits; DELETE FROM ${schema}.staff_login_limits`); });
afterAll(async () => { vi.restoreAllMocks(); await dropSyntheticSchema(pool, schema); await pool.end(); });

it("session admission projects exact current grants; the owner sees every capability", async () => {
 const owner = await admit(await login("synthetic-owner", "owner-pass"));
 expect(owner).toMatchObject({ username: "synthetic-owner", isOwner: true, patientScope: "all", appointmentScope: "all" });
 expect(owner!.capabilities.length).toBeGreaterThan(50);
 const doctor = await admit(await login("synthetic-doctor", "doctor-pass"));
 expect(doctor).toMatchObject({ isOwner: false, capabilities: ["staff.view"], clinicianPartyId: 20, patientScope: "none" });
 // No staff.view requirement for entry: an account with no grants still logs in and is admitted with none.
 expect(await admit(await login("synthetic-assistant", "assistant-pass"))).toMatchObject({ capabilities: [] });
});

it("owner edit is audited atomically, revokes the target's live session, and a fresh login reflects it", async () => {
 const owner = await login("synthetic-owner", "owner-pass");
 const doctorBefore = await login("synthetic-doctor", "doctor-pass");
 const before = await audits(), r = await revision(3);
 const result = await edit(owner, { targetUserId: 3, expectedRevision: r, patientScope: "own", appointmentScope: "own", grants: { "staff.view": true, "appointments.create": true } });
 expect(result).toMatchObject({ userId: 3, revision: r + 1, patientScope: "own", grants: ["appointments.create", "staff.view"] });
 expect(await audits()).toBe(before + 1);
 const { rows: [audit] } = await pool.query(`SELECT actor, details FROM ${schema}.audit_log WHERE action='staff.capabilities.update' ORDER BY id DESC LIMIT 1`);
 expect(audit.actor).toBe("synthetic-owner");
 expect(audit.details).toMatchObject({ previousRevision: r, revision: r + 1, added: ["appointments.create"], removed: [] });
 expect(await admit(doctorBefore)).toBeNull();
 const fresh = await admit(await login("synthetic-doctor", "doctor-pass"));
 expect(fresh).toMatchObject({ capabilities: ["appointments.create", "staff.view"], patientScope: "own" });
});

it("a delegated manager grants only what it holds, never delegation, never to peers, self or owner", async () => {
 const manager = await login("synthetic-manager", "manager-pass");
 const before = await audits();
 const view = await readStaffCapabilityTargetIn(pool, schema, manager, 5);
 expect(view).toMatchObject({ editable: true, scopeOptions: { patient: ["none", "own", "all"] } });
 expect(view.delegable).toContain("appointments.edit");
 expect(view.delegable).not.toContain("finance.invoices.view");
 expect(view.delegable).not.toContain("staff.permissions.edit");
 const r = await revision(5);
 for (const grants of [{ "finance.invoices.view": true }, { "staff.view": true, "staff.permissions.edit": true }] as Record<string, boolean>[]) {
  const error = await refusal(edit(manager, { targetUserId: 5, expectedRevision: r, patientScope: "none", appointmentScope: "none", grants }));
  expect(error).toBeInstanceOf(StaffCapabilityEditError);
  expect((error as StaffCapabilityEditError).code).toBe("outside-delegable-authority");
 }
 for (const [target, code] of [[2, "self-permission-change"], [1, "protected-owner"], [4, "outside-delegable-authority"]] as const) {
  const error = await refusal(edit(manager, { targetUserId: target, expectedRevision: await revision(target), patientScope: "none", appointmentScope: "none", grants: {} }));
  expect((error as StaffCapabilityEditError).code).toBe(code);
 }
 expect(await audits()).toBe(before);
 expect(await revision(5)).toBe(r);
 expect(await edit(manager, { targetUserId: 5, expectedRevision: r, patientScope: "all", appointmentScope: "none", grants: { "appointments.edit": true } }))
  .toMatchObject({ revision: r + 1, grants: ["appointments.edit"] });
});

it("stale expected revision is a 409 and changes nothing", async () => {
 const owner = await login("synthetic-owner", "owner-pass");
 const r = await revision(5);
 const error = await refusal(edit(owner, { targetUserId: 5, expectedRevision: r - 1, patientScope: "none", appointmentScope: "none", grants: {} }));
 expect(error).toMatchObject({ status: 409, code: "stale-revision" });
 expect(await revision(5)).toBe(r);
});

it("an account without the exact grant cannot open the editor or write", async () => {
 const doctor = await login("synthetic-doctor", "doctor-pass");
 await expect(readStaffCapabilityTargetIn(pool, schema, doctor, 5)).rejects.toThrow("CAPABILITY_DENIED");
 await expect(edit(doctor, { targetUserId: 5, expectedRevision: await revision(5), patientScope: "none", appointmentScope: "none", grants: {} })).rejects.toThrow("CAPABILITY_DENIED");
});

it("the writer takes the exclusive fence first: it waits behind an admitted shared reader, and blocks new issuance", async () => {
 const owner = await login("synthetic-owner", "owner-pass");
 const doctor = await login("synthetic-doctor", "doctor-pass");
 let releaseReader!: () => void;
 const readerHeld = new Promise<void>(resolve => { releaseReader = resolve; });
 let readerPid = 0;
 const reader = withStaffOperation(pool, doctor, "staff.view", async c => {
  readerPid = (await c.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
  await readerHeld;
 }, schema);
 while (!readerPid) await new Promise(resolve => setTimeout(resolve, 5));
 const r = await revision(5);
 const writer = edit(owner, { targetUserId: 5, expectedRevision: r, patientScope: "none", appointmentScope: "none", grants: { "staff.view": true } });
 expect((await waitForBlockedBy(pool, readerPid, 10_000)).length).toBeGreaterThan(0);
 expect(await revision(5)).toBe(r);
 releaseReader();
 await reader;
 expect(await writer).toMatchObject({ revision: r + 1 });
 // Exclusive holder blocks issuance until it commits.
 const holder = await pool.connect();
 await holder.query("BEGIN");
 const holderPid = (await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
 await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [fence()]);
 const pending = issueDurableStaffSessionIn(pool, schema, { username: "synthetic-assistant", password: "assistant-pass", headers: new Headers() });
 try {
  expect((await waitForBlockedBy(pool, holderPid, 10_000)).length).toBeGreaterThan(0);
 } finally { await holder.query("COMMIT"); holder.release(); }
 expect((await pending).kind).toBe("issued");
});

it("audit failure rolls the permission write back with it", async () => {
 const owner = await login("synthetic-owner", "owner-pass");
 const r = await revision(5), before = await audits();
 await pool.query(`ALTER TABLE ${schema}.audit_log ADD CONSTRAINT synthetic_editor_audit_block CHECK (action<>'staff.capabilities.update') NOT VALID`);
 try {
  await expect(edit(owner, { targetUserId: 5, expectedRevision: r, patientScope: "none", appointmentScope: "none", grants: {} })).rejects.toThrow();
 } finally { await pool.query(`ALTER TABLE ${schema}.audit_log DROP CONSTRAINT synthetic_editor_audit_block`); }
 expect(await revision(5)).toBe(r);
 expect(await audits()).toBe(before);
});

it("expiry while waiting on the exclusive fence refuses the write", async () => {
 const claims = await syntheticClaims(pool, schema, 1, 120_000);
 const owner = readVerifiedDurableSession(syntheticSign(claims))!;
 const r = await revision(5);
 const holder = await pool.connect();
 await holder.query("BEGIN");
 const holderPid = (await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
 await holder.query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))", [fence()]);
 const pending = edit(owner, { targetUserId: 5, expectedRevision: r, patientScope: "none", appointmentScope: "none", grants: {} }).then(() => null, error => error);
 try {
  expect((await waitForBlockedBy(pool, holderPid, 10_000)).length).toBeGreaterThan(0);
  vi.spyOn(Date, "now").mockReturnValue(claims.expiresAt + 1);
 } finally { await holder.query("COMMIT"); holder.release(); }
 expect(await pending).toBeInstanceOf(Error);
 vi.restoreAllMocks();
 expect(await revision(5)).toBe(r);
});

it("a stale or copied durable session is never admitted", async () => {
 const claims = await syntheticClaims(pool, schema, 3);
 expect(await admit(readVerifiedDurableSession(syntheticSign({ ...claims, durableIdentity: { ...claims.durableIdentity, permissionRevision: 999 } }))!)).toBeNull();
 expect(await admit(readVerifiedDurableSession(syntheticSign({ ...claims, username: "someone-else" }))!)).toBeNull();
 expect(await admit({} as VerifiedDurableSession)).toBeNull();
});
