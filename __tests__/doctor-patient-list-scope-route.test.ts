import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionPayload } from "../lib/auth";

// Mocked route calls only: no real accounts, database, app server, network or visits.
const mocks = vi.hoisted(() => ({
  session: vi.fn(), user: vi.fn(), search: vi.fn(), browse: vi.fn(),
  create: vi.fn(), duplicates: vi.fn(), settings: vi.fn(), locked: vi.fn(),
  audit: vi.fn(), opening: vi.fn(),
}));
vi.mock("@/lib/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/db", () => ({
  CLINIC_TIME_ZONE: "Asia/Aden",
  findUserByUsername: mocks.user,
  searchPatients: mocks.search,
  browsePatients: mocks.browse,
  createPatient: mocks.create,
  duplicateCandidates: mocks.duplicates,
  getSettings: mocks.settings,
  isPeriodLocked: mocks.locked,
  recordAudit: mocks.audit,
  setPatientOpeningBalance: mocks.opening,
}));
import { GET } from "../app/api/patients/route";

const session: SessionPayload = {
  userId: 10, username: "synthetic-list-doctor", role: "doctor", partyId: 7, expiresAt: 0,
};
const rows = [{
  id: 91, patientNumber: "SYNTHETIC-91", fullName: "Synthetic listing patient", phone: null,
  medicalAlert: "Synthetic clinical field", flags: ["synthetic"], lastVisit: "2026-09-01",
}];
const financeRows = [{
  id: 91, patientNumber: "SYNTHETIC-91", fullName: "Synthetic listing patient", phone: null,
}];
const listingModes = ["search", "browse"] as const;
type ListingMode = typeof listingModes[number];

function currentDoctor(overrides: Record<string, unknown> = {}) {
  return {
    id: session.userId, username: session.username, role: "doctor", isActive: true,
    partyId: 7, permissions: { canViewAllPatients: false }, ...overrides,
  };
}

function request(mode: ListingMode) {
  return new Request(`http://test.invalid/api/patients${mode === "search" ? "?q=synthetic" : ""}`);
}

function expectNoListingReads() {
  expect(mocks.search).not.toHaveBeenCalled();
  expect(mocks.browse).not.toHaveBeenCalled();
}

function expectScope(mode: ListingMode, doctorPartyId: number | null) {
  if (mode === "search") {
    expect(mocks.search).toHaveBeenCalledExactlyOnceWith("synthetic", 20, doctorPartyId);
    expect(mocks.browse).not.toHaveBeenCalled();
  } else {
    expect(mocks.browse).toHaveBeenCalledExactlyOnceWith({
      offset: 0, limit: 25, filter: "all", sort: "recent", doctorPartyId, flag: null,
      today: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    });
    expect(mocks.search).not.toHaveBeenCalled();
  }
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue(session);
  mocks.user.mockResolvedValue(currentDoctor());
  mocks.search.mockResolvedValue(rows);
  mocks.browse.mockResolvedValue({ rows, total: 42 });
});

afterEach(() => {
  for (const mock of [mocks.create, mocks.duplicates, mocks.settings, mocks.locked, mocks.audit, mocks.opening]) {
    expect(mock).not.toHaveBeenCalled();
  }
});

