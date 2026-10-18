import { beforeEach, describe, expect, it, vi } from "vitest";
const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@/lib/db", () => ({
  ensureSchema: vi.fn(), getPool: () => ({ query }),
  getCephStudy: vi.fn(), getPatient: vi.fn(), getCephReferenceSet: vi.fn(),
}));
vi.mock("@/lib/session", () => ({ requireSession: vi.fn() }));
vi.mock("@/lib/patient-access", () => ({ canAccessPatient: vi.fn() }));
vi.mock("next/navigation", () => ({
  notFound: () => { throw new Error("NOT_FOUND"); },
  redirect: () => { throw new Error("LOGIN"); },
}));
vi.mock("@/components/CephTracer", () => ({ CephTracer: vi.fn() }));
vi.mock("@/components/CephCompareView", () => ({ CephCompareView: vi.fn() }));
import { getCephStudy, getPatient, getCephReferenceSet } from "@/lib/db";
import { canAccessPatient } from "@/lib/patient-access";
import { requireSession } from "@/lib/session";
import Workspace from "@/app/ceph/[id]/page";
import Compare from "@/app/ceph/compare/page";

const session = { userId: 1, username: "synthetic", role: "doctor" as const, expiresAt: Date.now() + 60_000 };
const workspace = () => Workspace({ params: Promise.resolve({ id: "1" }) });
const compare = (patient?: string) => Compare({ searchParams: Promise.resolve({ first: "1", second: "2", patient }) });
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(requireSession).mockResolvedValue(session);
  query.mockResolvedValue({ rows: [{ patient_id: 42 }] });
  vi.mocked(canAccessPatient).mockResolvedValue(false);
});
function noSensitiveReads() {
  expect(getCephStudy).not.toHaveBeenCalled();
  expect(getPatient).not.toHaveBeenCalled();
  expect(getCephReferenceSet).not.toHaveBeenCalled();
}

describe.each([["workspace", workspace], ["comparison", compare]] as const)("%s admission before clinical reads", (_name, page) => {
  it("checks the canonical X-ray permission using stored ownership", async () => {
    await expect(page()).rejects.toThrow("NOT_FOUND");
    expect(canAccessPatient).toHaveBeenCalledWith(session, 42, "canViewXrays");
    noSensitiveReads();
  });
  it("fails closed when the policy check throws", async () => {
    vi.mocked(canAccessPatient).mockRejectedValue(new Error("policy unavailable"));
    await expect(page()).rejects.toThrow("NOT_FOUND");
    noSensitiveReads();
  });
  it("does not read clinical data when ownership lookup fails", async () => {
    query.mockRejectedValue(new Error("database unavailable"));
    await expect(page()).rejects.toThrow("database unavailable");
    noSensitiveReads();
  });
  it("stops when no active study exists", async () => {
    query.mockResolvedValue({ rows: [] });
    await expect(page()).rejects.toThrow("NOT_FOUND");
    expect(canAccessPatient).not.toHaveBeenCalled();
    noSensitiveReads();
  });
  it("requires a session before any study lookup", async () => {
    vi.mocked(requireSession).mockResolvedValue(null);
    await expect(page()).rejects.toThrow("LOGIN");
    expect(query).not.toHaveBeenCalled();
    noSensitiveReads();
  });
});
it("rejects different stored patient identities before fetching the patient", async () => {
  vi.mocked(canAccessPatient).mockResolvedValue(true);
  query.mockResolvedValueOnce({ rows: [{ patient_id: 42 }] }).mockResolvedValueOnce({ rows: [{ patient_id: 43 }] });
  await expect(compare()).rejects.toThrow("NOT_FOUND");
  noSensitiveReads();
});
it("rejects a patient parameter conflicting with both stored studies", async () => {
  vi.mocked(canAccessPatient).mockResolvedValue(true);
  await expect(compare("43")).rejects.toThrow("NOT_FOUND");
  noSensitiveReads();
});
it("admits the workspace clinical read only after authorization", async () => {
  vi.mocked(canAccessPatient).mockResolvedValue(true);
  vi.mocked(getCephStudy).mockRejectedValue(new Error("clinical read admitted"));
  await expect(workspace()).rejects.toThrow("clinical read admitted");
  expect(vi.mocked(canAccessPatient).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(getCephStudy).mock.invocationCallOrder[0]);
});
it("admits the comparison patient read only after authorizing both studies", async () => {
  vi.mocked(canAccessPatient).mockResolvedValue(true);
  vi.mocked(getPatient).mockRejectedValue(new Error("patient read admitted"));
  await expect(compare()).rejects.toThrow("patient read admitted");
  expect(canAccessPatient).toHaveBeenCalledTimes(2);
  for (const order of vi.mocked(canAccessPatient).mock.invocationCallOrder) {
    expect(order).toBeLessThan(vi.mocked(getPatient).mock.invocationCallOrder[0]);
  }
  expect(getPatient).toHaveBeenCalledWith(42);
});
