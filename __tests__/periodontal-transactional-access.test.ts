import { readFileSync } from "node:fs";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbClient } from "../lib/db";
import { readLegacyStaffSchema, lockLegacyStaffBoundary, assertLegacyPermissionEnvelope } from "../lib/legacy-staff-boundary";
import { withTransaction } from "../lib/transactions";
const mocks = vi.hoisted(() => ({ cookie: vi.fn(), user: vi.fn(), owns: vi.fn(), today: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: mocks.cookie }), headers: async () => ({ get: () => null }) }));
vi.mock("../lib/db", () => ({ findUserByUsername: mocks.user, doctorOwnsPatient: mocks.owns, patientHasVisitToday: mocks.today }));
import { createSessionToken, sessionCredentialVersion, type SessionPayload } from "../lib/auth";
import { requireSession } from "../lib/session";
import { canAccessPatient } from "../lib/patient-access";

const client: DbClient = { query: vi.fn(), release: vi.fn() };
const payload = (): SessionPayload => ({ userId: 7, username: "synthetic", role: "doctor", partyId: 41,
  expiresAt: Date.now() + 60_000, credentialVersion: sessionCredentialVersion("synthetic-hash") });
beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv("SESSION_SECRET", "isolated-periodontal-access-secret-32-characters");
  mocks.user.mockResolvedValue({ id: 7, username: "synthetic", isActive: true, role: "doctor", partyId: 42,
    passwordHash: "synthetic-hash", permissions: { canViewAllPatients: false, canViewXrays: true } });
  mocks.cookie.mockReturnValue({ value: createSessionToken(payload()) });
  mocks.owns.mockResolvedValue(true); mocks.today.mockResolvedValue(true);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe("canonical session and patient access with optional transaction ownership", () => {
  it("preserves ordinary session and doctor access invocation behavior", async () => {
    const session = await requireSession(); expect(session).toMatchObject({ partyId: 42 });
    expect(mocks.user).toHaveBeenCalledExactlyOnceWith("synthetic");
    expect(await canAccessPatient(session!, 8, "canViewXrays")).toBe(true);
    expect(mocks.user).toHaveBeenLastCalledWith("synthetic");
    expect(mocks.owns).toHaveBeenCalledExactlyOnceWith(42, 8);
  });
  it("passes the exact client through both current session and every doctor access query", async () => {
    const session = await requireSession(client); expect(session).toMatchObject({ partyId: 42 });
    expect(await canAccessPatient(session!, 8, undefined, client)).toBe(true);
    expect(mocks.user.mock.calls).toEqual([["synthetic", client], ["synthetic", client]]);
    expect(mocks.owns).toHaveBeenCalledExactlyOnceWith(42, 8, client);
  });
  it.each(["inactive", "id", "role", "credential"])("retains canonical %s session refusal on the client path", async (reason) => {
    const user = await mocks.user();
    if (reason === "inactive") user.isActive = false;
    if (reason === "id") user.id = 9;
    if (reason === "role") user.role = "admin";
    if (reason === "credential") user.passwordHash = "changed";
    mocks.user.mockResolvedValue(user);
    expect(await requireSession(client)).toBeNull(); expect(mocks.owns).not.toHaveBeenCalled();
  });
  it("refuses expiry while waiting for the current account lock", async () => {
    vi.useFakeTimers(); const initial = Date.now(); const token = payload(); token.expiresAt = initial + 10;
    mocks.cookie.mockReturnValue({ value: createSessionToken(token) });
    const user = await mocks.user();
    mocks.user.mockImplementation(async () => { vi.setSystemTime(initial + 11); return user; });
    expect(await requireSession(client)).toBeNull();
  });
  it.each(["doctor", "assistant"])("refuses %s expiry after an ownership lock wait", async (role) => {
    vi.useFakeTimers(); const initial = Date.now(); const session = { ...payload(), role, expiresAt: initial + 10 };
    const delayedGrant = async () => { vi.setSystemTime(initial + 11); return true; };
    mocks.owns.mockImplementation(delayedGrant); mocks.today.mockImplementation(delayedGrant);
    expect(await canAccessPatient(session, 8, undefined, client)).toBe(false);
  });
  it.each(["admin", "reception"])("preserves ordinary %s access policy", async (role) => {
    expect(await canAccessPatient({ ...payload(), role }, 8)).toBe(true);
    expect(mocks.user).not.toHaveBeenCalled(); expect(mocks.owns).not.toHaveBeenCalled();
  });
  it("preserves assistant ordinary policy and forwards its protected visit check", async () => {
    const session = { ...payload(), role: "assistant" };
    expect(await canAccessPatient(session, 8)).toBe(true); expect(mocks.today).toHaveBeenLastCalledWith(8);
    expect(await canAccessPatient(session, 8, undefined, client)).toBe(true);
    expect(mocks.today).toHaveBeenLastCalledWith(8, client);
    expect(await canAccessPatient(session, 8, "canViewXrays", client)).toBe(false);
  });
  it("keeps permission and all-patient decisions on current locked user facts", async () => {
    const user = await mocks.user(); user.permissions = { canViewAllPatients: true, canViewXrays: false };
    mocks.user.mockResolvedValue(user);
    expect(await canAccessPatient(payload(), 8, "canViewXrays", client)).toBe(false);
    expect(await canAccessPatient(payload(), 8, undefined, client)).toBe(true);
    expect(mocks.owns).not.toHaveBeenCalled();
  });
  it("fails closed when canonical account or ownership locking fails", async () => {
    mocks.user.mockRejectedValue(new Error("lock failed")); expect(await requireSession(client)).toBeNull();
    mocks.user.mockResolvedValue({ isActive: true, partyId: 42 }); mocks.owns.mockRejectedValue(new Error("deadlock"));
    expect(await canAccessPatient(payload(), 8, undefined, client)).toBe(false);
  });
});

