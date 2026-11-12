/** Synthetic trusted-ready evidence ONLY for the canonical permission editor and
 * session admission. No owner provenance, activation or live grant is implied. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
 // Owner decision on initial grants (Dot 6494187100 items 2–3).
 { id: 6, username: "synthetic-pending", role: "reception", password: "pending-pass", confirmation: "pending", patientScope: "all", grants: { "staff.view": true } },
 { id: 7, username: "synthetic-doctor-manager", role: "doctor", password: "docmanager-pass", partyId: 21, patientScope: "own", appointmentScope: "own",
   grants: { "staff.view": true, "staff.permissions.edit": true, "clinical.plans.view": true } },
 { id: 8, username: "synthetic-restricted-doctor", role: "doctor", password: "restricted-pass", partyId: 22, patientScope: "own", appointmentScope: "own",
   grants: { "clinical.plans.view": true, "clinical.visits.document": true } },
 { id: 9, username: "synthetic-doctor-title", role: "doctor", password: "title-pass", partyId: 23, grants: {} },
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

beforeAll(async () => { await installSyntheticCanonicalFixture(pool, schema, { ownerId: 1, accounts, doctorParties: [20, 21, 22, 23] }); });
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

describe("initial owner confirmation (Dot 6494187100 item 2)", () => {
 it("a pending account's grants and scopes are not effective, whatever the document holds", async () => {
  expect(await admit(await login("synthetic-pending", "pending-pass"))).toMatchObject({ capabilities: [], patientScope: "none", appointmentScope: "none" });
  await expect(withStaffOperation(pool, await login("synthetic-pending", "pending-pass"), "staff.view", async () => "read", schema)).rejects.toThrow("STAFF_OPERATION_CAPABILITY_DENIED");
 });
 it("a delegated manager can neither edit nor confirm a pending account; the screen says why", async () => {
  const manager = await login("synthetic-manager", "manager-pass");
  expect(await readStaffCapabilityTargetIn(pool, schema, manager, 6)).toMatchObject({ confirmation: "pending", editable: false, delegable: [] });
  const before = await audits(), r = await revision(6);
  const refused = await refusal(edit(manager, { targetUserId: 6, expectedRevision: r, patientScope: "none", appointmentScope: "none", grants: { "staff.view": true } }));
  expect(refused).toMatchObject({ status: 403, code: "initial-owner-confirmation-required" });
  expect((refused as Error).message).toMatch(/[؀-ۿ]/);
  // Revocation-only saves are the owner's too.
  expect(await refusal(edit(manager, { targetUserId: 6, expectedRevision: r, patientScope: "none", appointmentScope: "none", grants: {} }))).toMatchObject({ code: "initial-owner-confirmation-required" });
  expect([await revision(6), await audits()]).toEqual([r, before]);
 });
 it("the owner's save is the confirmation: audited, the old session falls, the grants become effective", async () => {
  const owner = await login("synthetic-owner", "owner-pass");
  const pendingSession = await login("synthetic-pending", "pending-pass");
  expect(await readStaffCapabilityTargetIn(pool, schema, owner, 6)).toMatchObject({ confirmation: "pending", editable: true });
  const r = await revision(6);
  expect(await edit(owner, { targetUserId: 6, expectedRevision: r, patientScope: "all", appointmentScope: "none", grants: { "staff.view": true } }))
   .toMatchObject({ confirmation: "owner", revision: r + 1, grants: ["staff.view"] });
  const { rows: [audit] } = await pool.query(`SELECT actor, details FROM ${schema}.audit_log WHERE action='staff.capabilities.update' ORDER BY id DESC LIMIT 1`);
  expect(audit).toMatchObject({ actor: "synthetic-owner", details: { confirmation: ["pending", "owner"], confirmedByThisSave: true } });
  expect(await admit(pendingSession)).toBeNull();
  expect(await admit(await login("synthetic-pending", "pending-pass"))).toMatchObject({ capabilities: ["staff.view"], patientScope: "all" });
  // Later delegated maintenance of the now confirmed account works within the delegate's authority.
  const manager = await login("synthetic-manager", "manager-pass");
  expect(await edit(manager, { targetUserId: 6, expectedRevision: r + 1, patientScope: "all", appointmentScope: "all", grants: { "staff.view": true, "appointments.create": true } }))
   .toMatchObject({ confirmation: "owner", grants: ["appointments.create", "staff.view"] });
 });
});

describe("restricted doctors and doctor-managers (Dot 6494187100 item 3)", () => {
 it("a doctor-manager maintains only within its own authority: no grant it lacks, no 'own' scope it cannot vouch for", async () => {
  const docManager = await login("synthetic-doctor-manager", "docmanager-pass");
  const r = await revision(8);
  expect(await refusal(edit(docManager, { targetUserId: 8, expectedRevision: r, patientScope: "own", appointmentScope: "own", grants: { "clinical.plans.view": true } })))
   .toMatchObject({ code: "outside-delegable-authority" });
  expect(await refusal(edit(docManager, { targetUserId: 8, expectedRevision: r, patientScope: "none", appointmentScope: "none", grants: { "clinical.plans.view": true, "clinical.visits.sign": true, "clinical.visits.document": true } })))
   .toMatchObject({ code: "outside-delegable-authority" });
  expect(await revision(8)).toBe(r);
 });
 it("a doctor title, or an admin title, alone grants nothing", async () => {
  const titled = await login("synthetic-doctor-title", "title-pass");
  expect(await admit(titled)).toMatchObject({ capabilities: [], patientScope: "none", clinicianPartyId: 23 });
  await expect(readStaffCapabilityTargetIn(pool, schema, titled, 8)).rejects.toThrow("STAFF_OPERATION_CAPABILITY_DENIED");
 });
 it("hiding the clinical module of a restricted doctor: the live session falls, the fresh one has no clinical grant and keeps its scopes", async () => {
  const owner = await login("synthetic-owner", "owner-pass");
  const doctor = await login("synthetic-restricted-doctor", "restricted-pass");
  expect(await admit(doctor)).toMatchObject({ capabilities: ["clinical.plans.view", "clinical.visits.document"], patientScope: "own" });
  const r = await revision(8);
  await edit(owner, { targetUserId: 8, expectedRevision: r, patientScope: "own", appointmentScope: "own", grants: {} });
  expect(await admit(doctor)).toBeNull();
  await expect(withStaffOperation(pool, doctor, "staff.view", async () => "x", schema)).rejects.toThrow(/^STAFF_OPERATION_/);
  expect(await admit(await login("synthetic-restricted-doctor", "restricted-pass"))).toMatchObject({ capabilities: [], patientScope: "own", appointmentScope: "own" });
  // Restore for the following tests.
  await edit(owner, { targetUserId: 8, expectedRevision: r + 1, patientScope: "own", appointmentScope: "own", grants: { "clinical.plans.view": true, "clinical.visits.document": true } });
 });
 async function queued<T>(order: (() => Promise<T>)[]) {
  // Hold the exclusive lifecycle fence, queue the writers in a known order, then release.
  const holder = await pool.connect();
  await holder.query("BEGIN");
  const holderPid = (await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
  await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [fence()]);
  const results: Promise<T>[] = [];
  try {
   for (const [index, start] of order.entries()) {
    const promise = start(); promise.catch(() => undefined); results.push(promise);
    const deadline = performance.now() + 10_000;
    while ((await waitForBlockedBy(pool, holderPid, 10_000)).length < index + 1) {
     if (performance.now() > deadline) throw new Error("writer did not queue");
     await new Promise(resolve => setTimeout(resolve, 10));
    }
   }
  } finally { await holder.query("COMMIT"); holder.release(); }
  return Promise.allSettled(results);
 }
 it("revocation during a doctor-manager's pending save: whichever reaches the fence first decides, never a mix", async () => {
  const owner = await login("synthetic-owner", "owner-pass");
  // 1. The manager's save is queued first: it completes under its authority, then the revocation lands.
  let docManager = await login("synthetic-doctor-manager", "docmanager-pass");
  let r9 = await revision(9), r7 = await revision(7);
  const first = await queued<unknown>([
   () => edit(docManager, { targetUserId: 9, expectedRevision: r9, patientScope: "none", appointmentScope: "none", grants: { "clinical.plans.view": true } }),
   () => edit(owner, { targetUserId: 7, expectedRevision: r7, patientScope: "own", appointmentScope: "own", grants: { "staff.view": true, "clinical.plans.view": true } }),
  ]);
  expect(first.map(outcome => outcome.status)).toEqual(["fulfilled", "fulfilled"]);
  expect(await revision(9)).toBe(r9 + 1);
  expect(await admit(docManager)).toBeNull();
  await expect(edit(await login("synthetic-doctor-manager", "docmanager-pass"), { targetUserId: 9, expectedRevision: r9 + 1, patientScope: "none", appointmentScope: "none", grants: {} }))
   .rejects.toThrow("STAFF_OPERATION_CAPABILITY_DENIED");
  // 2. Grant back, then queue the revocation first: the manager's pending save is refused and writes nothing.
  r7 = await revision(7);
  await edit(owner, { targetUserId: 7, expectedRevision: r7, patientScope: "own", appointmentScope: "own", grants: { "staff.view": true, "staff.permissions.edit": true, "clinical.plans.view": true } });
  docManager = await login("synthetic-doctor-manager", "docmanager-pass");
  r9 = await revision(9); r7 = await revision(7);
  const before = await audits();
  const second = await queued<unknown>([
   () => edit(owner, { targetUserId: 7, expectedRevision: r7, patientScope: "own", appointmentScope: "own", grants: { "staff.view": true, "clinical.plans.view": true } }),
   () => edit(docManager, { targetUserId: 9, expectedRevision: r9, patientScope: "none", appointmentScope: "none", grants: {} }),
  ]);
  expect(second[0].status).toBe("fulfilled");
  expect(second[1]).toMatchObject({ status: "rejected", reason: { message: expect.stringMatching(/^STAFF_OPERATION_(CREDENTIAL_OR_ACCOUNT_STALE|PERMISSIONS_STALE|CAPABILITY_DENIED)$/) } });
  expect(await revision(9)).toBe(r9);
  expect(await audits()).toBe(before + 1);
 });
});