describe.each(listingModes)("GET patient %s doctor scope", (mode) => {
  it("rejects a missing authenticated session before any account or listing read", async () => {
    mocks.session.mockResolvedValue(null);
    expect((await GET(request(mode))).status).toBe(401);
    expect(mocks.user).not.toHaveBeenCalled();
    expectNoListingReads();
  });

  it("rejects a missing current account without falling back to the session link", async () => {
    mocks.user.mockResolvedValue(null);
    expect((await GET(request(mode))).status).toBe(401);
    expectNoListingReads();
  });

  it("fails closed on current-account read failure before search or browse", async () => {
    mocks.user.mockRejectedValue(new Error("Synthetic current-account read failure"));
    expect((await GET(request(mode))).status).toBe(401);
    expectNoListingReads();
  });

  it("never sends the unlinked doctor's null scope to an all-patient query", async () => {
    mocks.session.mockResolvedValue({ ...session, partyId: null });
    mocks.user.mockResolvedValue(currentDoctor({ partyId: null }));
    expect((await GET(request(mode))).status).toBe(403);
    expectNoListingReads();
  });

  it.each([
    ["user ID", { id: 11 }],
    ["username", { username: "different-synthetic-doctor" }],
    ["role", { role: "reception" }],
    ["activity", { isActive: false }],
  ] as [string, Record<string, unknown>][])("rejects a changed %s even with an all-patient grant", async (_name, change) => {
    mocks.user.mockResolvedValue(currentDoctor({ ...change, permissions: { canViewAllPatients: true } }));
    expect((await GET(request(mode))).status).toBe(401);
    expectNoListingReads();
  });

  it("matches usernames case-insensitively like the canonical account lookup", async () => {
    mocks.user.mockResolvedValue(currentDoctor({ username: session.username.toUpperCase() }));
    expect((await GET(request(mode))).status).toBe(200);
    expectScope(mode, 7);
  });

  it.each([
    ["absent", undefined], ["null", null], ["zero", 0], ["negative", -7],
    ["fractional", 7.5], ["NaN", Number.NaN], ["infinite", Number.POSITIVE_INFINITY],
    ["unsafe integer", Number.MAX_SAFE_INTEGER + 1], ["string", "7"],
  ])("rejects a %s current party link without using the stale session party", async (_name, partyId) => {
    mocks.user.mockResolvedValue(currentDoctor({ partyId }));
    const response = await GET(request(mode));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ message: "لا يمكنك عرض المرضى دون ربط حسابك بطبيب." });
    expectNoListingReads();
  });

  it.each([undefined, null, false, "true", 1])("does not interpret %j as an explicit all-patient grant", async (grant) => {
    mocks.user.mockResolvedValue(currentDoctor({ partyId: null, permissions: { canViewAllPatients: grant } }));
    expect((await GET(request(mode))).status).toBe(403);
    expectNoListingReads();
  });

  it("does not treat absent permissions or another grant as all-patient access", async () => {
    for (const permissions of [undefined, { canViewAllAppointments: true, canEditPatient: true }]) {
      mocks.user.mockResolvedValue(currentDoctor({ partyId: null, permissions }));
      expect((await GET(request(mode))).status).toBe(403);
      expectNoListingReads();
    }
  });

  it.each([null, 7])("preserves the canonical explicit all-patient grant with current party %j", async (partyId) => {
    mocks.user.mockResolvedValue(currentDoctor({ partyId, permissions: { canViewAllPatients: true } }));
    expect((await GET(request(mode))).status).toBe(200);
    expectScope(mode, null);
  });

  it("passes the current linked doctor scope into the query without changing clinical rows", async () => {
    const response = await GET(request(mode));
    expect(response.status).toBe(200);
    expect(mocks.user).toHaveBeenCalledExactlyOnceWith(session.username);
    expectScope(mode, 7);
    expect(await response.json()).toEqual(mode === "search" ? rows : {
      rows, total: 42, page: 0, pageSize: 25, filter: "all", sort: "recent", flag: null,
    });
  });

  it("uses a changed fresh party link instead of a stale session party", async () => {
    mocks.user.mockResolvedValue(currentDoctor({ partyId: 13 }));
    expect((await GET(request(mode))).status).toBe(200);
    expectScope(mode, 13);
  });

  it("uses a valid fresh link even when the authenticated session had none", async () => {
    mocks.session.mockResolvedValue({ ...session, partyId: null });
    expect((await GET(request(mode))).status).toBe(200);
    expectScope(mode, 7);
  });

  it("keeps a linked doctor scoped when permissions are absent", async () => {
    mocks.user.mockResolvedValue(currentDoctor({ permissions: undefined }));
    expect((await GET(request(mode))).status).toBe(200);
    expectScope(mode, 7);
  });

  it("preserves the existing read-error response after authorized scope resolution", async () => {
    (mode === "search" ? mocks.search : mocks.browse).mockRejectedValue(new Error("Synthetic listing failure"));
    const response = await GET(request(mode));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ message: "تعذّر البحث. أعد المحاولة." });
    expectScope(mode, 7);
  });

  it.each(["admin", "reception"])("preserves the existing %s listing response", async (role) => {
    mocks.session.mockResolvedValue({ ...session, role });
    const response = await GET(request(mode));
    expect(response.status).toBe(200);
    expect(mocks.user).not.toHaveBeenCalled();
    expectScope(mode, null);
    expect(await response.json()).toEqual(mode === "search" ? rows : {
      rows, total: 42, page: 0, pageSize: 25, filter: "all", sort: "recent", flag: null,
    });
  });

  it.each(["cashier", "accountant"])("preserves the %s identity-only financial projection", async (role) => {
    mocks.session.mockResolvedValue({ ...session, role });
    const response = await GET(request(mode));
    expect(response.status).toBe(200);
    expect(mocks.user).not.toHaveBeenCalled();
    expectScope(mode, null);
    expect(await response.json()).toEqual(mode === "search" ? financeRows : {
      rows: financeRows, total: 42, page: 0, pageSize: 25, filter: "all", sort: "recent", flag: null,
    });
  });
});

describe("GET patient listing parameter contracts", () => {
  it("keeps the original search term, fixed search limit and search array response", async () => {
    const response = await GET(new Request("http://test.invalid/api/patients?q=%20synthetic%20&page=8&limit=999999"));
    expect(response.status).toBe(200);
    expect(mocks.search).toHaveBeenCalledExactlyOnceWith(" synthetic ", 20, 7);
    expect(mocks.browse).not.toHaveBeenCalled();
    expect(await response.json()).toEqual(rows);
  });

  it("keeps browse filters, sorting, flag normalization and fixed pagination", async () => {
    const response = await GET(new Request("http://test.invalid/api/patients?q=%20&page=2.9&filter=alert&sort=name&flag=%20synthetic%20&limit=999999"));
    expect(response.status).toBe(200);
    expect(mocks.browse).toHaveBeenCalledExactlyOnceWith({
      offset: 50, limit: 25, filter: "alert", sort: "name", doctorPartyId: 7, flag: "synthetic",
      today: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    });
    expect(mocks.search).not.toHaveBeenCalled();
    expect(await response.json()).toEqual({ rows, total: 42, page: 2, pageSize: 25, filter: "alert", sort: "name", flag: "synthetic" });
  });

  it("keeps invalid browse option fallbacks and the flag length limit", async () => {
    const response = await GET(new Request(`http://test.invalid/api/patients?page=-2&filter=invalid&sort=invalid&flag=${"x".repeat(35)}`));
    expect(response.status).toBe(200);
    expect(mocks.browse).toHaveBeenCalledExactlyOnceWith({
      offset: 0, limit: 25, filter: "all", sort: "recent", doctorPartyId: 7, flag: "x".repeat(30),
      today: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    });
    expect(await response.json()).toMatchObject({ page: 0, pageSize: 25, filter: "all", sort: "recent", flag: "x".repeat(30) });
  });
});
