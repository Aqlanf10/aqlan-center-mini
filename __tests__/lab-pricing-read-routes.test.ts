/** Actual route handlers and shared visibility policy with synthetic session/DB
 * boundaries only. No HTTP/proxy admission, real database or production claim. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LabPricingRule } from "../lib/lab";

const boundary = vi.hoisted(() => ({
  requireSession: vi.fn(),
  findUserByUsername: vi.fn(),
  listLabPricingRules: vi.fn(),
  resolveLabOrderPrice: vi.fn(),
  createLabPricingRule: vi.fn(),
  getLaboratory: vi.fn(),
  getLabService: vi.fn(),
  recordAudit: vi.fn(),
  getPool: vi.fn(),
  query: vi.fn(),
  updateLabPricingRule: vi.fn(),
  deleteLabPricingRule: vi.fn(),
}));
vi.mock("@/lib/session", () => ({ requireSession: boundary.requireSession }));
vi.mock("@/lib/db", () => ({ ...boundary, CLINIC_TIME_ZONE: "Asia/Aden" }));

import { GET, POST } from "../app/api/lab/pricing/route";
import { DELETE, PUT } from "../app/api/lab/pricing/[id]/route";
import { canViewLabFinancials } from "../lib/lab-financial-visibility";

const baseUrl = "http://test.invalid/api/lab/pricing";
const username = "synthetic-pricing-user";
const noSession = { message: "انتهت الجلسة. سجّل الدخول من جديد." };
const withheld = {
  code: "lab_pricing_withheld",
  message: "عرض أسعار تكلفة المختبر غير متاح لحسابك.",
};
const rule: LabPricingRule = {
  id: 701, partyId: 401, partyName: "Synthetic pricing lab",
  labServiceId: 501, serviceName: "Synthetic pricing service",
  costMinor: 12345, costCurrency: "SAR", effectiveFrom: "2026-10-03",
  effectiveTo: "2026-11-03", note: "Synthetic pricing note",
  createdBy: username, createdAt: "2026-10-03T09:00:00.000Z",
};
const resolvedPrice = { costMinor: rule.costMinor, costCurrency: rule.costCurrency, ruleId: rule.id };
const lab = { id: rule.partyId, name: rule.partyName };
const service = { id: rule.labServiceId, name: rule.serviceName };
const createDraft = {
  partyId: "401", labServiceId: "501", costMinor: "12345", costCurrency: "SAR",
  effectiveFrom: "2026-10-03", effectiveTo: " 2026-11-03 ", note: "  Synthetic pricing note  ",
};
const context = () => ({ params: Promise.resolve({ id: String(rule.id) }) });
const request = (query = "") => new Request(baseUrl + query);
const jsonRequest = (method: string, body: unknown) => new Request(
  method === "POST" ? baseUrl : `${baseUrl}/${rule.id}`,
  { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
);
const withRole = (role: string) => boundary.requireSession.mockResolvedValue({ username, role, partyId: 601 });
const allowDoctor = () => boundary.findUserByUsername.mockResolvedValue({ permissions: { canViewCostPrices: true } });
const deniedStates = ["false", "missing-permissions", "null-permissions", "null-user", "missing-user", "rejected", "throws"] as const;
type DeniedState = typeof deniedStates[number];
function denyLookup(kind: DeniedState) {
  if (kind === "rejected") boundary.findUserByUsername.mockRejectedValue(new Error("Synthetic lookup rejection"));
  else if (kind === "throws") boundary.findUserByUsername.mockImplementation(() => { throw new Error("Synthetic lookup throw"); });
  else boundary.findUserByUsername.mockResolvedValue(
    kind === "null-user" ? null : kind === "missing-user" ? undefined
      : kind === "missing-permissions" ? {} : { permissions: kind === "null-permissions" ? null : { canViewCostPrices: false } },
  );
}
function expectNoPricingReaders() {
  expect(boundary.listLabPricingRules).not.toHaveBeenCalled();
  expect(boundary.resolveLabOrderPrice).not.toHaveBeenCalled();
}
function expectNoWrites() {
  expect(boundary.createLabPricingRule).not.toHaveBeenCalled();
  expect(boundary.updateLabPricingRule).not.toHaveBeenCalled();
  expect(boundary.deleteLabPricingRule).not.toHaveBeenCalled();
  expect(boundary.recordAudit).not.toHaveBeenCalled();
  expect(boundary.getPool).not.toHaveBeenCalled();
  expect(boundary.query).not.toHaveBeenCalled();
}
function expectNoCatalogueReaders() {
  expect(boundary.getLaboratory).not.toHaveBeenCalled();
  expect(boundary.getLabService).not.toHaveBeenCalled();
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise; reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.resetAllMocks();
  withRole("doctor");
  denyLookup("false");
  boundary.listLabPricingRules.mockResolvedValue([rule]);
  boundary.resolveLabOrderPrice.mockResolvedValue(resolvedPrice);
  boundary.createLabPricingRule.mockResolvedValue(rule);
  boundary.getLaboratory.mockResolvedValue(lab);
  boundary.getLabService.mockResolvedValue(service);
  boundary.recordAudit.mockResolvedValue(undefined);
  boundary.getPool.mockReturnValue({ query: boundary.query });
  boundary.query.mockResolvedValue({ rows: [] });
  boundary.updateLabPricingRule.mockResolvedValue(rule);
  boundary.deleteLabPricingRule.mockResolvedValue(true);
});
afterEach(() => { vi.useRealTimers(); });

describe("real shared current-user cost visibility policy", () => {
  it.each(deniedStates)("fails closed for doctor lookup state %s", async kind => {
    denyLookup(kind);
    expect(await canViewLabFinancials({ username, role: "doctor" })).toBe(false);
    expect(boundary.findUserByUsername).toHaveBeenCalledExactlyOnceWith(username);
    expectNoPricingReaders(); expectNoWrites();
  });
  it("allows explicit current-user cost visibility without requiring clinic-wide finance", async () => {
    boundary.findUserByUsername.mockResolvedValue({ permissions: {
      canViewCostPrices: true, financialScope: "own_commissions_only",
      canViewClinicRevenue: false, canViewClinicFinance: false,
    } });
    expect(await canViewLabFinancials({ username, role: "doctor" })).toBe(true);
    expect(boundary.findUserByUsername).toHaveBeenCalledExactlyOnceWith(username);
  });
  it("does not treat unrelated clinic finance permission as cost permission", async () => {
    boundary.findUserByUsername.mockResolvedValue({ permissions: {
      financialScope: "clinic_and_own", canViewClinicRevenue: true, canViewClinicFinance: true,
    } });
    expect(await canViewLabFinancials({ username, role: "doctor" })).toBe(false);
  });
  it.each(["admin", "reception"])("preserves existing %s visibility without a user lookup", async role => {
    denyLookup("throws");
    expect(await canViewLabFinancials({ username, role })).toBe(true);
    expect(boundary.findUserByUsername).not.toHaveBeenCalled();
  });
});

describe("pricing GET refusal before URL parsing or pricing reads", () => {
  const variants = [
    "", "?partyId=401", "?labServiceId=501", "?partyId=401&labServiceId=501",
    "?resolve=1&partyId=401&labServiceId=501&date=2026-10-08",
    "?resolve=true&partyId=401&labServiceId=501&date=invalid",
    "?resolve=1&partyId=401", "?resolve=0&partyId=401&labServiceId=501",
    "?resolve=1&partyId=not-a-number&labServiceId=501&canViewCostPrices=true",
  ];
  it.each(variants)("retains missing-session 401 for %s", async query => {
    boundary.requireSession.mockResolvedValue(null);
    const response = await GET(request(query));
    expect(response.status).toBe(401); expect(await response.json()).toEqual(noSession);
    expect(boundary.requireSession).toHaveBeenCalledExactlyOnceWith();
    expect(boundary.findUserByUsername).not.toHaveBeenCalled();
    expectNoPricingReaders(); expectNoCatalogueReaders(); expectNoWrites();
  });
  describe.each(deniedStates)("current-user lookup: %s", kind => {
    it.each(variants)("returns exact withheld response with no financial reads for %s", async query => {
      denyLookup(kind);
      const response = await GET(request(query));
      expect(response.status).toBe(403); expect(await response.json()).toEqual(withheld);
      expect(boundary.findUserByUsername).toHaveBeenCalledExactlyOnceWith(username);
      expect(boundary.requireSession.mock.invocationCallOrder[0]).toBeLessThan(boundary.findUserByUsername.mock.invocationCallOrder[0]);
      expectNoPricingReaders(); expectNoCatalogueReaders(); expectNoWrites();
    });
  });
  it.each(["missing-session", "denied-doctor"])("refuses %s without reading request.url", async kind => {
    if (kind === "missing-session") boundary.requireSession.mockResolvedValue(null);
    const guardedRequest = request();
    Object.defineProperty(guardedRequest, "url", { get() { throw new Error("URL must remain unread before refusal"); } });
    const response = await GET(guardedRequest);
    expect(response.status).toBe(kind === "missing-session" ? 401 : 403);
    expect(await response.json()).toEqual(kind === "missing-session" ? noSession : withheld);
    expectNoPricingReaders(); expectNoWrites();
  });
  it("uses the current user rather than a stale session cost grant", async () => {
    boundary.requireSession.mockResolvedValue({ username, role: "doctor", permissions: { canViewCostPrices: true } });
    const response = await GET(request("?resolve=true&partyId=401&labServiceId=501"));
    expect(response.status).toBe(403); expect(await response.json()).toEqual(withheld);
    expect(boundary.findUserByUsername).toHaveBeenCalledExactlyOnceWith(username);
    expectNoPricingReaders();
  });
});

describe("allowed pricing GET response and argument compatibility", () => {
  it.each(["doctor", "admin", "reception"])("retains complete list and resolved DTOs for %s", async role => {
    withRole(role); allowDoctor();
    const original = structuredClone(rule);
    const listed = await GET(request("?partyId=401&labServiceId=501"));
    expect(listed.status).toBe(200); expect(await listed.json()).toEqual({ rules: [rule] });
    expect(boundary.listLabPricingRules).toHaveBeenCalledExactlyOnceWith(401, 501);
    const resolved = await GET(request("?resolve=true&partyId=401&labServiceId=501&date=2026-10-08"));
    expect(resolved.status).toBe(200); expect(await resolved.json()).toEqual({ resolved: resolvedPrice });
    expect(boundary.resolveLabOrderPrice).toHaveBeenCalledExactlyOnceWith(401, 501, "2026-10-08");
    expect(boundary.findUserByUsername).toHaveBeenCalledTimes(role === "doctor" ? 2 : 0);
    expect(rule).toEqual(original); expectNoCatalogueReaders(); expectNoWrites();
  });
  it.each([
    { query: "", partyId: undefined, serviceId: undefined },
    { query: "?partyId=401", partyId: 401, serviceId: undefined },
    { query: "?labServiceId=501", partyId: undefined, serviceId: 501 },
    { query: "?partyId=401&labServiceId=501", partyId: 401, serviceId: 501 },
    { query: "?resolve=1&partyId=401", partyId: 401, serviceId: undefined },
    { query: "?resolve=true&labServiceId=501", partyId: undefined, serviceId: 501 },
    { query: "?resolve=0&partyId=401&labServiceId=501", partyId: 401, serviceId: 501 },
    { query: "?resolve=TRUE&partyId=401&labServiceId=501", partyId: 401, serviceId: 501 },
    { query: "?resolve=1&partyId=0&labServiceId=501", partyId: 0, serviceId: 501 },
    { query: "?resolve=1&partyId=invalid&labServiceId=501", partyId: Number.NaN, serviceId: 501 },
    { query: "?partyId=&labServiceId=", partyId: undefined, serviceId: undefined },
  ])("preserves list parsing and resolve fallback for $query", async ({ query, partyId, serviceId }) => {
    allowDoctor();
    const response = await GET(request(query));
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ rules: [rule] });
    expect(boundary.listLabPricingRules).toHaveBeenCalledExactlyOnceWith(partyId, serviceId);
    expect(boundary.resolveLabOrderPrice).not.toHaveBeenCalled();
  });
  it.each(["1", "true"])("preserves exact supplied resolver date for resolve=%s", async resolve => {
    allowDoctor();
    const response = await GET(request(`?resolve=${resolve}&partyId=401&labServiceId=501&date=2026-10-08`));
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ resolved: resolvedPrice });
    expect(boundary.resolveLabOrderPrice).toHaveBeenCalledExactlyOnceWith(401, 501, "2026-10-08");
    expect(boundary.listLabPricingRules).not.toHaveBeenCalled();
  });
  it.each(["", "&date=", "&date=not-a-date", "&date=2026-1-8"])("retains clinic-date resolver fallback for %s", async dateQuery => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-03T22:30:00.000Z"));
    allowDoctor();
    const response = await GET(request(`?resolve=1&partyId=401&labServiceId=501${dateQuery}`));
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ resolved: resolvedPrice });
    // The mocked DB configuration uses Asia/Aden, already on the following day.
    expect(boundary.resolveLabOrderPrice).toHaveBeenCalledExactlyOnceWith(401, 501, "2026-10-04");
    expect(boundary.listLabPricingRules).not.toHaveBeenCalled();
  });
  it("retains a legitimate resolver null result", async () => {
    allowDoctor(); boundary.resolveLabOrderPrice.mockResolvedValue(null);
    const response = await GET(request("?resolve=1&partyId=401&labServiceId=501&date=2026-10-08"));
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ resolved: null });
    expect(boundary.resolveLabOrderPrice).toHaveBeenCalledExactlyOnceWith(401, 501, "2026-10-08");
    expect(boundary.listLabPricingRules).not.toHaveBeenCalled();
  });
  it("retains a legitimate empty rule list", async () => {
    allowDoctor(); boundary.listLabPricingRules.mockResolvedValue([]);
    const response = await GET(request("?partyId=401"));
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ rules: [] });
    expect(boundary.listLabPricingRules).toHaveBeenCalledExactlyOnceWith(401, undefined);
  });
  describe.each(["list", "resolve"])("%s reader failures", operation => {
    it.each(["rejected", "throws"])("retains the existing 500 response for %s failures", async failure => {
      allowDoctor();
      const reader = operation === "list" ? boundary.listLabPricingRules : boundary.resolveLabOrderPrice;
      const error = new Error("Synthetic pricing reader failure");
      if (failure === "rejected") reader.mockRejectedValue(error);
      else reader.mockImplementation(() => { throw error; });
      const response = await GET(request(`?partyId=401&labServiceId=501${operation === "resolve" ? "&resolve=1&date=2026-10-08" : ""}`));
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ message: "تعذّر تحميل جدول تسعير خدمات المختبرات." });
      if (operation === "list") {
        expect(reader).toHaveBeenCalledExactlyOnceWith(401, 501);
        expect(boundary.resolveLabOrderPrice).not.toHaveBeenCalled();
      } else {
        expect(reader).toHaveBeenCalledExactlyOnceWith(401, 501, "2026-10-08");
        expect(boundary.listLabPricingRules).not.toHaveBeenCalled();
      }
      expectNoWrites();
    });
  });
  it("rechecks current permission on each request rather than caching a grant", async () => {
    boundary.findUserByUsername.mockResolvedValueOnce({ permissions: { canViewCostPrices: true } })
      .mockResolvedValueOnce({ permissions: { canViewCostPrices: false } });
    expect((await GET(request())).status).toBe(200);
    const denied = await GET(request("?resolve=1&partyId=401&labServiceId=501"));
    expect(denied.status).toBe(403); expect(await denied.json()).toEqual(withheld);
    expect(boundary.findUserByUsername).toHaveBeenCalledTimes(2);
    expect(boundary.listLabPricingRules).toHaveBeenCalledExactlyOnceWith(undefined, undefined);
    expect(boundary.resolveLabOrderPrice).not.toHaveBeenCalled();
  });
});

describe.each(["list", "resolve"])("pending visibility before %s reads", operation => {
  it.each(["allow", "deny", "reject"])("waits without parsing or readers, then handles %s", async outcome => {
    const started = deferred<void>();
    const lookup = deferred<unknown>();
    boundary.findUserByUsername.mockImplementation(() => { started.resolve(undefined); return lookup.promise; });
    const query = operation === "list" ? "?partyId=401&labServiceId=501" : "?resolve=1&partyId=401&labServiceId=501&date=2026-10-08";
    const pendingRequest = request(query);
    let urlReads = 0;
    Object.defineProperty(pendingRequest, "url", { get() { urlReads += 1; return baseUrl + query; } });
    const reading = GET(pendingRequest);
    await started.promise;
    expect(urlReads).toBe(0); expectNoPricingReaders(); expectNoCatalogueReaders(); expectNoWrites();
    if (outcome === "reject") lookup.reject(new Error("Synthetic late lookup rejection"));
    else lookup.resolve({ permissions: { canViewCostPrices: outcome === "allow" } });
    const response = await reading;
    expect(boundary.findUserByUsername).toHaveBeenCalledExactlyOnceWith(username);
    if (outcome === "allow") {
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(operation === "list" ? { rules: [rule] } : { resolved: resolvedPrice });
      expect(urlReads).toBe(1);
      if (operation === "list") {
        expect(boundary.listLabPricingRules).toHaveBeenCalledExactlyOnceWith(401, 501);
        expect(boundary.resolveLabOrderPrice).not.toHaveBeenCalled();
      } else {
        expect(boundary.resolveLabOrderPrice).toHaveBeenCalledExactlyOnceWith(401, 501, "2026-10-08");
        expect(boundary.listLabPricingRules).not.toHaveBeenCalled();
      }
    } else {
      expect(response.status).toBe(403); expect(await response.json()).toEqual(withheld);
      expect(urlReads).toBe(0); expectNoPricingReaders();
    }
    expectNoWrites();
  });
});

describe("unchanged pricing POST admission and canonical write", () => {
  it("keeps the existing missing-session refusal", async () => {
    boundary.requireSession.mockResolvedValue(null);
    const response = await POST(jsonRequest("POST", createDraft));
    expect(response.status).toBe(401); expect(await response.json()).toEqual(noSession);
    expect(boundary.findUserByUsername).not.toHaveBeenCalled();
    expectNoPricingReaders(); expectNoCatalogueReaders(); expectNoWrites();
  });
  it.each(["doctor", "reception", "accountant", "cashier", "assistant"])("keeps %s blocked even with cost visibility", async role => {
    withRole(role); allowDoctor();
    const response = await POST(jsonRequest("POST", createDraft));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ message: "إدارة تسعير خدمات المختبرات للمدير وحده." });
    expect(boundary.findUserByUsername).not.toHaveBeenCalled();
    expectNoPricingReaders(); expectNoCatalogueReaders(); expectNoWrites();
  });
  it.each([false, true])("preserves exact admin create/audit inputs with closePreviousRule=%s", async closePreviousRule => {
    withRole("admin"); denyLookup("throws");
    const original = structuredClone(rule);
    const response = await POST(jsonRequest("POST", { ...createDraft, closePreviousRule }));
    expect(response.status).toBe(201); expect(await response.json()).toEqual({ rule });
    expect(boundary.findUserByUsername).not.toHaveBeenCalled();
    expect(boundary.getLaboratory).toHaveBeenCalledExactlyOnceWith(401);
    expect(boundary.getLabService).toHaveBeenCalledExactlyOnceWith(501);
    expect(boundary.createLabPricingRule).toHaveBeenCalledExactlyOnceWith({
      partyId: 401, labServiceId: 501, costMinor: 12345, costCurrency: "SAR",
      effectiveFrom: "2026-10-03", effectiveTo: "2026-11-03", note: "Synthetic pricing note", createdBy: username,
    });
    expect(boundary.recordAudit).toHaveBeenCalledExactlyOnceWith({
      actor: username, actorRole: "admin", action: "lab_pricing.create", entity: "lab_pricing_rule", entityId: "701",
      entityLabel: "Synthetic pricing lab — Synthetic pricing service (12345 SAR)",
      details: {
        id: 701, partyId: 401, labName: lab.name, labServiceId: 501, serviceName: service.name,
        costMinor: 12345, costCurrency: "SAR", effectiveFrom: "2026-10-03", effectiveTo: "2026-11-03", note: "Synthetic pricing note",
      },
    });
    if (closePreviousRule) {
      expect(boundary.getPool).toHaveBeenCalledExactlyOnceWith();
      expect(boundary.query).toHaveBeenCalledTimes(1);
      const [sql, values] = boundary.query.mock.calls[0];
      expect((sql as string).replace(/\s+/g, " ").trim()).toBe(
        "UPDATE lab_pricing_rules SET effective_to = ($3::date - INTERVAL '1 day') WHERE party_id = $1 AND lab_service_id = $2 AND effective_from < $3::date AND (effective_to IS NULL OR effective_to >= $3::date)",
      );
      expect(values).toEqual([401, 501, "2026-10-03"]);
      expect(boundary.query.mock.invocationCallOrder[0]).toBeLessThan(boundary.createLabPricingRule.mock.invocationCallOrder[0]);
    } else {
      expect(boundary.getPool).not.toHaveBeenCalled(); expect(boundary.query).not.toHaveBeenCalled();
    }
    expect(boundary.createLabPricingRule.mock.invocationCallOrder[0]).toBeLessThan(boundary.recordAudit.mock.invocationCallOrder[0]);
    expect(boundary.updateLabPricingRule).not.toHaveBeenCalled(); expect(boundary.deleteLabPricingRule).not.toHaveBeenCalled();
    expectNoPricingReaders(); expect(rule).toEqual(original);
  });
  it("retains admin decimal-cost parsing, null optional fields and clinic-date default", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-03T22:30:00.000Z"));
    withRole("admin");
    const response = await POST(jsonRequest("POST", { partyId: 401, labServiceId: 501, cost: "12.34", costCurrency: "SAR" }));
    expect(response.status).toBe(201);
    expect(boundary.createLabPricingRule).toHaveBeenCalledExactlyOnceWith({
      partyId: 401, labServiceId: 501, costMinor: 1234, costCurrency: "SAR",
      effectiveFrom: "2026-10-04", effectiveTo: null, note: null, createdBy: username,
    });
    expect(boundary.findUserByUsername).not.toHaveBeenCalled();
  });
  it("retains create failure status/message without a success audit", async () => {
    withRole("admin"); boundary.createLabPricingRule.mockRejectedValue(new Error("Synthetic create failure"));
    const response = await POST(jsonRequest("POST", createDraft));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ message: "تعذّر حفظ قاعدة التسعير للمختبر." });
    expect(boundary.recordAudit).not.toHaveBeenCalled(); expect(boundary.findUserByUsername).not.toHaveBeenCalled();
  });
});

describe("unchanged pricing [id] writers", () => {
  it.each(["doctor", "reception", "accountant", "cashier", "assistant"])("keeps PUT and DELETE admin-only for %s", async role => {
    withRole(role); allowDoctor();
    const updated = await PUT(jsonRequest("PUT", { costMinor: 12345 }), context());
    expect(updated.status).toBe(403);
    expect(await updated.json()).toEqual({ message: "تعديل أسعار المختبرات للمدير وحده." });
    const deleted = await DELETE(new Request(`${baseUrl}/${rule.id}`, { method: "DELETE" }), context());
    expect(deleted.status).toBe(403);
    expect(await deleted.json()).toEqual({ message: "حذف أسعار المختبرات للمدير وحده." });
    expect(boundary.findUserByUsername).not.toHaveBeenCalled(); expectNoPricingReaders(); expectNoWrites();
  });
  it("retains exact admin PUT patch, audit and full-cost response", async () => {
    withRole("admin"); denyLookup("throws");
    const response = await PUT(jsonRequest("PUT", {
      costMinor: "12345", costCurrency: "SAR", effectiveFrom: " 2026-10-03 ",
      effectiveTo: " 2026-11-03 ", note: "  Synthetic pricing note  ",
    }), context());
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ rule });
    expect(boundary.updateLabPricingRule).toHaveBeenCalledExactlyOnceWith(701, {
      costMinor: 12345, costCurrency: "SAR", effectiveFrom: "2026-10-03",
      effectiveTo: "2026-11-03", note: "Synthetic pricing note",
    });
    expect(boundary.recordAudit).toHaveBeenCalledExactlyOnceWith({
      actor: username, actorRole: "admin", action: "lab_pricing.update", entity: "lab_pricing_rule", entityId: "701",
      entityLabel: "Synthetic pricing lab — Synthetic pricing service",
      details: { id: 701, costMinor: 12345, costCurrency: "SAR", effectiveFrom: "2026-10-03", effectiveTo: "2026-11-03", note: "Synthetic pricing note" },
    });
    expect(boundary.findUserByUsername).not.toHaveBeenCalled();
    expect(boundary.createLabPricingRule).not.toHaveBeenCalled(); expect(boundary.deleteLabPricingRule).not.toHaveBeenCalled();
    expect(boundary.getPool).not.toHaveBeenCalled(); expectNoPricingReaders();
  });
  it("retains admin DELETE identifier and audit inputs", async () => {
    withRole("admin"); denyLookup("throws");
    boundary.query.mockResolvedValue({ rows: [{
      party_name: lab.name, service_name: service.name, cost_minor: "12345", cost_currency: "SAR",
    }] });
    const response = await DELETE(new Request(`${baseUrl}/${rule.id}`, { method: "DELETE" }), context());
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ ok: true });
    expect(boundary.getPool).toHaveBeenCalledExactlyOnceWith();
    expect(boundary.query).toHaveBeenCalledExactlyOnceWith(expect.any(String), [701]);
    expect(boundary.deleteLabPricingRule).toHaveBeenCalledExactlyOnceWith(701);
    expect(boundary.recordAudit).toHaveBeenCalledExactlyOnceWith({
      actor: username, actorRole: "admin", action: "lab_pricing.delete", entity: "lab_pricing_rule", entityId: "701",
      entityLabel: "Synthetic pricing lab — Synthetic pricing service (12345 SAR)", details: { id: 701 },
    });
    expect(boundary.findUserByUsername).not.toHaveBeenCalled();
    expect(boundary.createLabPricingRule).not.toHaveBeenCalled(); expect(boundary.updateLabPricingRule).not.toHaveBeenCalled();
    expectNoPricingReaders();
  });
});
