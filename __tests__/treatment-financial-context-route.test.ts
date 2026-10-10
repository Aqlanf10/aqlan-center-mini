import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ session: vi.fn(), references: vi.fn() }));
vi.mock("@/lib/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/treatment-financial-context-db", () => ({ listTreatmentFinancialReferences: mocks.references }));
import { GET } from "@/app/api/patients/[id]/treatment-financial-context/route";

const read = (id = "17") => GET(new Request(`http://localhost/api/patients/${id}/treatment-financial-context`), {
  params: Promise.resolve({ id }),
});

describe("financial reference GET current session authority", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.references.mockResolvedValue({ patientId: 17, references: [], documents: [] });
  });
  it.each(["admin", "reception", "cashier", "accountant"])("allows the canonical money reader %s", async role => {
    mocks.session.mockResolvedValue({ role, financeAccess: { viewPatientLedger: true } });
    const response = await read();
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(mocks.references).toHaveBeenCalledTimes(1);
    expect(mocks.references).toHaveBeenCalledWith(17);
  });
  it.each(["cashier", "accountant"])("refuses revoked patient financial access for %s before reading", async role => {
    mocks.session.mockResolvedValue({ role, financeAccess: { viewPatientLedger: false } });
    expect((await read()).status).toBe(403);
    expect(mocks.references).not.toHaveBeenCalled();
    // Each request uses the current trusted session, not the previous successful role.
    mocks.session.mockResolvedValue({ role, financeAccess: { viewPatientLedger: true } });
    expect((await read()).status).toBe(200);
    mocks.references.mockClear();
    mocks.session.mockResolvedValue({ role, financeAccess: { viewPatientLedger: false } });
    expect((await read()).status).toBe(403);
    expect(mocks.references).not.toHaveBeenCalled();
  });
  it.each(["doctor", "assistant"])("does not grant clinical role %s money access", async role => {
    mocks.session.mockResolvedValue({ role, financeAccess: { viewPatientLedger: true } });
    expect((await read()).status).toBe(403);
    expect(mocks.references).not.toHaveBeenCalled();
  });
  it("refuses expired or permission-version-invalid sessions", async () => {
    mocks.session.mockResolvedValue(null);
    expect((await read()).status).toBe(401);
    expect(mocks.references).not.toHaveBeenCalled();
  });
  it("preserves invalid patient and missing patient behavior", async () => {
    mocks.session.mockResolvedValue({ role: "cashier", financeAccess: { viewPatientLedger: true } });
    expect((await read("abc")).status).toBe(400);
    expect(mocks.references).not.toHaveBeenCalled();
    mocks.references.mockResolvedValue(null);
    expect((await read()).status).toBe(404);
  });
});
