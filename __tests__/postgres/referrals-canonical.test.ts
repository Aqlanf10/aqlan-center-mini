/** M2 slice 73: canonical referrals on real PostgreSQL, synthetic data only.
 * clinical.referrals.manage inside the patient scope; the clinician link issues;
 * the internal workflow by the receiving / referring clinician (schedule: also the whole
 * appointment scope; owner: every step); create idempotent by request key; the audit row
 * commits with each write; revocation and concurrency. */
vi.mock("server-only", () => ({}));
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
assertRealPostgresUrl();
stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-canonical-referrals-2026");
const db = await import("../../lib/db");
const ref = await import("../../lib/canonical-referrals");

const MANAGE = { "clinical.referrals.manage": true } as const;
const ACCOUNTS = {
  owner: { username: "SYN-REF-OWNER", role: "admin" },
  referrer: { username: "SYN-REF-A", role: "doctor", doctor: true, patientScope: "own", appointmentScope: "own", grants: { ...MANAGE } },
  receiver: { username: "SYN-REF-B", role: "doctor", doctor: true, patientScope: "own", appointmentScope: "own", grants: { ...MANAGE } },
  desk: { username: "SYN-REF-DESK", role: "reception", patientScope: "all", appointmentScope: "all", grants: { ...MANAGE } },
  deskOwnAppointments: { username: "SYN-REF-DESK2", role: "reception", patientScope: "all", appointmentScope: "none", grants: { ...MANAGE } },
  noGrant: { username: "SYN-REF-NOGRANT", role: "doctor", doctor: true, patientScope: "all", appointmentScope: "all", grants: {} },
} as const;
type Key = keyof typeof ACCOUNTS;
let fx: CanonicalInventoryDatabase<Key>;
const q = async (sql: string, args: unknown[] = []) => (await fx.pool.query(sql, args)).rows;
const refusal = (promise: Promise<unknown>) => promise.then(() => null, (error: { code?: string; status?: number; message?: string }) => error);
const key = () => `syn-referral-key-${Math.random().toString(36).slice(2)}-${Date.now()}`;
const ids = { mine: 0, other: 0 };
const internal = (toPartyId: number) => ({ requestKey: key(), kind: "internal", toPartyId, toSpecialty: "endodontics", reason: "علاج عصب اصطناعي", urgency: "routine" });

beforeAll(async () => {
  fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner");
  const patient = async (number: string, doctor: number | null) =>
    (await q("INSERT INTO patients(patient_number,full_name,phone,primary_doctor_id) VALUES ($1,$2,'0500000970',$3) RETURNING id", [number, `SYN Ref ${number}`, doctor]))[0].id as number;
  ids.mine = await patient("SYN-REF-1", fx.parties.referrer!);
  ids.other = await patient("SYN-REF-2", null);
}, 180_000);
afterAll(async () => { await fx?.close(); });

