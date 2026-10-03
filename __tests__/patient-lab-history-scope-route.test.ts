/** Synthetic actual-handler tests with the real canAccessPatient policy.
 * The list boundary models only canonical filter/order/limit semantics. The
 * separate guarded PostgreSQL source exercises the actual SQL and mapper.
 * No HTTP/proxy integration or complete-archive claim is made by this suite. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LabOrder } from "../lib/lab";
import { clinicalOrder, fullOrder } from "./fixtures/lab-financial-response";

const boundary = vi.hoisted(() => ({
  session: { username: "synthetic-scope-user", role: "doctor", partyId: 601 } as
    { username: string; role: string; partyId: number } | null,
  findUserByUsername: vi.fn(), doctorOwnsPatient: vi.fn(), patientHasVisitToday: vi.fn(),
  listLabOrders: vi.fn(), listLabNames: vi.fn(), listLabServices: vi.fn(), labCounts: vi.fn(),
  createLabOrder: vi.fn(), getSettings: vi.fn(), listParties: vi.fn(), recordAudit: vi.fn(),
}));
vi.mock("@/lib/session", () => ({ requireSession: async () => boundary.session }));
vi.mock("@/lib/db", () => boundary);
import { GET } from "../app/api/lab/route";
import { HTTP_PERMISSIONS } from "../lib/http-permissions";
import { restrictedRouteAllowed } from "../lib/role-routes";

const labs = [{ labName: "Synthetic operational lab", labPhone: null }];
// Catalog counts stay global metadata; they are never patient-scoped counts.
const services = [{ id: 501, name: "Synthetic catalog", activeOrdersCount: 975 }];
const counts = { needed: 400, sent: 800 };
let records: LabOrder[];
const row = (id: number, patientId: number, dueDate = "2026-10-10"): LabOrder =>
  ({ ...fullOrder, id, patientId, sentDate: "2000-01-01", dueDate });
const withRole = (role: string) => {
  boundary.session = { username: "synthetic-scope-user", role, partyId: 601 };
};
const request = (query = "") => GET(new Request(`http://test.invalid/api/lab${query}`));
const assertNoDataReads = () => {
  expect(boundary.listLabOrders).not.toHaveBeenCalled();
  expect(boundary.listLabNames).not.toHaveBeenCalled();
  expect(boundary.listLabServices).not.toHaveBeenCalled();
  expect(boundary.labCounts).not.toHaveBeenCalled();
};

beforeEach(() => {
  vi.resetAllMocks();
  withRole("doctor");
  records = [fullOrder];
  boundary.findUserByUsername.mockResolvedValue({
    isActive: true, partyId: 601, permissions: { canViewCostPrices: false },
  });
  boundary.doctorOwnsPatient.mockResolvedValue(true);
  boundary.patientHasVisitToday.mockResolvedValue(true);
  boundary.listLabNames.mockResolvedValue(labs);
  boundary.listLabServices.mockResolvedValue(services);
  boundary.labCounts.mockResolvedValue(counts);
  boundary.listLabOrders.mockImplementation(async (filters?: { patientId?: number }) =>
    records.filter(order => filters?.patientId === undefined || order.patientId === filters.patientId)
      .sort((left, right) => left.dueDate.localeCompare(right.dueDate) || right.id - left.id)
      .slice(0, 300));
});

describe("ordinary patient-scoped lab read", () => {
  it.each(["", "&services=1"])("does not let 300 other patients crowd out target orders%s", async extra => {
    withRole("admin");
    const first = row(10_001, 101, "2025-01-01");
    const later = row(10_002, 101, "2099-01-01");
    const tiedLater = row(10_003, 101, "2099-01-01");
    records = [first, ...Array.from({ length: 300 }, (_, n) => row(n + 1, n + 1_000, "2026-01-01")), later, tiedLater];
    const response = await request(`?patientId=101${extra}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ orders: [first, tiedLater, later], labs,
      ...(extra ? { labServices: services } : {}) });
    expect(boundary.listLabOrders).toHaveBeenCalledExactlyOnceWith({ patientId: 101 });
  });

  it("retains due-date ascending/id descending and the exact default 300-row patient window", async () => {
    withRole("admin");
    records = Array.from({ length: 301 }, (_, n) => row(n + 1, 101, "2026-01-01"));
    const response = await request("?patientId=101&limit=500&status=active&doctorId=999&partyId=999");
    const body = await response.json();
    expect(body.orders).toHaveLength(300);
    expect(body.orders.map((order: LabOrder) => order.id)).toEqual(Array.from({ length: 300 }, (_, n) => 301 - n));
    expect(boundary.listLabOrders).toHaveBeenCalledExactlyOnceWith({ patientId: 101 });
    expect(body).not.toHaveProperty("total");
    expect(body).not.toHaveProperty("hasMore");
  });

  it("does not apply a daily/status filter to canonical historical patient rows", async () => {
    withRole("admin");
    const statuses = ["needed", "sent", "in_progress", "received", "delivered", "remake", "cancelled"] as const;
    records = statuses.map((status, n) => ({ ...row(n + 1, 101, `2000-01-0${n + 1}`), status,
      deliveredAt: status === "delivered" ? "2000-01-01T00:00:00.000Z" : null }));
    expect((await (await request("?patientId=101")).json()).orders).toEqual(records);
    expect(boundary.listLabOrders).toHaveBeenCalledExactlyOnceWith({ patientId: 101 });
  });

  it("preserves financial projection and every clinical field for an owning denied-cost doctor", async () => {
    const response = await request("?patientId=101&services=1");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ orders: [{ ...clinicalOrder, costMinor: null, costCurrency: null }], labs, labServices: services });
    expect(boundary.doctorOwnsPatient).toHaveBeenCalledExactlyOnceWith(601, 101);
    expect(boundary.doctorOwnsPatient.mock.invocationCallOrder[0]).toBeLessThan(boundary.listLabOrders.mock.invocationCallOrder[0]);
  });

  it.each(["admin", "reception", "doctor"])("preserves allowed financial DTOs for admitted %s", async role => {
    withRole(role);
    boundary.findUserByUsername.mockResolvedValue({ isActive: true, partyId: 601, permissions: { canViewCostPrices: true } });
    expect(await (await request("?patientId=101")).json()).toEqual({ orders: [fullOrder], labs });
  });

  it("waits for ownership before all scoped order and operational catalog reads", async () => {
    let allow!: (value: boolean) => void;
    boundary.doctorOwnsPatient.mockReturnValue(new Promise<boolean>(resolve => { allow = resolve; }));
    const pending = request("?patientId=101&services=1");
    await vi.waitFor(() => expect(boundary.doctorOwnsPatient).toHaveBeenCalledOnce());
    assertNoDataReads();
    allow(true);
    expect((await pending).status).toBe(200);
    expect(boundary.listLabOrders).toHaveBeenCalledExactlyOnceWith({ patientId: 101 });
    expect(boundary.listLabNames).toHaveBeenCalledOnce();
    expect(boundary.listLabServices).toHaveBeenCalledOnce();
  });

  it("honors canonical all-patient permission without an ownership lookup", async () => {
    boundary.findUserByUsername.mockResolvedValue({ isActive: true, partyId: null, permissions: { canViewAllPatients: true } });
    expect((await request("?patientId=101")).status).toBe(200);
    expect(boundary.doctorOwnsPatient).not.toHaveBeenCalled();
  });

  it("uses the canonical current doctor link rather than a stale session party", async () => {
    boundary.findUserByUsername.mockResolvedValue({ isActive: true, partyId: 701, permissions: {} });
    expect((await request("?patientId=101")).status).toBe(200);
    expect(boundary.doctorOwnsPatient).toHaveBeenCalledExactlyOnceWith(701, 101);
  });

  it("does not let cost visibility grant access to an unowned patient", async () => {
    boundary.findUserByUsername.mockResolvedValue({ isActive: true, partyId: 601, permissions: { canViewCostPrices: true } });
    boundary.doctorOwnsPatient.mockResolvedValue(false);
    expect((await request("?patientId=101&services=1")).status).toBe(403);
    assertNoDataReads();
  });

  it.each(["unowned", "ownership error", "missing user", "inactive", "unlinked", "lookup error"])(
    "denies %s before orders or catalogs, with no global fallback", async kind => {
      if (kind === "unowned") boundary.doctorOwnsPatient.mockResolvedValue(false);
      if (kind === "ownership error") boundary.doctorOwnsPatient.mockRejectedValue(new Error("Synthetic ownership failure"));
      if (kind === "missing user") boundary.findUserByUsername.mockResolvedValue(null);
      if (kind === "inactive") boundary.findUserByUsername.mockResolvedValue({ isActive: false, permissions: { canViewAllPatients: true } });
      if (kind === "unlinked") boundary.findUserByUsername.mockResolvedValue({ isActive: true, partyId: null });
      if (kind === "lookup error") boundary.findUserByUsername.mockRejectedValue(new Error("Synthetic user failure"));
      const response = await request("?patientId=101&services=1");
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ message: "غير مصرّح لك بالاطلاع على ملف هذا المريض." });
      assertNoDataReads();
    });

  it.each(["admin", "reception", "doctor"])("keeps a legitimate authorized empty response for %s", async role => {
    withRole(role); records = [];
    const response = await request("?patientId=101");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ orders: [], labs });
    expect(boundary.listLabOrders).toHaveBeenCalledExactlyOnceWith({ patientId: 101 });
  });

  it.each(["", "0", "-1", "  ", " 101 ", "NaN", "Infinity", "1.5", "1.0", "1e2", "0x65", "+101", "2147483648", "9007199254740992", "abc"])(
    "fails explicitly invalid patientId %j closed", async value => {
      expect((await request(`?patientId=${encodeURIComponent(value)}&services=1`)).status).toBe(400);
      assertNoDataReads();
      expect(boundary.doctorOwnsPatient).not.toHaveBeenCalled();
    });
  it.each(["patientId=101&patientId=102", "patientId=101&patientId=101", "patientId=&patientId=101", "patientId=101&patientId="])(
    "rejects repeated ordinary scope %s", async query => {
      expect((await request(`?${query}&services=1`)).status).toBe(400);
      assertNoDataReads();
      expect(boundary.doctorOwnsPatient).not.toHaveBeenCalled();
    });
  it.each([["1", 1], ["000101", 101], ["2147483647", 2_147_483_647]] as const)(
    "accepts decimal int4 boundary spelling %s as %i", async (text, id) => {
      withRole("admin"); records = [];
      expect((await request(`?patientId=${text}`)).status).toBe(200);
      expect(boundary.listLabOrders).toHaveBeenCalledExactlyOnceWith({ patientId: id });
    });
});

describe("unchanged global modes and CLINIC ceiling", () => {
  it.each(["", "?services=1", "?status=active&limit=1&doctorId=999&partyId=999"])(
    "preserves absent-scope global call and bound for %s", async query => {
      withRole("admin");
      records = Array.from({ length: 301 }, (_, n) => row(n + 1, n + 1_000, "2000-01-01"));
      const response = await request(query);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.orders.map((order: LabOrder) => order.id)).toEqual(Array.from({ length: 300 }, (_, n) => 301 - n));
      expect(boundary.listLabOrders).toHaveBeenCalledExactlyOnceWith();
      expect(boundary.doctorOwnsPatient).not.toHaveBeenCalled();
      expect(body.labs).toEqual(labs);
      if (query === "?services=1") expect(body.labServices).toEqual(services);
      else expect(body).not.toHaveProperty("labServices");
    });

  it("retains global operational rows for a doctor without patient ownership", async () => {
    boundary.doctorOwnsPatient.mockResolvedValue(false);
    expect((await request()).status).toBe(200);
    expect(boundary.doctorOwnsPatient).not.toHaveBeenCalled();
    expect(boundary.listLabOrders).toHaveBeenCalledExactlyOnceWith();
  });

  it.each(["", "&patientId=101&services=1", "&patientId=invalid", "&patientId=101&patientId=102", "&summary=0"])(
    "retains global summary=1 precedence%s without patient order/catalog reads", async extra => {
      boundary.doctorOwnsPatient.mockResolvedValue(false);
      const response = await request(`?summary=1${extra}`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(counts);
      expect(boundary.labCounts).toHaveBeenCalledExactlyOnceWith();
      expect(boundary.doctorOwnsPatient).not.toHaveBeenCalled();
      expect(boundary.listLabOrders).not.toHaveBeenCalled();
      expect(boundary.listLabNames).not.toHaveBeenCalled();
      expect(boundary.listLabServices).not.toHaveBeenCalled();
    });

  it("keeps first-value summary/services semantics without treating counts as scoped", async () => {
    const response = await request("?summary=0&summary=1&patientId=101&services=0&services=1");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ orders: [{ ...clinicalOrder, costMinor: null, costCurrency: null }], labs });
    expect(boundary.labCounts).not.toHaveBeenCalled();
    expect(boundary.listLabServices).not.toHaveBeenCalled();
    expect(boundary.listLabOrders).toHaveBeenCalledExactlyOnceWith({ patientId: 101 });
  });

  it.each(["assistant", "cashier", "accountant"])("preserves the existing forbidden %s role, including helper assistant support", async role => {
    withRole(role);
    expect(HTTP_PERMISSIONS["/api/lab"].GET).toEqual(["admin", "reception", "doctor"]);
    expect(restrictedRouteAllowed(role, "/api/lab", "GET")).toBe(false);
    for (const query of ["", "?patientId=101&services=1", "?summary=1&patientId=101"]) {
      expect((await request(query)).status).toBe(403);
    }
    assertNoDataReads();
    expect(boundary.findUserByUsername).not.toHaveBeenCalled();
    expect(boundary.patientHasVisitToday).not.toHaveBeenCalled();
    expect(boundary.doctorOwnsPatient).not.toHaveBeenCalled();
  });

  it("retains session refusal before all reads", async () => {
    boundary.session = null;
    expect((await request("?patientId=101&services=1")).status).toBe(401);
    assertNoDataReads();
    expect(boundary.findUserByUsername).not.toHaveBeenCalled();
  });

  it("keeps retrieval failure at 500 without retrying globally", async () => {
    boundary.listLabOrders.mockRejectedValue(new Error("Synthetic scoped read failure"));
    const response = await request("?patientId=101&services=1");
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ message: "تعذّر تحميل أعمال المختبر." });
    expect(boundary.listLabOrders).toHaveBeenCalledExactlyOnceWith({ patientId: 101 });
  });
});
