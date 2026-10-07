import { readFileSync } from "node:fs";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbClient } from "../lib/db";
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
  const names = ["findUserByUsername", "doctorOwnsPatient", "patientHasVisitToday"];
  const chunks = names.map((name) => {
    const start = source.indexOf(`export async function ${name}(`); expect(start).toBeGreaterThan(0);
    return source.slice(start, source.indexOf("\n}", start) + 2).replace("export ", "");
  }).join("\n");
  const js = ts.transpile(chunks, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None });
  const query = vi.fn().mockResolvedValue({ rows: [] }); const ensure = vi.fn(); const getPool = vi.fn(() => ({ query }));
  const date = vi.fn(() => "2026-10-06");
  const owners = new Function("ensureSchema", "getPool", "toUser", "CLINIC_TIME_ZONE", "clinicDateString",
    `${js};return {${names.join(",")}}`)(ensure, getPool, (row: unknown) => row, "Asia/Aden", date) as {
      findUserByUsername: (name: string, client?: DbClient) => Promise<unknown>;
      doctorOwnsPatient: (party: number, patient: number, client?: DbClient) => Promise<boolean>;
      patientHasVisitToday: (patient: number, client?: DbClient) => Promise<boolean>;
    };
  return { owners, query, ensure, getPool, date };
}
describe("canonical database-reader executor contract", () => {
  it("retains the ordinary active-user query and locks the same row only with a client", async () => {
    const f = ownerFunctions(); f.query.mockResolvedValue({ rows: [{ id: 7 }] });
    expect(await f.owners.findUserByUsername("Synthetic")).toEqual({ id: 7 });
    expect(f.ensure).toHaveBeenCalledOnce();
    expect(f.query).toHaveBeenCalledExactlyOnceWith("SELECT * FROM users WHERE LOWER(username) = LOWER($1) AND is_active LIMIT 1", ["Synthetic"]);
    const query = vi.fn().mockResolvedValue({ rows: [{ id: 7 }] }); const locked = { query, release: vi.fn() } as DbClient;
    await f.owners.findUserByUsername("Synthetic", locked);
    expect(query).toHaveBeenCalledExactlyOnceWith("SELECT * FROM users WHERE LOWER(username) = LOWER($1) AND is_active LIMIT 1 FOR SHARE", ["Synthetic"]);
    expect(f.ensure).toHaveBeenCalledOnce(); expect(f.getPool).toHaveBeenCalledOnce();
  });
  it("derives legacy EXISTS and all six row locks from the same canonical predicates", async () => {
    const f = ownerFunctions(); f.query.mockResolvedValue({ rows: [{ ok: true }] });
    expect(await f.owners.doctorOwnsPatient(42, 8)).toBe(true);
    const legacy = f.query.mock.calls[0][0] as string;
    const query = vi.fn().mockResolvedValue({ rows: [] }); const locked = { query, release: vi.fn() } as DbClient;
    expect(await f.owners.doctorOwnsPatient(42, 8, locked)).toBe(false);
    expect(query).toHaveBeenCalledTimes(6);
    for (const [sql, values] of query.mock.calls) {
      const match = (sql as string).match(/FROM (\w+) (\w+)\s+WHERE ([\s\S]+) ORDER BY \w+\.id LIMIT 1 FOR SHARE$/)!;
      expect(match).not.toBeNull(); expect(legacy).toContain(`SELECT 1 FROM ${match[1]} ${match[2]} WHERE ${match[3]}`);
      expect(values).toEqual([42, 8]);
    }
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
