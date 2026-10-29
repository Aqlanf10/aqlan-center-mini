/** Synthetic trusted-ready evidence ONLY for the canonical account editor (review
 * 6507696166 item 2). No owner provenance, activation or live grant is implied. */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { assertRealPostgresUrl } from "./_setup";
import { readVerifiedDurableSession, type VerifiedDurableSession } from "../../lib/staff-durable-session";
import { issueDurableStaffSessionIn } from "../../lib/staff-durable-issuer";
import { admitCanonicalStaffSessionIn } from "../../lib/staff-session-admission";
import { readStaffAccountIn, updateStaffAccountIn } from "../../lib/staff-account-editor";
import { StaffCapabilityEditError } from "../../lib/staff-capability-editor";
import { withStaffOperation } from "../../lib/staff-operation-runtime";
import { DOCTOR_COMMISSION_HISTORY_SQL } from "../../lib/commission-history-schema";
import { dropSyntheticSchema, installSyntheticCanonicalFixture, syntheticPool, syntheticSchemaName, waitForBlockedBy, type SyntheticAccount } from "./_canonical-ready-fixture";
assertRealPostgresUrl();

const accounts: SyntheticAccount[] = [
 { id: 1, username: "synthetic-owner", role: "admin", password: "owner-pass" },
 { id: 2, username: "synthetic-manager", role: "reception", password: "manager-pass", patientScope: "all", appointmentScope: "all",
   grants: { "staff.view": true, "staff.profile.edit": true, "staff.accounts.disable": true, "appointments.create": true } },
 { id: 3, username: "synthetic-doctor", role: "doctor", password: "doctor-pass", partyId: 20, grants: { "staff.view": true } },
 { id: 4, username: "synthetic-reception", role: "reception", password: "reception-pass", grants: { "appointments.create": true } },
 { id: 5, username: "synthetic-inactive", role: "reception", password: "inactive-pass", active: false, grants: {} },
 { id: 6, username: "synthetic-finance", role: "accountant", password: "finance-pass", grants: { "finance.invoices.view": true } },
 { id: 7, username: "synthetic-stale-link", role: "doctor", password: "stale-pass", partyId: 22, active: false, grants: {} },
 { id: 8, username: "synthetic-viewer", role: "reception", password: "viewer-pass", grants: { "staff.view": true } },
 { id: 9, username: "synthetic-nogrant", role: "assistant", password: "nogrant-pass", grants: {} },
];
const schema = syntheticSchemaName();
const pool = syntheticPool(schema, 12);
const fence = () => `aqlan.canonical.identity.substrate.v1:${schema}`;
async function attempt(username: string, password: string) {
 return issueDurableStaffSessionIn(pool, schema, { username, password, headers: new Headers() });
}
async function login(username: string, password: string): Promise<VerifiedDurableSession> {
 const outcome = await attempt(username, password);
 if (outcome.kind !== "issued") throw new Error(`synthetic login failed: ${outcome.kind}`);
 return readVerifiedDurableSession(outcome.token)!;
}
const admit = (handle: VerifiedDurableSession) => admitCanonicalStaffSessionIn(pool, schema, handle);
const read = (handle: VerifiedDurableSession, id: number) => readStaffAccountIn(pool, schema, handle, id);
const save = (handle: VerifiedDurableSession, targetUserId: number, expectedVersion: string, changes: Record<string, unknown>) =>
 updateStaffAccountIn(pool, schema, handle, { targetUserId, expectedVersion, changes });
async function row(id: number) {
 return (await pool.query(`SELECT display_name,role,is_active,party_id,password_hash,authorization_epoch::text AS epoch FROM ${schema}.users WHERE id=$1`, [id])).rows[0];
}
async function audits(action = "staff.account.update") { return Number((await pool.query(`SELECT count(*) FROM ${schema}.audit_log WHERE action=$1`, [action])).rows[0].count); }
async function lastAudit() { return (await pool.query(`SELECT actor, entity_id, details, summary FROM ${schema}.audit_log WHERE action='staff.account.update' ORDER BY id DESC LIMIT 1`)).rows[0]; }
async function refusal(promise: Promise<unknown>) {
 try { await promise; } catch (error) { return error; }
 throw new Error("expected refusal");
}
async function version(owner: VerifiedDurableSession, id: number) { return (await read(owner, id)).version; }