// Source-extracted canonical bodies with query doubles: protocol/default-path proof,
// not SQL execution. Real row-lock and policy parity cases are in isolated PG CI.
function ownerFunctions() {
  const source = readFileSync("lib/db.ts", "utf8");
  const names = ["findUserByUsername", "findLegacyUserByUsernameReadOnlySnapshot", "doctorOwnsPatient", "patientHasVisitToday"];
  const chunks = names.map((name) => {
    const start = source.indexOf(`export async function ${name}(`); expect(start).toBeGreaterThan(0);
    return source.slice(start, source.indexOf("\n}", start) + 2).replace("export ", "");
  }).join("\n");
  const bridge = source.match(/const ORTHO_BRIDGE_RESPONSIBILITY = `[\s\S]*?`;/)?.[0];
  expect(bridge).toBeTruthy();
  const js = ts.transpile(`${bridge}\n${chunks}`, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None });
  const schema = { markers: "0", users_kind: "r" as string | null, parties_kind: "r" as string | null };
  const row = { id: 7, permissions: null as unknown };
  const query = vi.fn().mockResolvedValue({ rows: [schema] });
  const heldQuery = vi.fn(async (sql: string): Promise<{ rows: unknown[] }> => ({ rows:
    sql.includes("pg_catalog.pg_class") ? [schema] :
    sql.startsWith("SELECT * FROM users") ? [row] : [] }));
  const held = { query: heldQuery, release: vi.fn() } as unknown as DbClient;
  const pool = { query, connect: vi.fn().mockResolvedValue(held) };
  const ensure = vi.fn(); const getPool = vi.fn(() => pool);
  // Spies delegate to production guards/transaction ownership, never no-op them.
  const schemaGuard = vi.fn(readLegacyStaffSchema);
  const fence = vi.fn(lockLegacyStaffBoundary);
  const permission = vi.fn(assertLegacyPermissionEnvelope);
  const transaction = vi.fn(withTransaction);
  const mapUser = vi.fn((row: unknown) => row);
  const date = vi.fn(() => "2026-10-06");
  const owners = new Function("ensureSchema", "getPool", "toUser", "CLINIC_TIME_ZONE", "clinicDateString",
    "readLegacyStaffSchema", "lockLegacyStaffBoundary", "assertLegacyPermissionEnvelope", "withTransaction",
    `${js};return {${names.join(",")}}`)(ensure, getPool, mapUser, "Asia/Aden", date,
      schemaGuard, fence, permission, transaction) as {
      findUserByUsername: (name: string, client?: DbClient) => Promise<unknown>;
      findLegacyUserByUsernameReadOnlySnapshot: (name: string, client: DbClient) => Promise<unknown>;
      doctorOwnsPatient: (party: number, patient: number, client?: DbClient) => Promise<boolean>;
      patientHasVisitToday: (patient: number, client?: DbClient) => Promise<boolean>;
    };
  return { owners, query, ensure, getPool, date, schema, row, held, heldQuery, pool, schemaGuard, fence, permission, transaction, mapUser };
}
describe("canonical database-reader executor contract", () => {
  it("preflights before initialization and owns the fenced active-user read transaction", async () => {
    const f = ownerFunctions();
    expect(await f.owners.findUserByUsername("Synthetic")).toEqual(f.row);
    expect(f.schemaGuard).toHaveBeenCalledExactlyOnceWith(f.pool);
    expect(f.schemaGuard.mock.invocationCallOrder[0]).toBeLessThan(f.ensure.mock.invocationCallOrder[0]);
    expect(f.ensure.mock.invocationCallOrder[0]).toBeLessThan(f.transaction.mock.invocationCallOrder[0]);
    expect(f.transaction).toHaveBeenCalledExactlyOnceWith(f.pool, expect.any(Function));
    expect(f.fence).toHaveBeenCalledExactlyOnceWith(f.held);
    expect(f.heldQuery.mock.calls.map(([sql]) => sql)).toEqual([
      "BEGIN", "SAVEPOINT legacy_staff_transaction", "RELEASE SAVEPOINT legacy_staff_transaction",
      "SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))", expect.stringContaining("pg_catalog.pg_class"),
      "SELECT * FROM users WHERE LOWER(username) = LOWER($1) AND is_active LIMIT 1 FOR SHARE", "COMMIT",
    ]);
    expect(f.heldQuery).toHaveBeenCalledWith(expect.stringContaining("pg_advisory_xact_lock_shared"), ["aqlan.canonical.identity.substrate.v1:public"]);
    expect(f.heldQuery).toHaveBeenCalledWith(expect.stringContaining("LIMIT 1 FOR SHARE"), ["Synthetic"]);
    expect(f.query).toHaveBeenCalledOnce(); // Schema preflight only; user data never uses the pool.
    expect(f.permission).toHaveBeenCalledExactlyOnceWith(f.row.permissions);
    expect(f.permission.mock.invocationCallOrder[0]).toBeLessThan(f.mapUser.mock.invocationCallOrder[0]);
    expect(f.held.release).toHaveBeenCalledOnce();
  });
  it("fences and locks on the exact supplied client without opening or ending its transaction", async () => {
    const f = ownerFunctions();
    expect(await f.owners.findUserByUsername("Synthetic", f.held)).toEqual(f.row);
    expect(f.fence).toHaveBeenCalledExactlyOnceWith(f.held);
    expect(f.heldQuery.mock.calls.map(([sql]) => sql)).toEqual([
      "SAVEPOINT legacy_staff_transaction", "RELEASE SAVEPOINT legacy_staff_transaction",
      expect.stringContaining("pg_advisory_xact_lock_shared"), expect.stringContaining("pg_catalog.pg_class"),
      "SELECT * FROM users WHERE LOWER(username) = LOWER($1) AND is_active LIMIT 1 FOR SHARE",
    ]);
    expect(f.heldQuery).toHaveBeenLastCalledWith(expect.any(String), ["Synthetic"]);
    expect(f.permission).toHaveBeenCalledExactlyOnceWith(f.row.permissions);
    expect(f.ensure).not.toHaveBeenCalled(); expect(f.getPool).not.toHaveBeenCalled();
    expect(f.transaction).not.toHaveBeenCalled(); expect(f.held.release).not.toHaveBeenCalled();
  });
  it.each(["empty", "authority", "unreadable", "error"])("refuses %s preflight before initialization or transaction acquisition", async reason => {
    const f = ownerFunctions();
    if (reason === "empty") { f.schema.users_kind = null; f.schema.parties_kind = null; }
    if (reason === "authority") f.schema.markers = "1";
    if (reason === "unreadable") f.schema.users_kind = "v";
    if (reason === "error") f.query.mockRejectedValue(new Error("schema unavailable"));
    if (reason === "empty") expect(await f.owners.findUserByUsername("Synthetic")).toBeNull();
    else await expect(f.owners.findUserByUsername("Synthetic")).rejects.toThrow();
    expect(f.ensure).not.toHaveBeenCalled(); expect(f.transaction).not.toHaveBeenCalled();
    expect(f.pool.connect).not.toHaveBeenCalled(); expect(f.mapUser).not.toHaveBeenCalled();
  });
  it("rechecks the authority fence after acquisition and rolls back before reading the user", async () => {
    const f = ownerFunctions();
    f.ensure.mockImplementation(() => { f.schema.markers = "1"; });
    await expect(f.owners.findUserByUsername("Synthetic")).rejects.toThrow("AUTHORITY_SCHEMA_HELD");
    expect(f.fence).toHaveBeenCalledExactlyOnceWith(f.held);
    expect(f.heldQuery.mock.calls.some(([sql]) => sql.startsWith("SELECT * FROM users"))).toBe(false);
    expect(f.heldQuery).toHaveBeenLastCalledWith("ROLLBACK");
    expect(f.held.release).toHaveBeenCalledOnce(); expect(f.mapUser).not.toHaveBeenCalled();
  });
  it.each(["not json", { schemaVersion: 1 }, { schemaVersion: 1, revision: 1, patientScope: "none", appointmentScope: "none", grants: {} }])(
    "rejects held or malformed raw permissions before mapping (%j)", async permissions => {
      const f = ownerFunctions(); f.row.permissions = permissions;
      await expect(f.owners.findUserByUsername("Synthetic")).rejects.toThrow("PERMISSION_ENVELOPE_HELD");
      expect(f.permission).toHaveBeenCalledExactlyOnceWith(permissions);
      expect(f.mapUser).not.toHaveBeenCalled(); expect(f.heldQuery).toHaveBeenLastCalledWith("ROLLBACK");
      expect(f.held.release).toHaveBeenCalledOnce();
    });
  it("returns null for no active matching user without mapping or checking a nonexistent envelope", async () => {
    const f = ownerFunctions();
    f.heldQuery.mockImplementation(async sql => ({ rows: sql.includes("pg_catalog.pg_class") ? [f.schema] : [] }));
    expect(await f.owners.findUserByUsername("Missing", f.held)).toBeNull();
    expect(f.fence).toHaveBeenCalledExactlyOnceWith(f.held);
    expect(f.permission).not.toHaveBeenCalled(); expect(f.mapUser).not.toHaveBeenCalled();
  });
  it("propagates a supplied-client fence failure without reading or taking ownership", async () => {
    const f = ownerFunctions(); f.heldQuery.mockRejectedValueOnce(new Error("no owning transaction"));
    await expect(f.owners.findUserByUsername("Synthetic", f.held)).rejects.toThrow("no owning transaction");
    expect(f.fence).toHaveBeenCalledExactlyOnceWith(f.held);
    expect(f.heldQuery).toHaveBeenCalledExactlyOnceWith("SAVEPOINT legacy_staff_transaction");
    expect(f.permission).not.toHaveBeenCalled(); expect(f.mapUser).not.toHaveBeenCalled();
    expect(f.getPool).not.toHaveBeenCalled(); expect(f.transaction).not.toHaveBeenCalled();
    expect(f.held.release).not.toHaveBeenCalled();
  });
  it("keeps read-only snapshot authorization SELECT-only on its exact owning client", async () => {
    const f = ownerFunctions();
    f.heldQuery.mockResolvedValueOnce({ rows: [{ mode: "on", isolation: "repeatable read" }] });
    expect(await f.owners.findLegacyUserByUsernameReadOnlySnapshot("Synthetic", f.held)).toEqual(f.row);
    expect(f.schemaGuard).toHaveBeenCalledExactlyOnceWith(f.held);
    expect(f.heldQuery.mock.calls.map(([sql]) => sql)).toEqual([
      expect.stringContaining("current_setting('transaction_read_only')"), expect.stringContaining("pg_catalog.pg_class"),
      "SELECT * FROM users WHERE LOWER(username) = LOWER($1) AND is_active LIMIT 1",
    ]);
    expect(f.permission).toHaveBeenCalledExactlyOnceWith(f.row.permissions);
    expect(f.fence).not.toHaveBeenCalled(); expect(f.ensure).not.toHaveBeenCalled();
    expect(f.getPool).not.toHaveBeenCalled(); expect(f.transaction).not.toHaveBeenCalled();
  });
  it.each([{ mode: "off", isolation: "repeatable read" }, { mode: "on", isolation: "read committed" }])(
    "rejects a non-owning snapshot mode %j before any user read", async mode => {
      const f = ownerFunctions(); f.heldQuery.mockResolvedValueOnce({ rows: [mode] });
      await expect(f.owners.findLegacyUserByUsernameReadOnlySnapshot("Synthetic", f.held)).rejects.toThrow("READ_ONLY_SNAPSHOT_REQUIRED");
      expect(f.heldQuery).toHaveBeenCalledOnce(); expect(f.schemaGuard).not.toHaveBeenCalled();
      expect(f.permission).not.toHaveBeenCalled(); expect(f.mapUser).not.toHaveBeenCalled();
    });
  it("derives legacy EXISTS and all historical/current-responsibility row locks from the same canonical predicates", async () => {
    const f = ownerFunctions(); f.query.mockResolvedValue({ rows: [{ ok: true }] });
    expect(await f.owners.doctorOwnsPatient(42, 8)).toBe(true);
    const legacy = f.query.mock.calls[0][0] as string;
    const query = vi.fn().mockResolvedValue({ rows: [] }); const locked = { query, release: vi.fn() } as DbClient;
    expect(await f.owners.doctorOwnsPatient(42, 8, locked)).toBe(false);
    expect(query).toHaveBeenCalledTimes(9);
    for (const [sql, values] of query.mock.calls.slice(0, 8)) {
      const match = (sql as string).match(/FROM (\w+) (\w+)\s+WHERE ([\s\S]+) ORDER BY \w+\.id LIMIT 1 FOR SHARE$/)!;
      expect(match).not.toBeNull(); expect(legacy).toContain(`SELECT 1 FROM ${match[1]} ${match[2]} WHERE ${match[3]}`);
      expect(values).toEqual([42, 8]);
    }
    const [bridgeSql, bridgeValues] = query.mock.calls[8];
    const bridgePredicate = (bridgeSql as string).match(/WHERE ([\s\S]+)\s+ORDER BY cc.id LIMIT 1 FOR SHARE OF cc, oc$/)![1].trim();
    expect(legacy).toContain(bridgePredicate);
    expect(bridgeSql).toContain("JOIN ortho_cases oc ON oc.id = cc.ortho_case_id");
    expect(bridgePredicate).toContain("oc.responsible_doctor_id IS NULL");
    expect(bridgePredicate).toContain("cc.patient_id = oc.patient_id");
    expect(bridgePredicate).toContain("cc.specialty = 'orthodontics'");
    expect(bridgePredicate).toContain("NOT EXISTS");
    expect(bridgeValues).toEqual([42, 8]);
    expect(f.ensure).toHaveBeenCalledOnce(); expect(f.getPool).toHaveBeenCalledOnce();
  });
  it("locks only one positive witness and never enters initialization or a pool fallback", async () => {
    const f = ownerFunctions(); const query = vi.fn().mockResolvedValue({ rows: [{ id: 1 }] });
    expect(await f.owners.doctorOwnsPatient(42, 8, { query, release: vi.fn() } as DbClient)).toBe(true);
    expect(query).toHaveBeenCalledOnce(); expect(f.ensure).not.toHaveBeenCalled(); expect(f.getPool).not.toHaveBeenCalled();
  });
  it("preserves the assistant day predicate and refuses a protected midnight crossing", async () => {
    const f = ownerFunctions(); f.query.mockResolvedValue({ rows: [{ ok: true }] });
    expect(await f.owners.patientHasVisitToday(8)).toBe(true);
    const query = vi.fn().mockResolvedValue({ rows: [{ id: 1 }] });
    f.date.mockReturnValueOnce("2026-10-06").mockReturnValueOnce("2026-10-07");
    expect(await f.owners.patientHasVisitToday(8, { query, release: vi.fn() } as DbClient)).toBe(false);
    expect(query.mock.calls[0][0]).toContain("patient_id = $1 AND (arrived_at AT TIME ZONE $2)::date = $3::date");
    expect(query.mock.calls[0][0]).toContain("LIMIT 1 FOR SHARE");
    expect(f.ensure).toHaveBeenCalledOnce(); expect(f.getPool).toHaveBeenCalledOnce();
  });
});
