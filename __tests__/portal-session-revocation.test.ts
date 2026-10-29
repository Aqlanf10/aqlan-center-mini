import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ cookie: "", query: vi.fn(), ensureSchema: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => ({ value: mocks.cookie }) }) }));
vi.mock("../lib/db", () => ({ ensureSchema: mocks.ensureSchema, getPool: () => ({ query: mocks.query }) }));
import { createPortalToken } from "../lib/portal";
import { requirePortalSession } from "../lib/portal-server";
beforeEach(() => {
  vi.stubEnv("SESSION_SECRET", "synthetic-portal-revocation-key-123456789");
  mocks.cookie = createPortalToken({ patientId: 1, patientNumber: "SYNTH-1", fullName: "اصطناعي", expiresAt: Date.now() + 60_000 });
  mocks.query.mockReset();
});
it("rejects a signed session whose patient identity no longer matches or whose token was revoked", async () => {
  mocks.query.mockResolvedValue({ rows: [] });
  expect(await requirePortalSession()).toBeNull();
});
it("keeps a current, non-revoked patient session", async () => {
  mocks.query.mockResolvedValue({ rows: [{ id: 1 }] });
  expect(await requirePortalSession()).toMatchObject({ patientId: 1 });
});
