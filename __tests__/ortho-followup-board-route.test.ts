import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const transaction = vi.hoisted(() => ({ query: vi.fn(), release: vi.fn() }));
vi.mock("../lib/session", async importOriginal => ({
  ...await importOriginal<typeof import("../lib/session")>(), requireSession: vi.fn(),
}));
vi.mock("../lib/db", () => ({
  getPool: () => ({ connect: async () => transaction }),
  CLINIC_TIME_ZONE: "Asia/Aden", orthoFollowupBoard: vi.fn(), findUserByUsername: vi.fn(), doctorOwnedPatientIds: vi.fn(),
}));
import { sessionCredentialVersion } from "../lib/auth";
import { GET } from "../app/api/ortho/followups/route";
import { requireSession } from "../lib/session";
import { doctorOwnedPatientIds, findUserByUsername, orthoFollowupBoard } from "../lib/db";
import type { OrthoFollowupRow } from "../lib/db";

vi.stubEnv("SESSION_SECRET", "synthetic-followup-route-secret-32-characters");
afterAll(() => vi.unstubAllEnvs());
const credential = "synthetic-followup-route-credential";
const credentialVersion = sessionCredentialVersion(credential);
const session = vi.mocked(requireSession);
const board = vi.mocked(orthoFollowupBoard);
const user = vi.mocked(findUserByUsername);
const owned = vi.mocked(doctorOwnedPatientIds);
const row = (patientId: number): OrthoFollowupRow => ({
  caseId: patientId + 100, patientId, patientName: `Patient ${patientId}`, patientPhone: "770123456",
  status: "active", phase: "aligning", startDate: "2026-01-01", lastAdjustmentDate: "2026-09-01",
  nextWeeks: 4, upperWire: null, lowerWire: null, nextAppointment: null, lastWasNoShow: false,
  bookingContext: { verified: true, pastUnresolvedAppointment: null, reviewAppointments: [{
    id: patientId + 200, date: "2026-10-07", time: "10:30", status: "booked",
    serviceName: `Service ${patientId}`, doctorName: `Doctor ${patientId}`, reason: "untyped_legacy",
  }], otherAppointments: [] },
});

beforeEach(() => {
  vi.resetAllMocks();
  transaction.query.mockResolvedValue({ rows: [] });
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-05T21:30:00Z"));
  session.mockResolvedValue({ username: "synthetic", userId: 7, role: "doctor", partyId: 7, credentialVersion, expiresAt: Date.now() + 60_000 });
  board.mockResolvedValue([row(10), row(20)]);
  user.mockResolvedValue({ id: 7, username: "synthetic", role: "doctor", isActive: true, passwordHash: credential, partyId: 7, permissions: { canViewAllPatients: false } } as NonNullable<Awaited<ReturnType<typeof findUserByUsername>>>);
  owned.mockResolvedValue(new Set([10]));
});
afterEach(() => { vi.useRealTimers(); });