beforeAll(async () => {
 await installSyntheticCanonicalFixture(pool, schema, { ownerId: 1, accounts, doctorParties: [20, 21, 22],
  extraSql: `ALTER TABLE ${schema}.parties ADD COLUMN commission_percent NUMERIC(5,2) NOT NULL DEFAULT 30; ALTER TABLE ${schema}.users ADD COLUMN commission_config TEXT; ${DOCTOR_COMMISSION_HISTORY_SQL}` });
 await pool.query(`UPDATE ${schema}.parties SET is_active=FALSE WHERE id=22`);
});
beforeEach(async () => { vi.restoreAllMocks(); await pool.query(`DELETE FROM ${schema}.login_limits; DELETE FROM ${schema}.staff_login_limits`); });
afterAll(async () => { vi.restoreAllMocks(); await dropSyntheticSchema(pool, schema); await pool.end(); });

it("the read view states exactly what this actor may change; owner operations are the owner's", async () => {
 const owner = await login("synthetic-owner", "owner-pass");
 const manager = await login("synthetic-manager", "manager-pass");
 const viewer = await login("synthetic-viewer", "viewer-pass");
 expect(await read(owner, 4)).toMatchObject({ username: "synthetic-reception", active: true, clinicianLink: "none",
  allowed: { displayName: true, active: true, roleLabel: true, clinicianPartyId: true, temporaryPassword: true }, doctorOptions: [{ id: 20 }, { id: 21 }] });
 expect(await read(manager, 4)).toMatchObject({ allowed: { displayName: true, active: true, roleLabel: false, clinicianPartyId: false, temporaryPassword: false }, roleOptions: [], doctorOptions: [] });
 expect(await read(viewer, 4)).toMatchObject({ allowed: { displayName: false, active: false, roleLabel: false, clinicianPartyId: false, temporaryPassword: false } });
 // Inactive and stale-linked targets are readable administrative targets, not refusals.
 expect(await read(manager, 5)).toMatchObject({ active: false, allowed: { active: true } });
 expect(await read(owner, 7)).toMatchObject({ active: false, clinicianPartyId: 22, clinicianLink: "stale" });
 expect(await read(owner, 1)).toMatchObject({ isOwner: true, isSelf: true, allowed: { displayName: false, active: false } });
 // Nothing secret in the view.
 expect(JSON.stringify(await read(owner, 4))).not.toMatch(/scrypt|password_hash|passwordHash/);
 await expect(read(await login("synthetic-nogrant", "nogrant-pass"), 4)).rejects.toThrow("STAFF_OPERATION_CAPABILITY_DENIED");
});

it("deactivation revokes only the target's sessions, is audited atomically, and blocks its next login", async () => {
 const manager = await login("synthetic-manager", "manager-pass");
 const target = await login("synthetic-reception", "reception-pass");
 const bystander = await login("synthetic-doctor", "doctor-pass");
 const before = await row(4), count = await audits();
 const result = await save(manager, 4, await version(manager, 4), { active: false });
 expect(result).toMatchObject({ active: false, userId: 4 });
 expect(await admit(target)).toBeNull();
 await expect(withStaffOperation(pool, target, "appointments.create", async () => "x", schema)).rejects.toThrow(/^STAFF_OPERATION_/);
 expect(await admit(bystander)).toMatchObject({ username: "synthetic-doctor" });
 expect(await admit(manager)).toMatchObject({ username: "synthetic-manager" });
 expect((await attempt("synthetic-reception", "reception-pass")).kind).not.toBe("issued");
 expect(await audits()).toBe(count + 1);
 expect(await lastAudit()).toMatchObject({ actor: "synthetic-manager", entity_id: "4",
  details: { changes: { active: [true, false] }, credentialReset: false, sessionsRevoked: true, fields: ["active"], actorUserId: 2 } });
 expect(Number((await row(4)).epoch)).toBe(Number(before.epoch) + 1);
});

