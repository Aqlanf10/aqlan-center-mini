import { beforeEach, describe, expect, it, vi } from "vitest";

// Entirely synthetic: guard rejects before patient access, SQL or document reads.
const mocks = vi.hoisted(() => ({
  session: vi.fn(), access: vi.fn(),
  patient: vi.fn(), list: vi.fn(), create: vi.fn(),
}));
vi.mock("@/lib/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/patient-access", () => ({ canAccessPatient: mocks.access }));
vi.mock("@/lib/db", () => ({
  getPatient: mocks.patient,
  listIntakeForms: mocks.list,
  createIntakeForm: mocks.create,
}));
vi.mock("@/lib/portal", () => ({
  validateIntake: () => ({ ok: true, value: { conditions: [] } }),
}));

import { GET, POST } from "../app/api/patients/[id]/intake-history/route";

const context = { params: Promise.resolve({ id: "17" }) };
const get = () => GET(new Request("http://localhost/api/patients/17/intake-history"), context);
const post = () => POST(new Request("http://localhost/api/patients/17/intake-history", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ conditions: ["diabetes"], allergies: "synthetic-private-allergy" }),
}), context);

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ role: "reception", username: "synthetic-reception" });
  mocks.access.mockResolvedValue(true); // emulate legacy broad patient access
  mocks.list.mockResolvedValue([{ id: 31, answers: { allergies: "synthetic-private-allergy" } }]);
  mocks.patient.mockResolvedValue({ id: 17 });
  mocks.create.mockResolvedValue({ id: 32 });
});

const noPatientQueries = () => {
  expect(mocks.access).not.toHaveBeenCalled();
  expect(mocks.patient).not.toHaveBeenCalled();
  expect(mocks.list).not.toHaveBeenCalled();
  expect(mocks.create).not.toHaveBeenCalled();
};

describe("P0: confidential patient intake history backend boundary", () => {
  it.each(["reception", "cashier", "accountant", "assistant"])(
    "rejects %s reading or adding medical questionnaire before any patient DB access", async role => {
      mocks.session.mockResolvedValue({ role, username: "synthetic-unprivileged" });
      for (const response of [await get(), await post()]) {
        expect(response.status).toBe(403);
        expect(response.headers.get("Cache-Control")).toBe("no-store");
        expect(JSON.stringify(await response.json())).not.toContain("synthetic-private-allergy");
      }
      noPatientQueries();
    },
  );

  it.each(["admin", "doctor"])("preserves authorized %s reads and appends", async role => {
    mocks.session.mockResolvedValue({ role, username: "synthetic-clinician" });
    const read = await get();
    expect(read.status).toBe(200);
    expect(mocks.access).toHaveBeenCalledWith(expect.anything(), 17);
    expect(mocks.list).toHaveBeenCalledWith(17);
    const write = await post();
    expect(write.status).toBe(201);
    expect(mocks.create).toHaveBeenCalledWith(
      17, expect.anything(), { actor: "synthetic-clinician", actorRole: role },
    );
  });

  it("refuses doctor who is not authorized for this patient", async () => {
    mocks.session.mockResolvedValue({ role: "doctor", username: "synthetic-doctor" });
    mocks.access.mockResolvedValue(false);
    expect((await get()).status).toBe(403);
    expect((await post()).status).toBe(403);
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("rejects missing session without any patient query", async () => {
    mocks.session.mockResolvedValue(null);
    expect((await get()).status).toBe(401);
    expect((await post()).status).toBe(401);
    noPatientQueries();
  });
});
