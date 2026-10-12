import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionPayload } from "../lib/auth";
import { JSON_BODY_LIMIT_BYTES } from "../lib/security-limits";

// Exercise the real handler, role rules and bounded JSON reader. Persistence
// and authentication are mocked; these tests never open a database.
const mocks = vi.hoisted(() => ({
  session: vi.fn(), user: vi.fn(), owns: vi.fn(),
  createPlan: vi.fn(), createPlanV2: vi.fn(), audit: vi.fn(),
  settings: vi.fn(), services: vi.fn(), activePlans: vi.fn(), patientPlans: vi.fn(),
  canViewPatientMoney: vi.fn(),
}));
vi.mock("@/lib/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/db", () => ({
  CLINIC_TIME_ZONE: "Asia/Aden",
  findUserByUsername: mocks.user,
  doctorOwnsPatient: mocks.owns,
  createPlan: mocks.createPlan,
  createPlanV2: mocks.createPlanV2,
  recordAudit: mocks.audit,
  getSettings: mocks.settings,
  listServices: mocks.services,
  listActivePlans: mocks.activePlans,
  listPatientPlans: mocks.patientPlans,
}));
vi.mock("@/lib/patient-access", () => ({ canViewPatientMoney: mocks.canViewPatientMoney }));
import { POST } from "../app/api/plans/route";

const ENTRY_REQUIRED = {
  code: "PLAN_CREATION_ENTRY_REQUIRED",
  message: "ابدأ العلاج من الفاتورة أو الاتفاق السابق للنظام في حساب المريض.",
};
const session: SessionPayload = {
  userId: 10, username: "synthetic-plan-entry", role: "admin", partyId: 7, expiresAt: 0,
};
const patientId = 91;
const payload = {
  patientId, title: "Synthetic retired plan entry", currency: "YER",
  total: "1000", count: 2, everyDays: 30, startDate: "2026-10-01",
};
const oldModes: { name: string; extra: Record<string, unknown> }[] = [
  { name: "implicit financial", extra: {} },
  { name: "financial", extra: { mode: "financial" } },
  { name: "clinical", extra: { mode: "clinical" } },
  { name: "v2 per-procedure", extra: {
    mode: "v2", billingMode: "per_procedure",
    items: [{ serviceId: 5, quantity: 1, unitPriceMinor: 1000, billingRule: "on_start", sessionCount: 2 }],
  } },
  { name: "v2 installments", extra: {
    mode: "v2", billingMode: "installments", installments: [{ dueDate: "2026-10-01", amountMinor: 1000 }],
  } },
  { name: "v2 custom schedule", extra: {
    mode: "v2", billingMode: "custom_schedule", installments: [{ dueDate: "2026-10-01", amountMinor: 1000 }],
  } },
  { name: "specialty template", extra: {
    mode: "template", templateId: "endo", teeth: [36],
    steps: [{ key: "rct", include: true, serviceId: 5 }],
  } },
  { name: "unknown mode", extra: { mode: "future-entry" } },
  { name: "null mode", extra: { mode: null } },
  { name: "empty mode", extra: { mode: "" } },
];

function rawRequest(body: string, headers: Record<string, string> = {}, query = "") {
  return new Request(`http://test.invalid/api/plans${query}`, {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body,
  });
}
function request(body: unknown = payload, headers: Record<string, string> = {}, query = "") {
  return rawRequest(JSON.stringify(body), headers, query);
}
async function expectEntryRequired(response: Response) {
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual(ENTRY_REQUIRED);
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue(session);
  mocks.user.mockResolvedValue({
    id: session.userId, username: session.username, role: "doctor", isActive: true,
    partyId: 7, permissions: { canEditPlans: true, canViewAllPatients: true },
  });
  mocks.owns.mockResolvedValue(true);
});

afterEach(() => {
  // Refusal is terminal: no old writer, pricing/catalog work, read projection
  // or success audit may run even when clients supply formerly valid payloads.
  for (const unused of [
    mocks.createPlan, mocks.createPlanV2, mocks.audit, mocks.settings, mocks.services,
    mocks.activePlans, mocks.patientPlans, mocks.canViewPatientMoney,
  ]) expect(unused).not.toHaveBeenCalled();
});

describe.each(["admin", "reception", "cashier"] as const)("POST plans retirement: direct %s handler", (role) => {
  // Cashier passes the historical handler's canHandleMoney rule; the real HTTP
  // proxy still rejects this route for that role (covered in the HTTP suite).
  it.each(oldModes)("refuses $name without invoking any writer", async ({ extra }) => {
    mocks.session.mockResolvedValue({ ...session, role });
    await expectEntryRequired(await POST(request({ ...payload, ...extra })));
    expect(mocks.user).not.toHaveBeenCalled();
    expect(mocks.owns).not.toHaveBeenCalled();
  });
});

