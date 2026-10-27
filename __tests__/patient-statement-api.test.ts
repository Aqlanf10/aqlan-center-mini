import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ session: vi.fn(), load: vi.fn() }));
vi.mock("../lib/session", () => ({ requireSession: mocks.session }));
vi.mock("../lib/patient-statement-build", () => ({ loadPatientStatementDocument: mocks.load }));
import { GET } from "../app/api/patients/[id]/statement/route";
import { parsePatientStatementOptions } from "../lib/patient-statement-options";
import { restrictedRouteAllowed } from "../lib/role-routes";
const request = (query = "", id = "17") => GET(new Request(`https://synthetic.invalid/api/patients/${id}/statement?${query}`), { params: Promise.resolve({ id }) });
beforeEach(() => { vi.resetAllMocks(); mocks.session.mockResolvedValue({ username: "synthetic", role: "admin" }); mocks.load.mockResolvedValue({ patient: { name: "مريض اصطناعي" }, sections: [] }); });
describe("patient-copy API authority and scope", () => {
  it.each([null, { role: "doctor" }, { role: "assistant" }, { role: "cashier", financeAccess: { viewPatientLedger: false } }, { role: "accountant", financeAccess: { viewPatientLedger: false } }])("rejects unavailable authority %j before reads", async session => {
    mocks.session.mockResolvedValue(session); expect((await request()).status).toBe(session ? 403 : 401); expect(mocks.load).not.toHaveBeenCalled();
  });
  it.each(["admin", "reception", "cashier", "accountant"])("allows existing money reader %s and never caches patient data", async role => {
    mocks.session.mockResolvedValue({ role }); const response = await request("type=summary"); expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toContain("no-store"); expect(mocks.load).toHaveBeenCalledWith(17, { type: "summary" });
  });
  it.each(["patientId=18", "type=period&from=2026-02-30&to=2026-03-01", "type=period&from=2026-10-02&to=2026-10-01", "type=treatment&treatmentId=1.5", "type=summary&type=detailed", "type=summary&from=2026-01-01"])("rejects invalid scope %s", async query => {
    expect((await request(query)).status).toBe(400); expect(mocks.load).not.toHaveBeenCalled();
  });
  it("returns safe failure and no previous snapshot when a source fails", async () => {
    mocks.load.mockRejectedValue(new Error("SECRET-INTERNAL-AUDIT")); const response = await request(); expect(response.status).toBe(500); expect(await response.text()).not.toContain("SECRET");
  });
  it("keeps restricted roles inside their existing ledger permission", () => {
    for (const role of ["cashier", "accountant"]) {
      expect(restrictedRouteAllowed(role, "/api/patients/17/statement", "GET", { viewPatientLedger: false })).toBe(false);
      expect(restrictedRouteAllowed(role, "/api/patients/17/statement", "GET", { viewPatientLedger: true })).toBe(true);
      expect(restrictedRouteAllowed(role, "/api/patients/17/statement", "POST", { viewPatientLedger: true })).toBe(false);
    }
  });
  it("accepts leap dates and bounded periods without inheriting report filters", () => {
    expect(parsePatientStatementOptions(new URLSearchParams("from=2024-02-01&to=2024-02-29&currency=SAR&doctorId=77"), 17)).toEqual({ type: "period", from: "2024-02-01", to: "2024-02-29" });
  });
});