it("activation from inactive: the same delegate restores it and the account signs in again", async () => {
 const manager = await login("synthetic-manager", "manager-pass");
 for (const id of [4, 5]) {
  expect(await save(manager, id, await version(manager, id), { active: true })).toMatchObject({ active: true });
 }
 expect(await admit(await login("synthetic-inactive", "inactive-pass"))).toMatchObject({ username: "synthetic-inactive", capabilities: [] });
 expect(await admit(await login("synthetic-reception", "reception-pass"))).toMatchObject({ capabilities: ["appointments.create"] });
 expect(await lastAudit()).toMatchObject({ details: { changes: { active: [false, true] } } });
});

it("a stale version is a 409 and changes nothing; a display-name change does not revoke", async () => {
 const manager = await login("synthetic-manager", "manager-pass");
 const target = await login("synthetic-reception", "reception-pass");
 const stale = await version(manager, 4);
 const renamed = await save(manager, 4, stale, { displayName: "استقبال الفترة الصباحية" });
 expect(renamed).toMatchObject({ displayName: "استقبال الفترة الصباحية" });
 expect(await admit(target)).toMatchObject({ username: "synthetic-reception" });
 const before = await row(4), count = await audits();
 const error = await refusal(save(manager, 4, stale, { active: false }));
 expect(error).toMatchObject({ status: 409, code: "stale-version" });
 expect((error as Error).message).toMatch(/[؀-ۿ]/);
 expect([await row(4), await audits()]).toEqual([before, count]);
 expect(await refusal(save(manager, 4, "not-a-version", { active: false }))).toMatchObject({ status: 409, code: "stale-version" });
});

it("the batch rule: one refused or unknown field refuses the whole save", async () => {
 const manager = await login("synthetic-manager", "manager-pass");
 const before = await row(4), count = await audits(), v = await version(manager, 4);
 expect(await refusal(save(manager, 4, v, { displayName: "اسم جديد", roleLabel: "admin" }))).toMatchObject({ status: 403, code: "owner-operation-required" });
 expect(await refusal(save(manager, 4, v, { displayName: "اسم جديد", permissions: "{}" }))).toMatchObject({ status: 422, code: "unknown-account-field" });
 expect(await refusal(save(manager, 4, v, { displayName: "اسم جديد", active: "no" }))).toMatchObject({ status: 422, code: "invalid-active" });
 expect(await refusal(save(manager, 4, v, { displayName: "" }))).toMatchObject({ status: 422, code: "invalid-display-name" });
 expect(await refusal(save(manager, 4, v, { displayName: before.display_name ?? "synthetic-reception" }))).toMatchObject({ status: 422, code: "no-account-change" });
 expect([await row(4), await audits()]).toEqual([before, count]);
});

it("the protected owner is never a target; no actor changes its own account; a delegate stays within its authority", async () => {
 const owner = await login("synthetic-owner", "owner-pass");
 const manager = await login("synthetic-manager", "manager-pass");
 const viewer = await login("synthetic-viewer", "viewer-pass");
 const count = await audits();
 expect(await refusal(save(manager, 1, await version(owner, 1), { active: false }))).toMatchObject({ status: 403, code: "protected-owner" });
 expect(await refusal(save(owner, 1, await version(owner, 1), { displayName: "المالك" }))).toMatchObject({ status: 403, code: "self-staff-maintenance" });
 expect(await refusal(save(manager, 2, await version(owner, 2), { active: false }))).toMatchObject({ status: 403, code: "self-staff-maintenance" });
 expect(await refusal(save(manager, 6, await version(owner, 6), { active: false }))).toMatchObject({ status: 403, code: "outside-delegable-authority" });
 expect(await refusal(save(viewer, 4, await version(owner, 4), { active: false }))).toMatchObject({ status: 403, code: "maintenance-denied" });
 await expect(save(await login("synthetic-nogrant", "nogrant-pass"), 4, await version(owner, 4), { active: false })).rejects.toThrow("STAFF_OPERATION_CAPABILITY_DENIED");
 expect(await audits()).toBe(count);
 expect((await row(1)).is_active).toBe(true);
 expect((await row(2)).is_active).toBe(true);
});