describe("POST plans retains authentication and patient scope before retirement", () => {
  it("returns 401 before reading even an invalid or oversized unauthenticated body", async () => {
    mocks.session.mockResolvedValue(null);
    const req = rawRequest("{", { "content-length": String(JSON_BODY_LIMIT_BYTES + 1) });
    const response = await POST(req);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ message: "انتهت الجلسة. سجّل الدخول من جديد." });
    expect(req.bodyUsed).toBe(false);
    expect(mocks.user).not.toHaveBeenCalled();
    expect(mocks.owns).not.toHaveBeenCalled();
  });

  it.each(["accountant", "assistant"] as const)("retains 403 for the %s role", async (role) => {
    mocks.session.mockResolvedValue({ ...session, role });
    const response = await POST(request());
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ message: "خطط العلاج للإدارة والاستقبال." });
    expect(mocks.user).not.toHaveBeenCalled();
    expect(mocks.owns).not.toHaveBeenCalled();
  });

  it.each(oldModes)("returns 409 for an authorized doctor's owned patient in $name", async ({ extra }) => {
    mocks.session.mockResolvedValue({ ...session, role: "doctor", partyId: 999 });
    await expectEntryRequired(await POST(request({ ...payload, ...extra })));
    expect(mocks.user).toHaveBeenCalledExactlyOnceWith(session.username);
    expect(mocks.owns).toHaveBeenCalledExactlyOnceWith(7, patientId);
  });

  it("retains the explicit canEditPlans refusal even for an owned patient", async () => {
    mocks.session.mockResolvedValue({ ...session, role: "doctor" });
    mocks.user.mockResolvedValue({ partyId: 7, permissions: { canEditPlans: false } });
    const response = await POST(request());
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ message: "غير مصرّح لك بإنشاء أو تعديل خطط العلاج." });
    expect(mocks.owns).not.toHaveBeenCalled();
  });

  it.each(["not owned", "ownership lookup failed"])("retains 403 when the patient is %s", async (reason) => {
    mocks.session.mockResolvedValue({ ...session, role: "doctor" });
    if (reason === "not owned") mocks.owns.mockResolvedValue(false);
    else mocks.owns.mockRejectedValue(new Error("Synthetic ownership failure"));
    const response = await POST(request({ ...payload, fromInvoice: true, allowPlanCreation: true }));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ message: "غير مصرّح لك بإنشاء خطة لهذا المريض." });
    expect(mocks.owns).toHaveBeenCalledExactlyOnceWith(7, patientId);
  });

  it("retains 403 when a doctor has no linked party", async () => {
    mocks.session.mockResolvedValue({ ...session, role: "doctor", partyId: null });
    mocks.user.mockResolvedValue({ partyId: null, permissions: { canEditPlans: true } });
    expect((await POST(request())).status).toBe(403);
    expect(mocks.owns).not.toHaveBeenCalled();
  });

  it("retains doctor scope refusal for a malformed patient identifier", async () => {
    mocks.session.mockResolvedValue({ ...session, role: "doctor" });
    expect((await POST(request({ ...payload, patientId: "invalid" }))).status).toBe(403);
    expect(mocks.owns).not.toHaveBeenCalled();
  });

  it.each([undefined, null, 0, -1, 1.5, "invalid", "", {}, []].map((invalid) => ({ invalid })))("retains 400 for invalid patientId $invalid", async ({ invalid }) => {
    const response = await POST(request({ ...payload, patientId: invalid }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ message: "اختر المريض أولًا." });
  });

  it.each([null, [], "invalid", 17].map((body) => ({ body })))("retains 400 for non-object JSON $body", async ({ body }) => {
    expect((await POST(request(body))).status).toBe(400);
  });

  it("preserves numeric patient IDs supplied as strings", async () => {
    await expectEntryRequired(await POST(request({ patientId: String(patientId) })));
  });
});

describe("POST plans retains bounded body parsing", () => {
  it.each(["", "{", '{"patientId":91,}'])("returns 400 for malformed/empty JSON %j", async (body) => {
    const response = await POST(rawRequest(body));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ message: "طلب غير صالح." });
  });

  it("returns 413 before reading an excessive declared Content-Length", async () => {
    const req = request(payload, { "content-length": String(JSON_BODY_LIMIT_BYTES + 1) });
    expect((await POST(req)).status).toBe(413);
    expect(req.bodyUsed).toBe(false);
  });

  it("returns 413 for excess bytes without trusting a Content-Length header", async () => {
    const req = request({ ...payload, note: "x".repeat(JSON_BODY_LIMIT_BYTES) });
    expect(req.headers.has("content-length")).toBe(false);
    expect((await POST(req)).status).toBe(413);
  });

  it("bounds UTF-8 bytes rather than JavaScript string length", async () => {
    const raw = JSON.stringify({ patientId, note: "ع".repeat(Math.floor(JSON_BODY_LIMIT_BYTES / 2)) });
    expect(raw.length).toBeLessThan(JSON_BODY_LIMIT_BYTES);
    expect(Buffer.byteLength(raw, "utf8")).toBeGreaterThan(JSON_BODY_LIMIT_BYTES);
    expect((await POST(rawRequest(raw))).status).toBe(413);
  });

  it("still gives the retirement response for a JSON body exactly at the limit", async () => {
    const base = JSON.stringify({ patientId, note: "" });
    const raw = JSON.stringify({ patientId, note: "x".repeat(JSON_BODY_LIMIT_BYTES - Buffer.byteLength(base)) });
    expect(Buffer.byteLength(raw)).toBe(JSON_BODY_LIMIT_BYTES);
    await expectEntryRequired(await POST(rawRequest(raw)));
  });
});

describe("POST plans cannot be re-enabled by client-controlled entry hints", () => {
  it.each([
    { source: "invoice", fromInvoice: true, sourceInvoiceId: 123 },
    { source: "legacy_agreement", legacy: true, legacyAgreement: true },
    { entryPoint: "invoice", canonicalEntry: true, allowPlanCreation: true, bypass: true },
  ])("ignores body flags %j, query hints and a forged Referer", async (flags) => {
    await expectEntryRequired(await POST(request({ ...payload, mode: "v2", ...flags }, {
      referer: `http://test.invalid/patients/${patientId}?tab=account`,
      "x-plan-entry": "invoice", "x-allow-plan-creation": "true",
    }, "?fromInvoice=true&allowPlanCreation=true&entry=legacy_agreement")));
  });

  it("does not fall through to old title, currency, template or item validation", async () => {
    await expectEntryRequired(await POST(request({
      patientId, mode: "template", title: "", currency: "INVALID",
      templateId: "missing", teeth: [19], items: [{ serviceId: -1 }],
    })));
  });
});