describe("issue", () => {
  it("the clinician link issues; a double press makes one referral; a reused key is refused; the audit commits with it", async () => {
    const referrer = await fx.session("referrer");
    const body = internal(fx.parties.receiver!);
    const [a, b] = await Promise.all([ref.commandCanonicalReferralCreate(referrer, String(ids.mine), body), ref.commandCanonicalReferralCreate(await fx.session("referrer"), String(ids.mine), body)]);
    expect(a.id).toBe(b.id);
    expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
    expect(a).toMatchObject({ kind: "internal", workflowState: "requested", doctorPartyId: fx.parties.referrer, toPartyId: fx.parties.receiver });
    expect(await refusal(ref.commandCanonicalReferralCreate(referrer, String(ids.mine), { ...body, reason: "سبب آخر" }))).toMatchObject({ code: "referral_request_key_reused", status: 409 });
    expect((await q("SELECT actor FROM audit_log WHERE action='referral.create' AND details->>'requestKey'=$1", [body.requestKey])).map(row => row.actor)).toEqual(["SYN-REF-A"]);
  });
  it("refuses an actor without a clinician link, a patient outside the scope and a self referral, writing nothing", async () => {
    const before = (await q("SELECT count(*)::int AS n FROM patient_referrals"))[0].n;
    expect(await refusal(ref.commandCanonicalReferralCreate(await fx.session("desk"), String(ids.mine), internal(fx.parties.receiver!))))
      .toMatchObject({ code: "referral_issuer_required", status: 403 });
    expect(await refusal(ref.commandCanonicalReferralCreate(await fx.session("referrer"), String(ids.other), internal(fx.parties.receiver!))))
      .toMatchObject({ code: "patient_not_found", status: 404 });
    expect(await refusal(ref.commandCanonicalReferralCreate(await fx.session("referrer"), String(ids.mine), internal(fx.parties.referrer!))))
      .toMatchObject({ code: "invalid_referral", status: 400 });
    await expect(ref.commandCanonicalReferralCreate(await fx.session("noGrant"), String(ids.mine), internal(fx.parties.receiver!))).rejects.toThrow("CAPABILITY_DENIED");
    expect((await q("SELECT count(*)::int AS n FROM patient_referrals"))[0].n).toBe(before);
  });
  it("an external letter and its close commit with their audit rows; a second close is refused", async () => {
    const letter = await ref.commandCanonicalReferralCreate(await fx.session("referrer"), String(ids.mine),
      { requestKey: key(), toName: "عيادة خارجية اصطناعية", toSpecialty: "oral_surgery", reason: "خلع جراحي", urgency: "soon" });
    expect(letter).toMatchObject({ kind: "external", status: "sent" });
    const closed = await ref.commandCanonicalReferralClose(await fx.session("desk"), String(letter.id), { action: "complete", note: "تم" });
    expect(closed).toMatchObject({ status: "completed" });
    expect(await refusal(ref.commandCanonicalReferralClose(await fx.session("desk"), String(letter.id), { action: "cancel", note: "مكرر" })))
      .toMatchObject({ code: "referral_closed", status: 409 });
    expect((await q("SELECT action, actor FROM audit_log WHERE action IN ('referral.create','referral.complete') AND details->>'الإحالة'=$1::text ORDER BY id", [letter.id])))
      .toEqual([{ action: "referral.create", actor: "SYN-REF-A" }, { action: "referral.complete", actor: "SYN-REF-DESK" }]);
  });
});

