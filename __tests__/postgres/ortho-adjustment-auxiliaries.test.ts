// Real PostgreSQL and the real POST /api/ortho/[id] route (owner #483; migration 0132 allocated in #483 6867852606).
// Only the framework markers are stubbed. Synthetic data only.
vi.mock("server-only", () => ({}));

import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, createIsolatedDatabase, stubPostgresEnv } from "./_setup";
import { AUXILIARY_LIST_ERROR, AUXILIARY_OTHER_TOO_LONG } from "../../lib/ortho-auxiliaries";
const context = vi.hoisted(() => ({ token: "" }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => name === "aqlan_flow_session" ? { value: context.token } : undefined }),
  headers: async () => new Headers(),
}));
assertRealPostgresUrl(); stubPostgresEnv();
process.env.DATABASE_URL = await createIsolatedDatabase("aqlan_ortho_adjustment_auxiliaries_test");
const db = await import("../../lib/db"), auth = await import("../../lib/auth");
const { POST } = await import("../../app/api/ortho/[id]/route");
const q = async <T = Record<string, unknown>>(sql: string, values: unknown[] = []) => (await db.getPool().query(sql, values)).rows as T[];
const tokens: Record<string, string> = {};
const actors: Record<string, number> = {};
let serial = 0;

async function user(name: string, role: string) {
  const passwordHash = await auth.hashPassword(`synthetic-${name}`);
  const [{ id }] = await q<{ id: number }>(`INSERT INTO users(username,display_name,password_hash,role)
    VALUES ($1,$1,$2,$3) RETURNING id`, [name, passwordHash, role]);
  actors[name] = id;
  tokens[name] = auth.createSessionToken({ userId: id, username: name, role: role as "admin",
    expiresAt: Date.now() + 3_600_000, credentialVersion: auth.sessionCredentialVersion(passwordHash) });
}
beforeAll(async () => {
  await db.ensureSchema();
  await user("syn-aux-admin", "admin");
  await user("syn-aux-doctor", "doctor");
});
afterAll(async () => { await db.resetPoolForTesting(); });

async function fixture() {
  const [patient] = await q<{ id: number }>("INSERT INTO patients(patient_number,full_name) VALUES($1,'SYN auxiliaries patient') RETURNING id", [`SYN-AUX-${++serial}`]);
  const created = await db.createOrthoCase({ patientId: patient.id, appliance: "fixed_metal", arches: "both", slot: "022",
    bracketSystem: null, startDate: "2026-10-01", plannedMonths: 18, planId: null, note: null, createdBy: "syn-aux-admin" });
  if (!created.ok) throw new Error(created.message);
  return { patientId: patient.id, caseId: created.id };
}
const base = { doneOn: "2026-10-02", upperWire: "016 NiTi", lowerWire: "", elastics: "none", elasticNote: "", done: "SYN session", nextWeeks: 4 };
function send(caseId: number, key: string, body: object, as = "syn-aux-admin") {
  context.token = tokens[as];
  return POST(new Request(`https://synthetic.invalid/api/ortho/${caseId}`, {
    method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(body),
  }), { params: Promise.resolve({ id: String(caseId) }) });
}
const footprint = async (caseId: number) => (await q(`SELECT
  (SELECT count(*) FROM ortho_adjustments WHERE case_id=$1)::int AS adjustments,
  (SELECT count(*) FROM ortho_adjustment_requests WHERE case_id=$1)::int AS commands,
  (SELECT count(*) FROM audit_log WHERE action='ortho.adjustment')::int AS audits`, [caseId]))[0];
const stored = async (caseId: number) => q("SELECT auxiliaries, auxiliary_other FROM ortho_adjustments WHERE case_id=$1 ORDER BY id", [caseId]);

