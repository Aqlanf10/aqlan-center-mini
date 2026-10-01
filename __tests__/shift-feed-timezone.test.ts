import { afterAll, describe, expect, it, vi } from "vitest";

vi.stubEnv("CLINIC_TIME_ZONE", "America/New_York");
vi.stubEnv("USE_LOCAL_DB", "true");
vi.stubEnv("NODE_ENV", "test");
vi.stubEnv("RAILWAY_PROJECT_ID", "");
vi.mock("../lib/session", () => ({
  requireSession: vi.fn(async () => ({ username: "timezone-test", role: "admin" })),
}));
vi.mock("../lib/db", async (importOriginal) => {
  const db = await importOriginal<typeof import("../lib/db")>();
  return { ...db, getOpenShift: vi.fn(async () => null), listShifts: vi.fn(async () => []) };
});

const { CLINIC_TIME_ZONE, getOpenShift } = await import("../lib/db");
const { requireSession } = await import("../lib/session");
const { GET } = await import("../app/api/shifts/route");

afterAll(() => { vi.unstubAllEnvs(); });

describe("shift feed clinic timezone", () => {
  it("exposes the server's resolved non-default clinic timezone to authorized finance clients", async () => {
    expect(CLINIC_TIME_ZONE).toBe("America/New_York");
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      clinicTimeZone: CLINIC_TIME_ZONE, open: null, payments: [], expenses: [],
    });
  });

  it("retains the authenticated-read boundary", async () => {
    vi.mocked(requireSession).mockResolvedValueOnce(null);
    vi.mocked(getOpenShift).mockClear();
    const response = await GET();
    expect(response.status).toBe(401);
    expect(await response.json()).not.toHaveProperty("clinicTimeZone");
    expect(getOpenShift).not.toHaveBeenCalled();
  });
});
