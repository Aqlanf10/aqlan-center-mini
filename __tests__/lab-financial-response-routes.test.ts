/** Actual handlers with synthetic boundaries. No server, DB, patient-access
 * probe or HTTP/proxy admission claim. Writers/audits receive canonical data. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clinicalOrder, financialFields, financialKinds, fullOrder, trackingEvents } from "./fixtures/lab-financial-response";

const boundary = vi.hoisted(() => ({
  session: { username: "synthetic-user", role: "doctor", partyId: 601 } as { username: string; role: string; partyId: number } | null,
  findUserByUsername: vi.fn(), createLabOrder: vi.fn(), getSettings: vi.fn(), labCounts: vi.fn(),
  listLabNames: vi.fn(), listLabOrders: vi.fn(), listLabServices: vi.fn(), listParties: vi.fn(), recordAudit: vi.fn(),
  deleteLabOrder: vi.fn(), getLabOrderById: vi.fn(), labOrderEvents: vi.fn(), setLabOrderDueDate: vi.fn(),
  setLabOrderStatus: vi.fn(), updateLabOrderAccounting: vi.fn(), listAppointmentsByDate: vi.fn(),
  ensureSchema: vi.fn(), ratesFromSettings: vi.fn(), settleLabOrdersBatch: vi.fn(),
  canAccessPatient: vi.fn(),
}));
vi.mock("@/lib/session", () => ({ requireSession: async () => boundary.session }));
vi.mock("@/lib/db", () => ({ ...boundary, CLINIC_TIME_ZONE: "UTC" }));
// Projection tests isolate patient admission; its actual helper is covered separately.
vi.mock("@/lib/patient-access", () => ({ canAccessPatient: boundary.canAccessPatient }));
import { GET, POST } from "../app/api/lab/route";
import { PATCH } from "../app/api/lab/[id]/route";
import { GET as reconciliationGET, POST as reconciliationPOST } from "../app/api/finance/lab-reconciliation/route";
import { canViewLabFinancials } from "../lib/lab-financial-visibility";

const url = "http://test.invalid";
const context = { params: Promise.resolve({ id: String(fullOrder.id) }) };
const labs = [{ labName: clinicalOrder.labName, labPhone: clinicalOrder.labPhone }];
const services = [{ id: 501, name: "Synthetic service", activeOrdersCount: 2 }];
const party = { id: 401, name: clinicalOrder.labName, currency: "SAR", phone: "synthetic-lab-phone", commissionPercent: 23 };
const deniedOrder = { ...clinicalOrder, costMinor: null, costCurrency: null };
const createDraft = {
  patientId: 101, labName: clinicalOrder.labName, workType: clinicalOrder.workType,
  sentDate: clinicalOrder.sentDate, dueDate: clinicalOrder.dueDate,
  visitId: 201, toothCode: 16, partyId: 401,
};
const jsonRequest = (path: string, method: string, body: unknown) => new Request(url + path, {
  method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});
const patch = (body: unknown) => PATCH(jsonRequest(`/api/lab/${fullOrder.id}`, "PATCH", body), context);
const withRole = (role: string) => { boundary.session = { username: "synthetic-user", role, partyId: 601 }; };
const deniedLookup = (kind: string) => {
  if (kind === "rejected") boundary.findUserByUsername.mockRejectedValue(new Error("Synthetic lookup failure"));
  else if (kind === "throws") boundary.findUserByUsername.mockImplementation(() => { throw new Error("Synthetic lookup throw"); });
  else boundary.findUserByUsername.mockResolvedValue(kind === "null" ? null : kind === "missing" ? {} : { permissions: { canViewCostPrices: false } });
};
const assertWithheld = (body: Record<string, unknown>) => {
  expect(body.costMinor).toBeNull(); expect(body.costCurrency).toBeNull();
  for (const key of Object.keys(financialFields)) {
    if (key !== "costMinor" && key !== "costCurrency") expect(body).not.toHaveProperty(key);
  }
};

beforeEach(() => {
  vi.resetAllMocks(); withRole("doctor");
  boundary.canAccessPatient.mockResolvedValue(true);
  boundary.findUserByUsername.mockResolvedValue({ permissions: { canViewCostPrices: false } });
  boundary.getSettings.mockResolvedValue({}); boundary.listParties.mockResolvedValue([party]);
  boundary.listLabOrders.mockResolvedValue([fullOrder]); boundary.listLabNames.mockResolvedValue(labs);
  boundary.listLabServices.mockResolvedValue(services); boundary.labCounts.mockResolvedValue({ needed: 2, sent: 3 });
  boundary.createLabOrder.mockResolvedValue(fullOrder); boundary.recordAudit.mockResolvedValue(undefined);
  boundary.getLabOrderById.mockResolvedValue(fullOrder); boundary.setLabOrderDueDate.mockResolvedValue(fullOrder);
  boundary.setLabOrderStatus.mockResolvedValue(fullOrder); boundary.updateLabOrderAccounting.mockResolvedValue(fullOrder);
  boundary.labOrderEvents.mockResolvedValue(trackingEvents); boundary.listAppointmentsByDate.mockResolvedValue([]);
});

describe("request-local visibility policy", () => {
  it.each(["admin", "reception", "accountant", "cashier", "assistant"])("does not add a role gate/grant for %s", async role => {
    // Projection is not admission. Existing external proxy restrictions still apply.
    expect(await canViewLabFinancials({ username: "synthetic-user", role })).toBe(true);
    expect(boundary.findUserByUsername).not.toHaveBeenCalled();
  });
  it.each(["denied", "missing", "null", "rejected", "throws"])("withholds for a doctor when lookup is %s", async kind => {
    deniedLookup(kind);
    expect(await canViewLabFinancials({ username: "synthetic-user", role: "doctor" })).toBe(false);
    expect(boundary.findUserByUsername).toHaveBeenCalledExactlyOnceWith("synthetic-user");
  });
  it("retains explicit current-user doctor permission", async () => {
    boundary.findUserByUsername.mockResolvedValue({ permissions: { canViewCostPrices: true } });
    expect(await canViewLabFinancials({ username: "synthetic-user", role: "doctor" })).toBe(true);
  });
});

describe("GET lab order response projection", () => {
  it.each(["", "?patientId=101", "?services=1", "?patientId=101&services=1"])("contains every full-list variant %s", async query => {
    const response = await GET(new Request(url + "/api/lab" + query));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ orders: [deniedOrder], labs, ...(query.includes("services=1") ? { labServices: services } : {}) });
    assertWithheld(body.orders[0]);
    if (query.includes("patientId=")) {
      expect(boundary.listLabOrders).toHaveBeenCalledExactlyOnceWith({ patientId: 101 });
      expect(boundary.canAccessPatient).toHaveBeenCalledExactlyOnceWith(boundary.session, 101);
    } else {
      expect(boundary.listLabOrders).toHaveBeenCalledExactlyOnceWith();
      expect(boundary.canAccessPatient).not.toHaveBeenCalled();
    }
    expect(boundary.findUserByUsername).toHaveBeenCalledExactlyOnceWith("synthetic-user");
  });
  it.each(["denied", "missing", "null", "rejected", "throws"])("does not leak or fail a valid read on %s visibility", async kind => {
    deniedLookup(kind); const response = await GET(new Request(url + "/api/lab?patientId=101&services=1"));
    expect(response.status).toBe(200); assertWithheld((await response.json()).orders[0]);
  });
  it.each(["admin", "reception", "doctor"])("retains complete financial DTO for permitted %s", async role => {
    withRole(role); boundary.findUserByUsername.mockResolvedValue({ permissions: { canViewCostPrices: true } });
    const response = await GET(new Request(url + "/api/lab"));
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ orders: [fullOrder], labs });
  });
  it("retains summary precedence and counts, even if visibility lookup fails", async () => {
    deniedLookup("rejected"); const response = await GET(new Request(url + "/api/lab?summary=1&patientId=101&services=1"));
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ needed: 2, sent: 3 });
    expect(boundary.listLabOrders).not.toHaveBeenCalled(); expect(boundary.listLabServices).not.toHaveBeenCalled();
  });
  it("preserves a legitimate empty result from the canonical patient-scoped list", async () => {
    boundary.listLabOrders.mockResolvedValue([]);
    const response = await GET(new Request(url + "/api/lab?patientId=102"));
    expect(await response.json()).toEqual({ orders: [], labs });
    expect(boundary.listLabOrders).toHaveBeenCalledExactlyOnceWith({ patientId: 102 });
  });
  it("retains session refusal before current-user or order reads", async () => {
    boundary.session = null; const response = await GET(new Request(url + "/api/lab"));
    expect(response.status).toBe(401); expect(boundary.findUserByUsername).not.toHaveBeenCalled(); expect(boundary.listLabOrders).not.toHaveBeenCalled();
  });
});

describe("POST response only; canonical write and full-cost audit preserved", () => {
  it.each(["denied", "missing", "null", "rejected", "throws"])("keeps committed success and writer/audit data with %s lookup", async kind => {
    deniedLookup(kind); const original = structuredClone(fullOrder);
    const response = await POST(jsonRequest("/api/lab", "POST", createDraft));
    expect(response.status).toBe(201); expect(await response.json()).toEqual(deniedOrder);
    expect(boundary.createLabOrder).toHaveBeenCalledExactlyOnceWith({
      patientId: 101, labName: clinicalOrder.labName, labPhone: null, workType: clinicalOrder.workType,
      details: null, sentDate: clinicalOrder.sentDate, dueDate: clinicalOrder.dueDate, note: null,
      partyId: 401, costMinor: null, costCurrency: null, baseCurrency: "YER", exchangeRate: 1,
      createdBy: "synthetic-user", visitId: 201, toothCode: 16, source: "manual", status: "sent",
      labServiceId: null, doctorId: 601, toothNumbers: null, shade: null, stumpShade: null,
      priority: "normal", impressionType: "physical", technicianName: null, actorRole: "doctor",
      expenseCategoryId: null, expenseAccountCode: null, payableAccountCode: null, isPosted: true,
    });
    expect(boundary.recordAudit).toHaveBeenCalledExactlyOnceWith({
      action: "lab_order.create", entity: "lab_order", entityId: "731",
      entityLabel: `أمر معمل: ${fullOrder.patientName} (${fullOrder.labName})`,
      details: { العمل: fullOrder.workType, الموعد: fullOrder.dueDate, المصدر: "manual", التكلفة: fullOrder.costMinor, العملة: fullOrder.costCurrency },
      actor: "synthetic-user", actorRole: "doctor",
    });
    expect(boundary.findUserByUsername.mock.invocationCallOrder[0]).toBeLessThan(boundary.createLabOrder.mock.invocationCallOrder[0]);
    expect(fullOrder).toEqual(original);
  });
  it.each(["admin", "reception", "doctor"])("keeps allowed %s success DTO exact", async role => {
    withRole(role); boundary.findUserByUsername.mockResolvedValue({ permissions: { canViewCostPrices: true } });
    const response = await POST(jsonRequest("/api/lab", "POST", createDraft));
    expect(response.status).toBe(201); expect(await response.json()).toEqual(fullOrder);
  });
});

describe("PATCH response and event containment", () => {
  it.each(["denied", "missing", "null", "rejected", "throws"])("keeps due-date save successful with %s lookup", async kind => {
    deniedLookup(kind); const response = await patch({ dueDate: "2026-10-12" });
    expect(response.status).toBe(200); expect(await response.json()).toEqual(deniedOrder);
    expect(boundary.setLabOrderDueDate).toHaveBeenCalledExactlyOnceWith(731, "2026-10-12");
    expect(boundary.findUserByUsername.mock.invocationCallOrder[0]).toBeLessThan(boundary.setLabOrderDueDate.mock.invocationCallOrder[0]);
    expect(boundary.recordAudit).not.toHaveBeenCalled();
  });
  it("retains clinical status writer arguments and raw cancellation audit when denied", async () => {
    deniedLookup("rejected"); boundary.getLabOrderById.mockResolvedValue({ ...fullOrder, status: "needed" });
    const response = await patch({ status: "cancelled", note: "  Synthetic cancellation note  " });
    expect(response.status).toBe(200); expect(await response.json()).toEqual(deniedOrder);
    expect(boundary.setLabOrderStatus).toHaveBeenCalledExactlyOnceWith(731, "cancelled", {
      actor: "synthetic-user", actorRole: "doctor", notes: "Synthetic cancellation note",
    });
    expect(boundary.recordAudit).toHaveBeenCalledExactlyOnceWith({
      action: "lab_order.cancel", entity: "lab_order", entityId: 731,
      entityLabel: `${fullOrder.patientName} — ${fullOrder.workType}`,
      details: { labName: fullOrder.labName, teeth: fullOrder.toothNumbers, costMinor: fullOrder.costMinor,
        costCurrency: fullOrder.costCurrency, note: "  Synthetic cancellation note  " },
      actor: "synthetic-user", actorRole: "doctor",
    });
    expect(boundary.findUserByUsername.mock.invocationCallOrder[0]).toBeLessThan(boundary.setLabOrderStatus.mock.invocationCallOrder[0]);
    expect(fullOrder.costMinor).toBe(financialFields.costMinor);
  });
  it.each(["admin", "reception", "doctor"])("retains allowed %s clinical-update DTOs", async role => {
    withRole(role); boundary.findUserByUsername.mockResolvedValue({ permissions: { canViewCostPrices: true } });
    expect(await (await patch({ dueDate: "2026-10-12" })).json()).toEqual(fullOrder);
    expect(await (await patch({ status: "received", note: "Clinical receipt" })).json()).toEqual(fullOrder);
    expect(boundary.setLabOrderStatus).toHaveBeenCalledExactlyOnceWith(731, "received", {
      actor: "synthetic-user", actorRole: role, notes: "Clinical receipt",
    });
  });
  it.each(["update_accounting", "post", "unpost"])("keeps %s blocked for doctors even with cost visibility", async action => {
    boundary.findUserByUsername.mockResolvedValue({ permissions: { canViewCostPrices: true } });
    expect((await patch({ action })).status).toBe(403); expect(boundary.updateLabOrderAccounting).not.toHaveBeenCalled();
  });
  it.each(["admin", "reception"])("keeps accounting write and full DTO for %s", async role => {
    withRole(role); const response = await patch({ action: "post", expenseCategoryId: 88, expenseAccountCode: " 5123 ", payableAccountCode: " 2123 " });
    expect(response.status).toBe(200); expect(await response.json()).toEqual(fullOrder);
    expect(boundary.updateLabOrderAccounting).toHaveBeenCalledExactlyOnceWith(731, {
      expenseCategoryId: 88, expenseAccountCode: "5123", payableAccountCode: "2123", isPosted: true,
      costMinor: undefined, costCurrency: undefined, exchangeRate: undefined, actor: "synthetic-user", actorRole: role,
    });
  });
  it("retains nonadmin refusal for cancellation of a sent order", async () => {
    expect((await patch({ status: "cancelled" })).status).toBe(403);
    expect(boundary.setLabOrderStatus).not.toHaveBeenCalled(); expect(boundary.recordAudit).not.toHaveBeenCalled();
  });
  it.each(["denied", "missing", "null", "rejected", "throws"])("filters structured financial events with %s visibility", async kind => {
    deniedLookup(kind); const response = await patch({ action: "events" });
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ events: trackingEvents.filter(event => !financialKinds.includes(event.action)) });
    expect(boundary.labOrderEvents).toHaveBeenCalledExactlyOnceWith(731);
    expect(boundary.setLabOrderStatus).not.toHaveBeenCalled(); expect(boundary.recordAudit).not.toHaveBeenCalled();
  });
  it.each(["admin", "reception", "doctor"])("preserves complete event DTOs for permitted %s", async role => {
    withRole(role); boundary.findUserByUsername.mockResolvedValue({ permissions: { canViewCostPrices: true } });
    expect(await (await patch({ action: "events" })).json()).toEqual({ events: trackingEvents });
  });
});

describe("financial reconciliation denial before reads; allowed responses unchanged", () => {
  it.each(["denied", "missing", "null", "rejected", "throws"])("rejects %s doctor before global/party finance and appointment reads", async kind => {
    deniedLookup(kind);
    for (const query of ["", "?partyId=401"]) {
      const response = await reconciliationGET(new Request(url + "/api/finance/lab-reconciliation" + query));
      expect(response.status).toBe(403); const body = await response.json();
      expect(body).toEqual({ message: "عرض مطابقة المختبر يحتاج صلاحية الاطلاع على أسعار التكلفة." });
    }
    expect(boundary.listParties).not.toHaveBeenCalled(); expect(boundary.listLabOrders).not.toHaveBeenCalled();
    expect(boundary.listAppointmentsByDate).not.toHaveBeenCalled(); expect(boundary.getSettings).not.toHaveBeenCalled();
  });
  it.each(["admin", "reception", "accountant", "doctor"])("preserves complete financial calculations for permitted %s", async role => {
    withRole(role); boundary.findUserByUsername.mockResolvedValue({ permissions: { canViewCostPrices: true } });
    const global = await reconciliationGET(new Request(url + "/api/finance/lab-reconciliation"));
    expect(global.status).toBe(200); expect(await global.json()).toEqual({
      labs: [{ partyId: 401, partyName: party.name, currency: "SAR", phone: party.phone, activeOrdersCount: 1,
        unsettledOrdersCount: 1, unsettledCostMinor: fullOrder.costMinor }], risks: [], totalRisksCount: 0,
    });
    const scoped = await reconciliationGET(new Request(url + "/api/finance/lab-reconciliation?partyId=401"));
    expect(scoped.status).toBe(200); expect(await scoped.json()).toEqual({ party, orders: [{
      orderId: 731, patientName: fullOrder.patientName, patientNumber: fullOrder.patientNumber,
      workType: fullOrder.workType, teeth: fullOrder.toothNumbers, sentDate: fullOrder.sentDate,
      dueDate: fullOrder.dueDate, systemCostMinor: fullOrder.costMinor, currency: "SAR", status: fullOrder.status,
      financialStatus: fullOrder.financialStatus, notes: fullOrder.details,
    }], unsettledCount: 1, risks: [] });
    expect(boundary.listLabOrders).toHaveBeenCalledWith({ limit: 300 });
  });
  it.each(["doctor", "reception", "accountant"])("keeps POST admin-only for %s without consulting visibility", async role => {
    withRole(role); boundary.findUserByUsername.mockResolvedValue({ permissions: { canViewCostPrices: true } });
    const response = await reconciliationPOST(jsonRequest("/api/finance/lab-reconciliation", "POST", { partyId: 401, orderIds: [731], amountMinor: 50, currency: "YER" }));
    expect(response.status).toBe(403); expect(boundary.findUserByUsername).not.toHaveBeenCalled();
    expect(boundary.settleLabOrdersBatch).not.toHaveBeenCalled(); expect(boundary.ensureSchema).not.toHaveBeenCalled();
  });
  it("retains reconciliation session refusal", async () => {
    boundary.session = null; expect((await reconciliationGET(new Request(url + "/api/finance/lab-reconciliation"))).status).toBe(401);
    expect(boundary.listLabOrders).not.toHaveBeenCalled(); expect(boundary.findUserByUsername).not.toHaveBeenCalled();
  });
});

describe("unchanged reconciliation POST success", () => {
  it("preserves canonical admin settlement/audit arguments and success payload", async () => {
    withRole("admin"); boundary.ratesFromSettings.mockReturnValue({ YER: 1 });
    boundary.settleLabOrdersBatch.mockResolvedValue({ ok: true, partyName: party.name, orderIds: [731], expense: {
      id: 811, voucherNumber: "SYNTHETIC-VOUCHER-811", exchangeRate: 1, baseAmountMinor: 50,
    } });
    const response = await reconciliationPOST(jsonRequest("/api/finance/lab-reconciliation", "POST", {
      partyId: 401, orderIds: [731], amountMinor: 50, currency: "YER", note: "Synthetic settlement", monthLabel: "2026-10",
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, voucherNumber: "SYNTHETIC-VOUCHER-811", expenseId: 811,
      settledCount: 1, totalPaidMinor: 50, currency: "YER",
      message: "تم بنجاح سداد وتسوية 1 أمر مختبر بسند صرف رقم SYNTHETIC-VOUCHER-811.",
    });
    expect(boundary.settleLabOrdersBatch).toHaveBeenCalledExactlyOnceWith({
      partyId: 401, orderIds: [731], amountMinor: 50, currency: "YER", baseCurrency: "YER", exchangeRate: 1,
      note: "Synthetic settlement", monthLabel: "2026-10", createdBy: "synthetic-user", actorRole: "admin",
      rates: { YER: 1 }, rateOverrideReason: null, prepaymentReason: null,
    });
    expect(boundary.recordAudit).toHaveBeenCalledExactlyOnceWith({
      action: "expense.create", actor: "synthetic-user", actorRole: "admin", entity: "expense", entityId: 811,
      entityLabel: "SYNTHETIC-VOUCHER-811", details: { type: "lab_batch_reconciliation", partyId: 401,
        partyName: party.name, voucherNumber: "SYNTHETIC-VOUCHER-811", settledOrdersCount: 1, orderIds: [731],
        amountMinor: 50, currency: "YER", سعر_الدفع: 1, المكافئ: 50 },
    });
    expect(boundary.findUserByUsername).not.toHaveBeenCalled();
  });
});

describe("visibility settles before any writer", () => {
  it.each(["create", "due-date", "status"])("waits for a pending lookup before %s and then saves on lookup rejection", async operation => {
    let started!: () => void;
    let rejectLookup!: (reason: Error) => void;
    const lookupStarted = new Promise<void>(resolve => { started = resolve; });
    const pendingLookup = new Promise<never>((_resolve, reject) => { rejectLookup = reject; });
    boundary.findUserByUsername.mockImplementation(() => { started(); return pendingLookup; });
    const saving = operation === "create"
      ? POST(jsonRequest("/api/lab", "POST", createDraft))
      : patch(operation === "due-date" ? { dueDate: "2026-10-12" } : { status: "received" });
    await lookupStarted;
    expect(boundary.createLabOrder).not.toHaveBeenCalled();
    expect(boundary.setLabOrderDueDate).not.toHaveBeenCalled();
    expect(boundary.setLabOrderStatus).not.toHaveBeenCalled();
    expect(boundary.recordAudit).not.toHaveBeenCalled();
    rejectLookup(new Error("Synthetic late lookup rejection"));
    const response = await saving;
    expect(response.status).toBe(operation === "create" ? 201 : 200);
    expect(await response.json()).toEqual(deniedOrder);
    const writer = operation === "create" ? boundary.createLabOrder
      : operation === "due-date" ? boundary.setLabOrderDueDate : boundary.setLabOrderStatus;
    expect(writer).toHaveBeenCalledTimes(1);
    expect(boundary.findUserByUsername).toHaveBeenCalledExactlyOnceWith("synthetic-user");
  });
});