describe("auxiliaries through the real route", () => {
  it("saves and reopens «not recorded», an explicit «none» and a list with «آخر» as three distinct states", async () => {
    const f = await fixture();
    expect((await send(f.caseId, "syn-aux-state-none-recorded", base)).status).toBe(201);
    expect((await send(f.caseId, "syn-aux-state-explicit-none", { ...base, auxiliaries: [] })).status).toBe(201);
    expect((await send(f.caseId, "syn-aux-state-list-other-01", { ...base, auxiliaries: ["other", "tad", "power_chain"], auxiliaryOther: " SYN Pendulum " })).status).toBe(201);
    expect(await stored(f.caseId)).toEqual([
      { auxiliaries: null, auxiliary_other: null },
      { auxiliaries: [], auxiliary_other: null },
      { auxiliaries: ["tad", "power_chain", "other"], auxiliary_other: "SYN Pendulum" },
    ]);
    // Reopen: the case read used by the session screen returns the same three states, newest first.
    const reopened = await db.getOrthoCase(f.caseId, "2026-10-02");
    expect(reopened?.adjustments.map((row) => [row.auxiliaries, row.auxiliaryOther])).toEqual([
      [["tad", "power_chain", "other"], "SYN Pendulum"], [[], null], [null, null]]);
    const clinical = await db.getOrthoClinicalDetailWith(db.getPool(), f.caseId, null, "2026-10-02");
    expect(clinical?.adjustments.map((row) => row.auxiliaries)).toEqual([["tad", "power_chain", "other"], [], null]);
    const audit = await q<{ details: Record<string, unknown> }>("SELECT details FROM audit_log WHERE action='ortho.adjustment' ORDER BY id DESC LIMIT 1");
    expect(audit[0].details).toMatchObject({ الأجهزة_المساعدة: "tad، power_chain، other", جهاز_مساعد_آخر: "SYN Pendulum" });
  });

  it.each([
    ["an unknown key", { auxiliaries: ["headgear"] }, AUXILIARY_LIST_ERROR],
    ["a duplicate", { auxiliaries: ["tpa", "tpa"] }, AUXILIARY_LIST_ERROR],
    ["an over-long «آخر»", { auxiliaries: ["other"], auxiliaryOther: "x".repeat(81) }, AUXILIARY_OTHER_TOO_LONG],
  ])("refuses %s with 400 before any write", async (_label, extra, message) => {
    const f = await fixture(); const before = await footprint(f.caseId);
    const response = await send(f.caseId, `syn-aux-refused-${serial}`, { ...base, ...extra });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: "invalid_adjustment_auxiliaries", message });
    expect(await footprint(f.caseId)).toEqual(before);
  });

  it("replays a lost response once, and refuses the same key with a changed list without writing", async () => {
    const f = await fixture(); const body = { ...base, auxiliaries: ["hyrax_marpe"] };
    const first = await send(f.caseId, "syn-aux-replay-key-0001", body); expect(first.status).toBe(201);
    const id = (await first.json()).id; const before = await footprint(f.caseId);
    const replay = await send(f.caseId, "syn-aux-replay-key-0001", body);
    expect(replay.status).toBe(200); expect(await replay.json()).toMatchObject({ id, existing: true, replayed: true });
    for (const changed of [{ ...base, auxiliaries: ["nance_button"] }, { ...base, auxiliaries: [] }, base]) {
      const conflict = await send(f.caseId, "syn-aux-replay-key-0001", changed);
      expect(conflict.status).toBe(409);
    }
    expect(await footprint(f.caseId)).toEqual(before);
    expect(await stored(f.caseId)).toEqual([{ auxiliaries: ["hyrax_marpe"], auxiliary_other: null }]);
  });

  it("keeps the earlier request fingerprint when no auxiliaries are sent", async () => {
    const f = await fixture();
    expect((await send(f.caseId, "syn-aux-legacy-hash-01", base)).status).toBe(201);
    const [{ request_hash }] = await q<{ request_hash: string }>("SELECT request_hash FROM ortho_adjustment_requests WHERE case_id=$1", [f.caseId]);
    const v1 = createHash("sha256").update(JSON.stringify({ version: 1, actorId: actors["syn-aux-admin"], patientId: f.patientId,
      caseId: f.caseId, visitId: null, doneOn: base.doneOn, phase: null, upperWire: "016 NiTi", lowerWire: null, elastics: "none",
      elasticNote: null, done: "SYN session", nextWeeks: 4, note: null })).digest("hex");
    expect(request_hash).toBe(v1);
  });

  it("refuses a clinician outside the patient's scope before any write", async () => {
    const f = await fixture(); const before = await footprint(f.caseId);
    const response = await send(f.caseId, "syn-aux-foreign-doctor-1", { ...base, auxiliaries: ["tpa"] }, "syn-aux-doctor");
    expect(response.status).toBe(403);
    expect(await footprint(f.caseId)).toEqual(before);
  });
});

describe("0132 storage contract", () => {
  it("is registered once and survives a second initialisation unchanged", async () => {
    await db.ensureSchema();
    expect(await q("SELECT version, name FROM schema_migrations WHERE version='0132'")).toEqual([{ version: "0132", name: "ortho_adjustment_auxiliaries" }]);
    expect(await q(`SELECT column_name, is_nullable, column_default FROM information_schema.columns
      WHERE table_name='ortho_adjustments' AND column_name IN ('auxiliaries','auxiliary_other') ORDER BY column_name`)).toEqual([
      { column_name: "auxiliaries", is_nullable: "YES", column_default: null },
      { column_name: "auxiliary_other", is_nullable: "YES", column_default: null }]);
  });
  it("accepts only the server's normalized shapes", async () => {
    const f = await fixture();
    const insert = (list: string | null, other: string | null) => db.getPool().query(
      "INSERT INTO ortho_adjustments(case_id,recorded_by,auxiliaries,auxiliary_other) VALUES($1,'SYN',$2::text[],$3)", [f.caseId, list, other]);
    for (const [list, other] of [[null, null], ["{}", null], ["{tpa,quad_helix}", null], ["{tad,other}", "SYN"]] as const) {
      await expect(insert(list, other)).resolves.toBeDefined();
    }
    for (const [list, other] of [
      [null, "SYN"], ["{}", "SYN"], ["{headgear}", null], ["{tpa,tpa}", null], ["{quad_helix,tpa}", null], ["{other}", null],
      ["{tpa}", "SYN"], ["{other}", " SYN"], ["{other}", ""], ["{other}", "x".repeat(81)], ["{{tpa}}", null], ["{tpa,NULL}", null],
    ] as const) {
      await expect(insert(list, other), `${list} / ${other}`).rejects.toMatchObject({ code: "23514" });
    }
  });
});