it("a role label never grants: the owner relabels an account and its capabilities stay exactly the same", async () => {
 const owner = await login("synthetic-owner", "owner-pass");
 const before = await admit(await login("synthetic-reception", "reception-pass"));
 expect(await save(owner, 4, await version(owner, 4), { roleLabel: "admin" })).toMatchObject({ roleLabel: "admin" });
 const after = await admit(await login("synthetic-reception", "reception-pass"));
 expect(after).toMatchObject({ isOwner: false, capabilities: before!.capabilities, patientScope: before!.patientScope, appointmentScope: before!.appointmentScope });
 await save(owner, 4, await version(owner, 4), { roleLabel: "reception" });
});

it("a temporary password (owner only) revokes the target's sessions and never appears in audit or response", async () => {
 const owner = await login("synthetic-owner", "owner-pass");
 const target = await login("synthetic-viewer", "viewer-pass");
 const bystander = await login("synthetic-reception", "reception-pass");
 const result = await save(owner, 8, await version(owner, 8), { temporaryPassword: "temporary-pass-1" });
 expect(JSON.stringify(result)).not.toMatch(/temporary-pass-1|scrypt/);
 expect(await admit(target)).toBeNull();
 expect(await admit(bystander)).not.toBeNull();
 expect((await attempt("synthetic-viewer", "viewer-pass")).kind).not.toBe("issued");
 expect(await admit(await login("synthetic-viewer", "temporary-pass-1"))).toMatchObject({ username: "synthetic-viewer" });
 const audit = await lastAudit();
 expect(audit.details).toMatchObject({ credentialReset: true, fields: ["temporaryPassword"], sessionsRevoked: true, changes: {} });
 expect(JSON.stringify(audit)).not.toMatch(/temporary-pass-1|scrypt|hash/i);
 // A delegate cannot reset credentials.
 expect(await refusal(save(await login("synthetic-manager", "manager-pass"), 8, await version(owner, 8), { temporaryPassword: "another-pass-2" })))
  .toMatchObject({ code: "owner-operation-required" });
});

it("relinking a clinician keeps the commission semantics atomically: baselines, new snapshots and their audits", async () => {
 await pool.query(`UPDATE ${schema}.users SET commission_config=$1 WHERE id=3`, [JSON.stringify({ calculationMode: "percent", defaultPercent: 40, deductLabCost: true, basis: "collected" })]);
 const owner = await login("synthetic-owner", "owner-pass");
 const doctor = await login("synthetic-doctor", "doctor-pass");
 const commissionAudits = await audits("doctor.commission.update");
 expect(await save(owner, 3, await version(owner, 3), { clinicianPartyId: 21 })).toMatchObject({ clinicianPartyId: 21, clinicianLink: "active" });
 expect(await admit(doctor)).toBeNull();
 expect(await admit(await login("synthetic-doctor", "doctor-pass"))).toMatchObject({ clinicianPartyId: 21 });
 const { rows: history } = await pool.query(`SELECT party_id, source FROM ${schema}.doctor_commission_history ORDER BY party_id, id`);
 expect(history).toEqual([
  { party_id: 20, source: "baseline" }, { party_id: 20, source: "advanced" },
  { party_id: 21, source: "baseline" }, { party_id: 21, source: "advanced" },
 ]);
 expect(await audits("doctor.commission.update")).toBe(commissionAudits + 2);
 expect(await lastAudit()).toMatchObject({ details: { changes: { clinicianPartyId: [20, 21] }, sessionsRevoked: true } });
 // An inactive or unknown doctor is refused whole; nothing moves.
 const before = await row(3), historyCount = history.length;
 expect(await refusal(save(owner, 3, await version(owner, 3), { clinicianPartyId: 22 }))).toMatchObject({ status: 422, code: "invalid-clinician" });
 expect(await refusal(save(owner, 3, await version(owner, 3), { clinicianPartyId: 999 }))).toMatchObject({ status: 422, code: "invalid-clinician" });
 expect(await row(3)).toEqual(before);
 expect(Number((await pool.query(`SELECT count(*) FROM ${schema}.doctor_commission_history`)).rows[0].count)).toBe(historyCount);
});