describe("internal workflow", () => {
  async function fresh() {
    return ref.commandCanonicalReferralCreate(await fx.session("referrer"), String(ids.mine), internal(fx.parties.receiver!));
  }
  it("accept and complete by the receiver; acknowledge by the referrer; the wrong side is refused", async () => {
    const referral = await fresh();
    expect(await refusal(ref.commandCanonicalReferralTransition(await fx.session("referrer"), String(referral.id), { action: "accept" })))
      .toMatchObject({ code: "referral_step_forbidden", status: 403 });
    expect(await ref.commandCanonicalReferralTransition(await fx.session("receiver"), String(referral.id), { action: "accept" })).toMatchObject({ workflowState: "accepted" });
    expect(await refusal(ref.commandCanonicalReferralTransition(await fx.session("receiver"), String(referral.id), { action: "acknowledge" })))
      .toMatchObject({ status: 403 });
    expect(await ref.commandCanonicalReferralTransition(await fx.session("receiver"), String(referral.id), { action: "complete", procedurePerformed: "حشوة عصب" }))
      .toMatchObject({ workflowState: "completed" });
    expect(await ref.commandCanonicalReferralTransition(await fx.session("referrer"), String(referral.id), { action: "acknowledge" })).toMatchObject({ workflowState: "returned_to_referrer" });
    expect(await refusal(ref.commandCanonicalReferralTransition(await fx.session("referrer"), String(referral.id), { action: "cancel", note: "متأخر" })))
      .toMatchObject({ code: "referral_invalid_transition", status: 409 });
  });
  it("cancel by the referrer only; the desk without a clinician link may schedule only with the whole appointment scope", async () => {
    const referral = await fresh();
    expect(await refusal(ref.commandCanonicalReferralTransition(await fx.session("desk"), String(referral.id), { action: "cancel", note: "سبب" })))
      .toMatchObject({ code: "referral_step_forbidden" });
    const appointment = (await q(`INSERT INTO appointments(patient_id,scheduled_date,scheduled_time,duration_minutes,status,doctor_id)
      VALUES ($1,'2031-02-01','10:00',30,'booked',$2) RETURNING id`, [ids.mine, fx.parties.receiver]))[0].id as number;
    expect(await refusal(ref.commandCanonicalReferralTransition(await fx.session("deskOwnAppointments"), String(referral.id), { action: "schedule", appointmentId: appointment })))
      .toMatchObject({ code: "referral_step_forbidden" });
    expect(await ref.commandCanonicalReferralTransition(await fx.session("desk"), String(referral.id), { action: "schedule", appointmentId: appointment }))
      .toMatchObject({ workflowState: "scheduled" });
    expect((await q("SELECT referral_id FROM appointments WHERE id=$1", [appointment]))[0].referral_id).toBe(referral.id);
    expect(await ref.commandCanonicalReferralTransition(await fx.session("referrer"), String(referral.id), { action: "cancel", note: "لم يعد لازمًا" }))
      .toMatchObject({ workflowState: "cancelled" });
  });
  it("a referral outside the scope reads as missing (no kind or state disclosed); two concurrent accepts: one wins", async () => {
    const otherRef = (await q(`INSERT INTO patient_referrals(patient_id,to_name,to_specialty,reason,urgency,created_by,kind,to_party_id,workflow_state,doctor_party_id)
      VALUES ($1,'SYN','endodontics','x','routine','synthetic','internal',$2,'requested',NULL) RETURNING id`, [ids.other, fx.parties.noGrant]))[0].id as number;
    expect(await refusal(ref.commandCanonicalReferralTransition(await fx.session("referrer"), String(otherRef), { action: "accept" })))
      .toMatchObject({ code: "referral_not_found", status: 404 });
    expect(await refusal(ref.commandCanonicalReferralClose(await fx.session("referrer"), String(otherRef), { action: "complete" })))
      .toMatchObject({ code: "referral_not_found", status: 404 });
    const referral = await fresh();
    const results = await Promise.allSettled([
      ref.commandCanonicalReferralTransition(await fx.session("receiver"), String(referral.id), { action: "accept" }),
      ref.commandCanonicalReferralTransition(await fx.session("receiver"), String(referral.id), { action: "accept" }),
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect((results.find(result => result.status === "rejected") as PromiseRejectedResult).reason).toMatchObject({ code: "referral_invalid_transition" });
    expect((await q("SELECT count(*)::int AS n FROM audit_log WHERE action='referral.accept' AND details->>'الإحالة'=$1::text", [referral.id]))[0].n).toBe(1);
  });
  it("the owner may take every step; a revoked session is refused and nothing is written", async () => {
    const referral = await fresh();
    expect(await ref.commandCanonicalReferralTransition(await fx.session("owner"), String(referral.id), { action: "accept" })).toMatchObject({ workflowState: "accepted" });
    const issued = await fx.session("receiver");
    await fx.setGrants("receiver", {}, { patientScope: "own", appointmentScope: "own" });
    try {
      await expect(ref.commandCanonicalReferralTransition(issued, String(referral.id), { action: "complete", procedurePerformed: "حشوة" })).rejects.toThrow(/CREDENTIAL_OR_ACCOUNT|CAPABILITY_DENIED/);
    } finally { await fx.setGrants("receiver", { ...MANAGE }, { patientScope: "own", appointmentScope: "own" }); }
    expect((await q("SELECT workflow_state FROM patient_referrals WHERE id=$1", [referral.id]))[0].workflow_state).toBe("accepted");
  });
});

describe("mine", () => {
  it("lists by the clinician link inside the scope, with the receivers directory; no link → empty lists", async () => {
    const receiver = await ref.readCanonicalMyReferrals(await fx.session("receiver"));
    expect(receiver.canIssue).toBe(true);
    expect(receiver.toMe.every(row => row.toPartyId === fx.parties.receiver)).toBe(true);
    expect(receiver.toMe.length).toBeGreaterThan(0);
    expect(receiver.receivers.map(row => row.id)).toContain(fx.parties.referrer);
    expect(receiver.receivers.map(row => row.id)).not.toContain(fx.parties.receiver);
    expect(await ref.readCanonicalMyReferrals(await fx.session("desk"))).toMatchObject({ toMe: [], sentOpen: [], returnedToMe: [], today: [], canIssue: false });
    await expect(ref.readCanonicalMyReferrals(await fx.session("noGrant"))).rejects.toThrow("CAPABILITY_DENIED");
  });
});
