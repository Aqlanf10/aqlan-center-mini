import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ list: vi.fn<(...args: unknown[]) => Promise<unknown[]>>(async () => []), adjust: vi.fn<(...args: unknown[]) => Promise<object>>(async () => ({})) }));
vi.mock("../lib/session", () => ({ requireSession: async () => ({ username: "synthetic-admin", role: "admin" }) }));
vi.mock("../lib/hr", () => ({ canManageStaff: () => true }));
vi.mock("../lib/hr-identity-preview", () => ({ IdentityPreviewError: class extends Error {} }));
vi.mock("../lib/hr-contracts-attendance", () => ({ listLeaveBalances: mocks.list, adjustLeaveBalance: mocks.adjust, HrWorkforceMutationError: class extends Error {} }));
import { GET, POST } from "../app/api/hr/leaves/balances/route";
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); vi.unstubAllEnvs(); });
it("reads and allocates the clinic's new year while the UTC server is still in December", async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-12-31T22:00:00Z"));
  vi.stubEnv("CLINIC_TIME_ZONE", "Asia/Aden");
  await GET(new Request("http://localhost/api/hr/leaves/balances?staffId=1"));
  expect(mocks.list.mock.calls[0]?.[1]).toBe(2027);
  await POST(new Request("http://localhost/api/hr/leaves/balances", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ staffId: "1", leaveTypeId: "annual", allocatedDays: 20 }) }));
  expect(mocks.adjust.mock.calls[0]?.[2]).toBe(2027);
});
it("honors an explicitly selected year", async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-12-31T22:00:00Z"));
  await GET(new Request("http://localhost/api/hr/leaves/balances?staffId=1&year=2025"));
  expect(mocks.list.mock.calls[0]?.[1]).toBe(2025);
  await POST(new Request("http://localhost/api/hr/leaves/balances", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ staffId: "1", leaveTypeId: "annual", allocatedDays: 20, year: 2025 }) }));
  expect(mocks.adjust.mock.calls[0]?.[2]).toBe(2025);
});
