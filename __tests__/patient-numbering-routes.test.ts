import { apiRouteVerdict, HTTP_PERMISSIONS } from "../lib/http-permissions";
import { beforeEach, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ session: null as null | { role: string }, read: vi.fn(), preview: vi.fn() }));
vi.mock("../lib/session", () => ({ requireSession: async () => mock.session }));
vi.mock("../lib/canonical-patient-number", () => ({ canonicalPatientNumberRoute: async () => null, readCanonicalPatientNumber: vi.fn() }));
vi.mock("../lib/patient-numbering-db", () => ({ readPatientNumber: mock.read, readNumberingPreview: mock.preview,
  PatientNumberingError: class extends Error { code = "invalid"; } }));
import * as numbers from "../app/api/patients/[id]/number/route";
import * as settings from "../app/api/settings/patient-numbering/route";
const context = { params: Promise.resolve({ id: "42" }) };
const request = new Request("http://localhost/api/patients/42/number");
beforeEach(() => { vi.clearAllMocks(); mock.session = null; });

it.each([[null, 401], ["doctor", 403], ["reception", 403], ["assistant", 403], ["cashier", 403], ["accountant", 403]])(
  "keeps authenticated admin-only legacy reads for %s", async (role, status) => {
    mock.session = role ? { role } : null;
    expect((await numbers.GET(request, context)).status).toBe(status);
    expect((await settings.GET()).status).toBe(status);
    expect(mock.read).not.toHaveBeenCalled();
    expect(mock.preview).not.toHaveBeenCalled();
  });

it("keeps read-only admin previews and sends no-store", async () => {
  mock.session = { role: "admin" };
  mock.read.mockResolvedValue({ patientId: 42, patientNumber: "P-00042" });
  mock.preview.mockResolvedValue({ minimumNext: "7000" });
  const number = await numbers.GET(request, context);
  const config = await settings.GET();
  expect(await number.json()).toEqual({ patientId: 42, patientNumber: "P-00042" });
  expect(await config.json()).toEqual({ minimumNext: "7000" });
  expect(number.headers.get("cache-control")).toBe("no-store");
  expect(config.headers.get("cache-control")).toBe("no-store");
});

it.each([
  ["/api/patients/42/number", "/api/patients/[id]/number", numbers],
  ["/api/settings/patient-numbering", "/api/settings/patient-numbering", settings],
] as const)("exports no numbering mutation on %s for any authority", (path, pattern, route) => {
  expect(HTTP_PERMISSIONS[pattern]).toEqual({ GET: ["admin"] });
  expect(Object.hasOwn(route, "PATCH")).toBe(false);
  expect(apiRouteVerdict(path, "PATCH")).toEqual({ kind: "method-not-allowed", pattern, allow: ["GET", "HEAD", "OPTIONS"] });
});