describe("existing board API visibility with additive appointment context", () => {
  it("requires a session before loading any board context", async () => {
    session.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
    expect(board).not.toHaveBeenCalled();
  });
  it("preserves doctor ownership filtering, including nested booking labels", async () => {
    const response = await GET();
    const payload = await response.json();
    expect(response.status).toBe(200);
    expect(payload.today).toBe("2026-10-06");
    expect(board).toHaveBeenCalledWith("2026-10-06", new Date("2026-10-05T21:30:00Z"), transaction);
    expect(owned).toHaveBeenCalledWith(7, [10, 20], transaction);
    expect(JSON.stringify(payload)).toContain("Service 10");
    expect(JSON.stringify(payload)).not.toContain("Patient 20");
    expect(JSON.stringify(payload)).not.toContain("Service 20");
    expect(JSON.stringify(payload)).not.toContain("Doctor 20");
  });
  it("keeps one cutoff and clinic day when awaited account lookup crosses midnight", async () => {
    vi.setSystemTime(new Date("2026-10-05T20:59:59.123Z"));
    const account = await user("synthetic");
    user.mockImplementation(async () => {
      vi.setSystemTime(new Date("2026-10-05T21:00:01.456Z"));
      return account;
    });
    const response = await GET();
    expect(response.status).toBe(200);
    expect((await response.json()).today).toBe("2026-10-05");
    expect(board).toHaveBeenCalledWith("2026-10-05", new Date("2026-10-05T20:59:59.123Z"), transaction);
  });
  it("preserves additive attendance context only for visible patients", async () => {
    board.mockResolvedValue([row(10), row(20)].map((item) => ({ ...item,
      attendanceContext: { basis: "current_status_scheduled_slot", outcome: "conflict", latestScheduledLocal: `2026-10-06T00:00:00.0000${item.patientId}`,
        cutoff: { kind: "explicit_instant", instant: "2026-10-05T21:30:00.000Z", localDateTime: "2026-10-06T00:30:00.000000", timeZone: "Asia/Aden" } },
    })));
    const payload = JSON.stringify(await (await GET()).json());
    expect(payload).toContain("current_status_scheduled_slot");
    expect(payload).toContain("2026-10-06T00:00:00.000010");
    expect(payload).not.toContain("2026-10-06T00:00:00.000020");
  });
  it.each(["admin", "reception"] as const)("preserves authorized %s board access", async (role) => {
    session.mockResolvedValue({ username: "synthetic", userId: 7, role, partyId: null, credentialVersion, expiresAt: Date.now() + 60_000 });
    user.mockResolvedValue({ id: 7, username: "synthetic", role, isActive: true, passwordHash: credential, partyId: null } as NonNullable<Awaited<ReturnType<typeof findUserByUsername>>>);
    const payload = await (await GET()).json();
    expect(JSON.stringify(payload)).toContain("Service 10");
    expect(JSON.stringify(payload)).toContain("Service 20");
    expect(owned).not.toHaveBeenCalled();
  });
  it("preserves explicit canViewAllPatients while not redefining case ownership", async () => {
    user.mockResolvedValue({ id: 7, username: "synthetic", role: "doctor", isActive: true, passwordHash: credential, partyId: 7, permissions: { canViewAllPatients: true } } as NonNullable<Awaited<ReturnType<typeof findUserByUsername>>>);
    expect(JSON.stringify(await (await GET()).json())).toContain("Service 20");
    expect(owned).not.toHaveBeenCalled();
  });
  it("does not turn a failed projection query into an empty successful board", async () => {
    board.mockRejectedValue(new Error("Synthetic projection unavailable"));
    const response = await GET();
    expect(response.status).toBe(500);
    expect(await response.json()).not.toHaveProperty("buckets");
  });
});


