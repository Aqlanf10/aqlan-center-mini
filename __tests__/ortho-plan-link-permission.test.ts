import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseDoctorPermissions } from "../lib/doctor-permissions";
import type { Role } from "../lib/roles";

const mocks = vi.hoisted(() => ({ session: vi.fn(), user: vi.fn(), owns: vi.fn(), today: vi.fn(),
  create: vi.fn(), baseline: vi.fn(), link: vi.fn(), audit: vi.fn(), found: vi.fn() }));
vi.mock("@/lib/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/db", () => ({
  CLINIC_TIME_ZONE: "Asia/Aden", findUserByUsername: mocks.user, doctorOwnsPatient: mocks.owns,
  patientHasVisitToday: mocks.today, createOrthoCase: mocks.create, recordOrthoBaseline: mocks.baseline,
  linkOrthoCasePlan: mocks.link, recordAudit: mocks.audit, getOrthoCase: mocks.found,
}));
import { POST as create } from "../app/api/ortho/route";
import { POST as baseline } from "../app/api/ortho/baseline/route";
import { PATCH as update } from "../app/api/ortho/[id]/route";

const patientId = 101;
const context = { params: Promise.resolve({ id: "41" }) };
const request = (body: unknown, method = "POST") => new Request("https://synthetic.invalid/api/ortho", {
  method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});
const handlers = {
  create: (planId: number | null = 51) => create(request({ patientId, planId })),
  baseline: (planId: number | null = 51) => baseline(request({ patientId, planId,
    phase: "working", financialMode: "installments", monthsElapsed: 10, monthsRemaining: 8 })),
  link: (planId: number | null = 51) => update(request({ planId }, "PATCH"), context),
};
function user(permissions: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return { id: 7, username: "synthetic-doctor", role: "doctor", isActive: true, partyId: 17,
    permissions: parseDoctorPermissions(permissions, "doctor"), ...extra };
}
function as(role: Role) {
  mocks.session.mockResolvedValue({ userId: 7, username: `synthetic-${role}`, role, partyId: 17,
    expiresAt: 4_102_444_800_000 });
}
function noWrites() {
  for (const writer of [mocks.create, mocks.baseline, mocks.link, mocks.audit]) expect(writer).not.toHaveBeenCalled();
}
beforeEach(() => {
  vi.resetAllMocks(); as("doctor"); mocks.user.mockResolvedValue(user()); mocks.owns.mockResolvedValue(true);
  mocks.today.mockResolvedValue(true); mocks.found.mockResolvedValue({ id: 41, patientId, status: "active" });
  mocks.create.mockResolvedValue({ ok: true, id: 41 }); mocks.baseline.mockResolvedValue({ ok: true, id: 41 });
  mocks.link.mockResolvedValue({ ok: true, changed: true, funded: true });
});

for (const [name, call] of Object.entries(handlers)) describe(`${name}: plan linkage uses current plan permissions`, () => {
  it.each(["canEditPlans", "canViewPlans"])("denies a doctor without %s before any writer", async (permission) => {
    mocks.user.mockResolvedValue(user({ [permission]: false }));
    expect((await call()).status).toBe(403); noWrites();
  });
  it("does not turn global clinical visibility into ownership of another doctor's plan", async () => {
    mocks.user.mockResolvedValue(user({ canViewAllPatients: true })); mocks.owns.mockResolvedValue(false);
    expect((await call()).status).toBe(403); noWrites();
  });
  it.each(["absent", "inactive", "missing-party", "lookup-failed"])("fails closed for %s identity", async (state) => {
    if (state === "absent") mocks.user.mockResolvedValue(null);
    if (state === "inactive") mocks.user.mockResolvedValue(user({}, { isActive: false }));
    if (state === "missing-party") mocks.user.mockResolvedValue(user({ canViewAllPatients: true }, { partyId: null }));
    if (state === "lookup-failed") mocks.user.mockRejectedValue(new Error("Synthetic user read unavailable"));
    expect((await call()).status).toBe(403); noWrites();
  });
  it("permits the current authorized doctor for their own patient", async () => {
    expect((await call()).status).toBe(name === "link" ? 200 : 201);
    expect([mocks.create, mocks.baseline, mocks.link].filter(writer => writer.mock.calls.length)).toHaveLength(1);
  });
  it("preserves administrator permission", async () => {
    as("admin"); expect((await call()).status).toBe(name === "link" ? 200 : 201);
  });
});
describe("unlinked clinical work and unlink permissions", () => {
  it.each(["create", "baseline"] as const)("keeps a %s case without a plan available to a clinical-only doctor", async (name) => {
    mocks.user.mockResolvedValue(user({ canViewPlans: false, canEditPlans: false }));
    expect((await handlers[name](null)).status).toBe(201);
    expect(mocks.link).not.toHaveBeenCalled();
  });
  it("does not permit an unauthorized unlink", async () => {
    mocks.user.mockResolvedValue(user({ canEditPlans: false }));
    expect((await handlers.link(null)).status).toBe(403); noWrites();
  });
  it.each(["create", "link"] as const)("preserves reception's explicit %s linking permission", async (name) => {
    as("reception"); expect((await handlers[name]()).status).toBe(name === "link" ? 200 : 201);
  });
});