it("a stale clinician link is repaired, not activated around: activation alone is refused, activation with the repair succeeds", async () => {
 const owner = await login("synthetic-owner", "owner-pass");
 const v = await version(owner, 7);
 expect(await refusal(save(owner, 7, v, { active: true }))).toMatchObject({ status: 409, code: "stale-clinician-link" });
 expect((await row(7)).is_active).toBe(false);
 expect(await save(owner, 7, v, { active: true, clinicianPartyId: 20 })).toMatchObject({ active: true, clinicianPartyId: 20, clinicianLink: "active" });
 expect(await admit(await login("synthetic-stale-link", "stale-pass"))).toMatchObject({ clinicianPartyId: 20 });
 expect(await lastAudit()).toMatchObject({ details: { changes: { active: [false, true], clinicianPartyId: [22, 20] } } });
});

it("audit failure rolls the account write back with it", async () => {
 const manager = await login("synthetic-manager", "manager-pass");
 const target = await login("synthetic-reception", "reception-pass");
 const before = await row(4), count = await audits();
 await pool.query(`ALTER TABLE ${schema}.audit_log ADD CONSTRAINT synthetic_account_audit_block CHECK (action<>'staff.account.update') NOT VALID`);
 try {
  await expect(save(manager, 4, await version(manager, 4), { active: false })).rejects.toThrow();
 } finally { await pool.query(`ALTER TABLE ${schema}.audit_log DROP CONSTRAINT synthetic_account_audit_block`); }
 expect([await row(4), await audits()]).toEqual([before, count]);
 expect(await admit(target)).not.toBeNull();
});

it("a request in flight by the target serializes against the exclusive fence: before it completes on old authority, after it is refused", async () => {
 const manager = await login("synthetic-manager", "manager-pass");
 const target = await login("synthetic-reception", "reception-pass");
 // 1. The target's admitted operation holds the shared fence: the deactivation waits for it.
 let release!: () => void;
 const held = new Promise<void>(resolve => { release = resolve; });
 let pid = 0;
 const inFlight = withStaffOperation(pool, target, "appointments.create", async c => {
  pid = (await c.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
  await held;
  return "completed-on-old-authority";
 }, schema);
 while (!pid) await new Promise(resolve => setTimeout(resolve, 5));
 const writer = save(manager, 4, await version(manager, 4), { active: false });
 expect((await waitForBlockedBy(pool, pid, 10_000)).length).toBeGreaterThan(0);
 expect((await row(4)).is_active).toBe(true);
 release();
 expect(await inFlight).toBe("completed-on-old-authority");
 expect(await writer).toMatchObject({ active: false });
 // 2. Writer queued first behind a holder, the target's request queued after it: the request is refused.
 const v = await version(manager, 4);
 await save(manager, 4, v, { active: true });
 const fresh = await login("synthetic-reception", "reception-pass");
 const v2 = await version(manager, 4);
 const holder = await pool.connect();
 await holder.query("BEGIN");
 const holderPid = (await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
 await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [fence()]);
 const queuedWriter = save(manager, 4, v2, { active: false });
 queuedWriter.catch(() => undefined);
 let queuedRequest!: Promise<unknown>;
 try {
  expect((await waitForBlockedBy(pool, holderPid, 10_000)).length).toBe(1);
  queuedRequest = withStaffOperation(pool, fresh, "appointments.create", async () => "should-not-run", schema);
  queuedRequest.catch(() => undefined);
  const deadline = performance.now() + 10_000;
  while ((await waitForBlockedBy(pool, holderPid, 10_000)).length < 2) {
   if (performance.now() > deadline) throw new Error("request did not queue");
   await new Promise(resolve => setTimeout(resolve, 10));
  }
 } finally { await holder.query("COMMIT"); holder.release(); }
 expect(await queuedWriter).toMatchObject({ active: false });
 await expect(queuedRequest).rejects.toThrow(/^STAFF_OPERATION_/);
 // Restore for isolation.
 await save(manager, 4, await version(manager, 4), { active: true });
});

it("refusals carry Arabic messages and map through the shared HTTP refusal", async () => {
 const manager = await login("synthetic-manager", "manager-pass");
 const error = await refusal(save(manager, 1, "0".repeat(64), { active: false }));
 expect(error).toBeInstanceOf(StaffCapabilityEditError);
 expect((error as Error).message).toMatch(/[؀-ۿ]/);
});