describe("follow-up board current-account boundary", () => {
  const current = (overrides: Record<string, unknown> = {}) => ({ id: 7, username: "synthetic", role: "doctor",
    isActive: true, passwordHash: credential, partyId: 7, permissions: { canViewAllPatients: false }, ...overrides }) as NonNullable<Awaited<ReturnType<typeof findUserByUsername>>>;
  async function noBoardDisclosure(expectedStatus: number) {
    const response = await GET();
    expect(response.status).toBe(expectedStatus);
    const payload = await response.json();
    expect(payload).not.toHaveProperty("buckets");
    for (const sentinel of ["Patient 10", "Patient 20", "770123456", "Service 10", "Service 20", "Doctor 20"])
      expect(JSON.stringify(payload)).not.toContain(sentinel);
    expect(board).not.toHaveBeenCalled();
    expect(owned).not.toHaveBeenCalled();
  }
  it("does not expose the clinic board to an active unlinked doctor", async () => {
    session.mockResolvedValue({ username: "synthetic", userId: 7, role: "doctor", partyId: null, credentialVersion, expiresAt: Date.now() + 60_000 });
    user.mockResolvedValue(current({ partyId: null }));
    await noBoardDisclosure(403);
  });
  it.each(["absent", "inactive", "lookup-failed", "role-changed", "identity-changed", "username-changed", "party-removed"])("fails closed before the board read when the current account is %s", async (state) => {
    if (state === "absent") user.mockResolvedValue(null);
    if (state === "inactive") user.mockResolvedValue(current({ isActive: false, permissions: { canViewAllPatients: true } }));
    if (state === "lookup-failed") user.mockRejectedValue(new Error("Synthetic current account unavailable"));
    if (state === "role-changed") user.mockResolvedValue(current({ role: "cashier", permissions: { canViewAllPatients: true } }));
    if (state === "identity-changed") user.mockResolvedValue(current({ id: 99, permissions: { canViewAllPatients: true } }));
    if (state === "username-changed") user.mockResolvedValue(current({ username: "synthetic-replacement", permissions: { canViewAllPatients: true } }));
    if (state === "party-removed") user.mockResolvedValue(current({ partyId: null }));
    await noBoardDisclosure(state === "party-removed" ? 403 : 401);
  });
  it.each(["assistant", "cashier", "accountant"] as const)("preserves the proxy's %s denial inside the handler", async (role) => {
    session.mockResolvedValue({ username: "synthetic", userId: 7, role, partyId: null, credentialVersion, expiresAt: Date.now() + 60_000 });
    await noBoardDisclosure(403);
    expect(user).not.toHaveBeenCalled();
  });
  it("uses the current clinician-party link rather than an earlier session projection", async () => {
    user.mockResolvedValue(current({ partyId: 17 }));
    owned.mockImplementation(async partyId => new Set(partyId === 17 ? [20] : [10]));
    const payload = await (await GET()).json();
    expect(owned).toHaveBeenCalledWith(17, [10, 20], transaction);
    expect(JSON.stringify(payload)).toContain("Patient 20");
    expect(JSON.stringify(payload)).not.toContain("Patient 10");
  });
  it("preserves the canonical case-insensitive account lookup", async () => {
    user.mockResolvedValue(current({ username: "Synthetic" }));
    const response = await GET();
    expect(response.status).toBe(200);
    expect(owned).toHaveBeenCalledWith(7, [10, 20], transaction);
    expect(JSON.stringify(await response.json())).not.toContain("Patient 20");
  });
  it.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, "7"])("rejects an invalid current party mapping %s before loading the board", async (partyId) => {
    user.mockResolvedValue(current({ partyId }));
    await noBoardDisclosure(403);
  });
  it("keeps an explicit current global grant valid even without a clinician-party link", async () => {
    session.mockResolvedValue({ username: "synthetic", userId: 7, role: "doctor", partyId: null, credentialVersion, expiresAt: Date.now() + 60_000 });
    user.mockResolvedValue(current({ partyId: null, permissions: { canViewAllPatients: true } }));
    const response = await GET();
    expect(response.status).toBe(200);
    expect(user).toHaveBeenCalledWith("synthetic", transaction);
    expect(JSON.stringify(await response.json())).toContain("Patient 20");
    expect(owned).not.toHaveBeenCalled();
  });
  it("does not treat a truthy nonboolean value as a global visibility grant", async () => {
    user.mockResolvedValue(current({ partyId: null, permissions: { canViewAllPatients: "true" } }));
    await noBoardDisclosure(403);
  });
  it("reports an ownership lookup failure without a partial or empty success", async () => {
    owned.mockRejectedValue(new Error("Synthetic ownership unavailable"));
    const response = await GET();
    expect(response.status).toBe(500);
    expect(await response.json()).not.toHaveProperty("buckets");
  });
  it("does not cache successful or denied clinical board responses", async () => {
    expect((await GET()).headers.get("Cache-Control")).toBe("private, no-store");
    session.mockResolvedValue(null);
    expect((await GET()).headers.get("Cache-Control")).toBe("private, no-store");
  });
});

