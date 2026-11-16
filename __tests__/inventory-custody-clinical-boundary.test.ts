vi.mock("server-only", () => ({}));
import { afterEach, describe, expect, it, vi } from "vitest";
const database = vi.hoisted(() => ({ ensureSchema: vi.fn(), getPool: vi.fn(), insertAuditRow: vi.fn(), doctorOwnsPatient: vi.fn() }));
vi.mock("../lib/db", () => database);
import { recordCustodyUsage, type CustodyUsageInput } from "../lib/inventory-domain/custody-store";

const actor = { userId: 1, username: "synthetic", role: "doctor" };
const usage: CustodyUsageInput = {
  id: "12345678-1234-4234-8234-123456789abc", lotId: "22345678-1234-4234-8234-123456789abc",
  locationId: "synthetic-custody", kind: "consumed", quantity: "1", reason: "Synthetic explicit usage",
};
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe("custody clinical references are never silently discarded", () => {
  const fields = ["patientId", "visitId", "caseId", "procedureId"] as const;
  for (const field of fields) {
    it.each([42, false, [], {}, "x".repeat(241)].map(value => ({ value })))(`rejects malformed ${field} $value before database access`, async ({ value }) => {
      vi.stubEnv("INVENTORY_INTEGRATION_ENABLED", "true");
      await expect(recordCustodyUsage(actor, "synthetic-key", { ...usage, [field]: value } as unknown as CustodyUsageInput))
        .rejects.toMatchObject({ code: "clinical_context_mismatch" });
      expect(database.ensureSchema).not.toHaveBeenCalled();
      expect(database.getPool).not.toHaveBeenCalled();
    });
  }
  it.each(["patientId", "visitId", "caseId", "procedureId"] as const)("rejects an out-of-range numeric %s without rounding it", async field => {
    vi.stubEnv("INVENTORY_INTEGRATION_ENABLED", "true");
    await expect(recordCustodyUsage(actor, "synthetic-key", { ...usage, [field]: "9007199254740993" }))
      .rejects.toMatchObject({ code: "clinical_context_mismatch" });
    expect(database.ensureSchema).not.toHaveBeenCalled();
    expect(database.getPool).not.toHaveBeenCalled();
  });
});
