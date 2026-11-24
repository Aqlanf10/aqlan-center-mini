import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

const session = vi.hoisted(() => ({ userId: 41, username: "fixture-registration", role: "admin" }));
vi.mock("@/lib/session", () => ({ requireSession: async () => session }));

const url = assertRealPostgresUrl();
stubPostgresEnv();
const { ensureSchema, getPool, resetPoolForTesting } = await import("../../lib/db");
const { POST } = await import("../../app/api/patients/route");
const pool = getPool();
const openingBalance = { amount: "87", currency: "YER", asOfDate: "2025-02-13" };

function send(key: string, body: Record<string, unknown>) {
  return POST(new Request("http://fixture.invalid/api/patients", {
    method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key },
    body: JSON.stringify(body),
  }));
}
async function cursor() {
  return (await pool.query("SELECT last_value::text, is_called FROM patient_number_seq")).rows[0];
}

beforeAll(async () => { await dropPublicSchema(url); await ensureSchema(); });
beforeEach(() => { Object.assign(session, { userId: 41, username: "fixture-registration", role: "admin" }); });
afterAll(resetPoolForTesting);

it("replays a confirmed registration after commit, through a retry without the duplicate override", async () => {
  const body = { fullName: "Synthetic Iris Receipt", phone: "772621914", openingBalance };
  expect((await send("fixture-relative", { fullName: "Synthetic Daisy Relative", phone: body.phone })).status).toBe(201);
  const beforeReview = await cursor();
  expect((await send("fixture-lost", body)).status).toBe(409);
  expect(await cursor()).toEqual(beforeReview);
  const [a, b] = await Promise.all([send("fixture-lost", { ...body, confirmDuplicate: true }),
    send("fixture-lost", { ...body, confirmDuplicate: true })]);
  expect([a.status, b.status]).toEqual([201, 201]);
  const first = await a.json();
  expect(await b.json()).toEqual(first);
  const committed = await cursor();
  expect(BigInt(committed.last_value)).toBe(BigInt(beforeReview.last_value) + 1n);
  // Later edits are never returned in a registration acknowledgment.
  await pool.query("UPDATE patients SET medical_alert='Synthetic later clinical edit' WHERE id=$1", [first.id]);
  const retry = await send("fixture-lost", body);
  expect(retry.status).toBe(201);
  expect(await retry.json()).toEqual(first);
  expect(Object.keys(first).sort()).toEqual(["fullName", "id", "patientNumber", "phone"]);
  for (const changed of [{ fullName: "Synthetic Other" }, { openingBalance: { ...openingBalance, amount: "88" } }]) {
    expect((await send("fixture-lost", { ...body, ...changed, confirmDuplicate: true })).status).toBe(409);
  }
  expect(await cursor()).toEqual(committed);
  expect((await pool.query("SELECT id FROM patients WHERE full_name=$1", [body.fullName])).rows).toEqual([{ id: first.id }]);
  expect((await pool.query("SELECT amount_minor::text FROM patient_opening_balances WHERE patient_id=$1", [first.id])).rows)
    .toEqual([{ amount_minor: "87" }]);
  expect((await pool.query("SELECT action FROM patient_opening_balance_history WHERE patient_id=$1", [first.id])).rows)
    .toEqual([{ action: "set" }]);
  expect((await pool.query("SELECT action FROM audit_log WHERE entity='patient' AND entity_id=$1 ORDER BY id", [String(first.id)])).rows)
    .toEqual([{ action: "patient.create" }, { action: "opening_balance.set" }]);
});

it("rolls back both writes and the receipt on an audit failure, leaving the consumed number burned", async () => {
  const body = { fullName: "Synthetic Fern Rollback", openingBalance, confirmDuplicate: true };
  await pool.query(`CREATE FUNCTION fixture_reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'synthetic audit failure'; END; $$;
    CREATE TRIGGER fixture_audit_failure BEFORE INSERT ON audit_log
      FOR EACH ROW WHEN (NEW.action='opening_balance.set') EXECUTE FUNCTION fixture_reject_audit()`);
  try {
    expect((await send("fixture-rollback", body)).status).toBe(500);
    expect((await pool.query("SELECT 1 FROM patients WHERE full_name=$1", [body.fullName])).rowCount).toBe(0);
    expect((await pool.query("SELECT 1 FROM audit_log WHERE summary LIKE $1", ["%" + body.fullName + "%"])).rowCount).toBe(0);
  } finally {
    await pool.query("DROP TRIGGER fixture_audit_failure ON audit_log; DROP FUNCTION fixture_reject_audit()");
  }
  const burned = await cursor();
  expect((await send("fixture-rollback", body)).status).toBe(201);
  expect(BigInt((await cursor()).last_value)).toBe(BigInt(burned.last_value) + 1n);
});

it("replays yesterday's default opening date after period close without backdating another balance", async () => {
  const body = { fullName: "Synthetic Cedar Midnight", openingBalance: { amount: "63" }, confirmDuplicate: true };
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(new Date("2025-06-10T20:59:00Z"));
    const first = await send("fixture-midnight", body);
    expect(first.status).toBe(201);
    const patient = await first.json();
    vi.setSystemTime(new Date("2025-06-10T21:01:00Z"));
    await pool.query(`INSERT INTO settings(key,value) VALUES ('finance.locked_before','2025-06-11')
      ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`);
    const retry = await send("fixture-midnight", body);
    expect(retry.status).toBe(201);
    expect(await retry.json()).toEqual(patient);
    const backdated = { ...body, openingBalance: { amount: "63", asOfDate: "2025-06-10" } };
    expect((await send("fixture-new-backdate", backdated)).status).toBe(409);
    expect((await pool.query("SELECT as_of_date::text FROM patient_opening_balances WHERE patient_id=$1", [patient.id])).rows)
      .toEqual([{ as_of_date: "2025-06-10" }]);
  } finally {
    vi.useRealTimers();
    await pool.query("DELETE FROM settings WHERE key='finance.locked_before'");
  }
});

it("scopes keys to the authenticated actor and keeps a deleted registration retired", async () => {
  const key = "fixture-actor";
  const first = await send(key, { fullName: "Synthetic Elm", confirmDuplicate: true });
  expect(first.status).toBe(201);
  const { id } = await first.json();
  session.userId++;
  session.username = "fixture-other-registrar";
  const other = await send(key, { fullName: "Synthetic Maple", confirmDuplicate: true });
  expect(other.status).toBe(201);
  expect((await other.json()).id).not.toBe(id);
  await pool.query("DELETE FROM patients WHERE id=$1", [id]);
  session.userId--;
  session.username = "fixture-registration";
  const before = await cursor();
  expect((await send(key, { fullName: "Synthetic Elm", confirmDuplicate: true })).status).toBe(410);
  expect((await send("bad", { fullName: "Synthetic Ash" })).status).toBe(400);
  expect(await cursor()).toEqual(before);
});

it("rejects a reception opening when the clinic has disabled it, before creating a file", async () => {
  session.role = "reception";
  await pool.query(`INSERT INTO settings(key,value) VALUES ('finance.reception_adds_opening_balance','false')
    ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`);
  const fullName = "Synthetic Unassigned Opening";
  expect((await send("fixture-unassigned", { fullName, openingBalance, confirmDuplicate: true })).status).toBe(403);
  expect((await pool.query("SELECT id FROM patients WHERE full_name=$1", [fullName])).rows).toEqual([]);
});