describe("actual follow-up GET retention recall projection", () => {
  it("serializes unknown recall, preserves booking/no-show evidence and applies doctor isolation before grouping", async () => {
    const ownedRetention: OrthoFollowupRow = { ...row(10), status: "retention", phase: "retention",
      lastAdjustmentDate: "2025-01-01", lastWasNoShow: true,
      nextAppointment: { id: 510, date: "2026-10-07", time: "10:30", status: "arrived" },
    };
    const hiddenRetention: OrthoFollowupRow = { ...row(20), status: "retention", phase: "retention", lastAdjustmentDate: null };
    const inputs = [ownedRetention, hiddenRetention]; const before = structuredClone(inputs);
    board.mockResolvedValue(inputs);
    const response = await GET(); const payload = await response.json();
    const nonempty = payload.buckets.filter((b: { count: number }) => b.count > 0);
    expect(nonempty.map((b: { bucket: string }) => b.bucket)).toEqual(["tomorrow", "no_show", "retention"]);
    for (const bucket of nonempty) {
      expect(bucket.rows).toHaveLength(1);
      expect(bucket.rows[0]).toMatchObject({ patientId: 10, status: "retention", dueDate: null,
        daysSinceLast: null, dueBasis: "retention_schedule_unavailable", nextAppointment: ownedRetention.nextAppointment,
        bookingContext: ownedRetention.bookingContext });
    }
    expect(JSON.stringify(payload)).not.toContain("Patient 20");
    expect(JSON.stringify(payload)).not.toContain("Service 20");
    expect(inputs).toEqual(before);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("keeps active phase-retention untransitioned and past unresolved booking overdue, without adjustment alarm", async () => {
    board.mockResolvedValue([{ ...row(10), status: "active", phase: "retention", lastAdjustmentDate: null,
      bookingContext: { verified: true, reviewAppointments: [], otherAppointments: [],
        pastUnresolvedAppointment: { id: 511, date: "2026-10-01", time: "09:00", status: "booked" } },
    }]);
    const payload = await (await GET()).json();
    expect(payload.buckets.filter((b: { count: number }) => b.count > 0).map((b: { bucket: string }) => b.bucket)).toEqual(["overdue", "retention"]);
    const result = payload.buckets.find((b: { bucket: string }) => b.bucket === "retention").rows[0];
    expect(result).toMatchObject({ status: "active", phase: "retention", dueDate: null, daysSinceLast: null,
      dueBasis: "retention_schedule_unavailable", nextAppointment: null });
    expect(result.bookingContext.pastUnresolvedAppointment.id).toBe(511);
  });

  it("preserves active treatment due and lapse behavior beside retention with no inferred schedule", async () => {
    session.mockResolvedValue({ username: "synthetic", userId: 7, role: "reception", partyId: null, credentialVersion, expiresAt: Date.now() + 60_000 });
    user.mockResolvedValue({ id: 7, username: "synthetic", role: "reception", isActive: true, passwordHash: credential, partyId: null } as NonNullable<Awaited<ReturnType<typeof findUserByUsername>>>);
    board.mockResolvedValue([row(10), { ...row(20), status: "retention", lastAdjustmentDate: null }]);
    const payload = await (await GET()).json();
    const unbooked = payload.buckets.find((b: { bucket: string }) => b.bucket === "no_appointment").rows;
    expect(unbooked.find((r: { patientId: number }) => r.patientId === 10)).toMatchObject({ dueDate: "2026-09-29", daysSinceLast: 35, dueBasis: "adjustment_interval" });
    expect(unbooked.find((r: { patientId: number }) => r.patientId === 20)).toMatchObject({ dueDate: null, daysSinceLast: null, dueBasis: "retention_schedule_unavailable" });
    expect(payload.buckets.find((b: { bucket: string }) => b.bucket === "lapsed_4").rows.map((r: { patientId: number }) => r.patientId)).toEqual([10]);
    expect(payload.buckets.find((b: { bucket: string }) => b.bucket === "lapsed_8").count).toBe(0);
  });
});

describe("follow-up transactional response boundary", () => {
  it("uses one shared read transaction and releases it after a successful response", async () => {
    expect((await GET()).status).toBe(200);
    expect(transaction.query.mock.calls.map(call => call[0])).toEqual([
      "BEGIN ISOLATION LEVEL REPEATABLE READ", "COMMIT",
    ]);
    expect(transaction.release).toHaveBeenCalledOnce();
  });
  it("returns a private conflict without payload when the account snapshot cannot serialize", async () => {
    user.mockRejectedValue(Object.assign(new Error("Synthetic serialization conflict"), { code: "40001" }));
    const response = await GET();
    expect(response.status).toBe(409);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.json()).not.toHaveProperty("buckets");
    expect(board).not.toHaveBeenCalled();
    expect(transaction.query).toHaveBeenCalledWith("ROLLBACK");
    expect(transaction.release).toHaveBeenCalledOnce();
  });
  it("does not return clinical data if the session expires during the board projection", async () => {
    board.mockImplementation(async () => {
      vi.setSystemTime(new Date("2026-10-05T21:32:00Z"));
      return [row(10), row(20)];
    });
    const response = await GET();
    expect(response.status).toBe(401);
    expect(await response.json()).not.toHaveProperty("buckets");
    expect(transaction.query).toHaveBeenCalledWith("ROLLBACK");
    expect(transaction.query).not.toHaveBeenCalledWith("COMMIT");
    expect(transaction.release).toHaveBeenCalledOnce();
  });
});
