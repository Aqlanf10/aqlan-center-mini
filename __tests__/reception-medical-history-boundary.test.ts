import { beforeEach, describe, expect, it, vi } from "vitest";

// Synthetic spies only: no patient records, storage, Railway, or PostgreSQL.
const mocks = vi.hoisted(() => ({
  session: vi.fn(), access: vi.fn(),
  history: vi.fn(), vitals: vi.fn(), settings: vi.fn(),
  save: vi.fn(), recordVitals: vi.fn(), audit: vi.fn(),
}));
vi.mock("@/lib/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/patient-access", () => ({ canAccessPatient: mocks.access }));
vi.mock("@/lib/db", () => ({
  CLINIC_TIME_ZONE: "Asia/Aden",
  getSettings: mocks.settings,
  listMedicalHistory: mocks.history,
  listVitals: mocks.vitals,
  recordAudit: mocks.audit,
  saveMedicalHistory: mocks.save,
  recordVitals: mocks.recordVitals,
}));
import { GET, POST } from "../app/api/patients/[id]/medical-history/route";
import { GET as GET_VITALS, POST as POST_VITALS } from "../app/api/patients/[id]/vitals/route";

const context = { params: Promise.resolve({ id: "17" }) };
const get = () => GET(new Request("http://localhost/api/patients/17/medical-history"), context);
const post = () => POST(new Request("http://localhost/api/patients/17/medical-history", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ notes: "synthetic-private-record" }),
}), context);

const getVitals = () => GET_VITALS(new Request("http://localhost/api/patients/17/vitals"), context);
const postVitals = () => POST_VITALS(new Request("http://localhost/api/patients/17/vitals", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ pulse: 72 }),
}), context);

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ role: "reception", username: "synthetic-reception" });
  mocks.access.mockResolvedValue(true); // intentionally emulate legacy broad access
  mocks.history.mockResolvedValue([]);
  mocks.vitals.mockResolvedValue([]);
  mocks.settings.mockResolvedValue({});
  mocks.save.mockResolvedValue(null);
  mocks.recordVitals.mockResolvedValue({ patientId: 17, id: 22, visitId: 3, pulse: 72 });
  mocks.audit.mockResolvedValue(undefined);
});

const expectNoClinicalReadsOrWrites = () => {
  expect(mocks.access).not.toHaveBeenCalled();
  expect(mocks.history).not.toHaveBeenCalled();
  expect(mocks.vitals).not.toHaveBeenCalled();
  expect(mocks.settings).not.toHaveBeenCalled();
  expect(mocks.save).not.toHaveBeenCalled();
  expect(mocks.recordVitals).not.toHaveBeenCalled();
  expect(mocks.audit).not.toHaveBeenCalled();
};

describe("P0: reception upload-only boundary on structured medical history", () => {
  it("denies reception GET before querying clinical data, regardless of legacy patient access", async () => {
    const response = await get();
    expect(response.status).toBe(403);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(JSON.stringify(await response.json())).not.toContain("synthetic-private-record");
    expectNoClinicalReadsOrWrites();
  });

  it("denies reception POST before reading/updating any medical history", async () => {
    const response = await post();
    expect(response.status).toBe(403);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expectNoClinicalReadsOrWrites();
  });

  it("denies reception vitals GET/POST before all DB reads and writes", async () => {
    const read = await getVitals();
    expect(read.status).toBe(403);
    expect(read.headers.get("Cache-Control")).toBe("private, no-store");
    const write = await postVitals();
    expect(write.status).toBe(403);
    expect(write.headers.get("Cache-Control")).toBe("private, no-store");
    expectNoClinicalReadsOrWrites();
  });

  it.each(["admin", "doctor"])("retains authorized vitals GET and POST for %s", async role => {
    mocks.session.mockResolvedValue({ role, username: "synthetic-clinical" });
    expect((await getVitals()).status).toBe(200);
    expect(mocks.vitals).toHaveBeenCalledWith(17, 30);
    expect((await postVitals()).status).toBe(201);
    expect(mocks.access).toHaveBeenCalledWith(expect.anything(), 17, "canEditPatient");
    expect(mocks.recordVitals).toHaveBeenCalled();
  });

  it.each(["cashier", "accountant", "assistant"])("denies nonclinical role %s on GET and POST", async role => {
    mocks.session.mockResolvedValue({ role, username: "synthetic-restricted" });
    expect((await get()).status).toBe(403);
    expect((await post()).status).toBe(403);
    expect((await getVitals()).status).toBe(403);
    expect((await postVitals()).status).toBe(403);
    expectNoClinicalReadsOrWrites();
  });

  it.each(["admin", "doctor"])("retains bounded read for authorized %s", async role => {
    mocks.session.mockResolvedValue({ role, username: "synthetic-clinical" });
    const response = await get();
    expect(response.status).toBe(200);
    expect((await response.json()).latest).toBeNull();
    expect(mocks.access).toHaveBeenCalledWith(expect.anything(), 17);
    expect(mocks.history).toHaveBeenCalledWith(17);
    expect(mocks.vitals).toHaveBeenCalledWith(17);
  });

  it("fails closed for doctor without patient authorization", async () => {
    mocks.session.mockResolvedValue({ role: "doctor", username: "synthetic-doctor" });
    mocks.access.mockResolvedValue(false);
    expect((await get()).status).toBe(403);
    expect(mocks.history).not.toHaveBeenCalled();
    expect(mocks.vitals).not.toHaveBeenCalled();
  });

  it("refuses anonymous requests without any clinical data reads", async () => {
    mocks.session.mockResolvedValue(null);
    expect((await get()).status).toBe(401);
    expect((await post()).status).toBe(401);
    expectNoClinicalReadsOrWrites();
  });
});
