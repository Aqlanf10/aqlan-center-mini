vi.mock("server-only", () => ({}));
import { afterEach, describe, expect, it, vi } from "vitest";
import { inventoryIntegrationEnabled, requireInventoryIntegration } from "../lib/inventory-domain/rollout";
const database = vi.hoisted(() => ({ ensureSchema: vi.fn(), getPool: vi.fn() }));
vi.mock("../lib/db", () => database);
vi.mock("../lib/session", () => ({ requireSession: vi.fn(() => { throw new Error("disabled route must stop before session/store access"); }) }));
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
describe("inventory integration rollout", () => {
  it.each([undefined, "", "false", "1", "TRUE", " true "])("fails closed for %s", value => {
    vi.stubEnv("INVENTORY_INTEGRATION_ENABLED", value);
    expect(inventoryIntegrationEnabled()).toBe(false);
    expect(requireInventoryIntegration).toThrow(expect.objectContaining({ code: "inventory_integration_disabled" }));
  });
  it("rejects direct API calls before parsing or calling stores", async () => {
    vi.stubEnv("INVENTORY_INTEGRATION_ENABLED", undefined);
    const { GET, POST } = await import("../app/api/inventory/procurement/route");
    const request = new Request("http://localhost/api/inventory/procurement", { method: "POST", body: "not-json" });
    for (const handler of [GET, POST]) {
      const response = await handler(request);
      expect(response.status).toBe(503);
      expect((await response.json()).code).toBe("inventory_integration_disabled");
    }
    expect(request.bodyUsed).toBe(false);
    expect(database.getPool).not.toHaveBeenCalled();
  });
  it("requires explicit server opt-in", () => {
    vi.stubEnv("INVENTORY_INTEGRATION_ENABLED", "true");
    expect(inventoryIntegrationEnabled()).toBe(true);
  });
  it("blocks store reads and the shared mutation transaction before database access", async () => {
    vi.stubEnv("INVENTORY_INTEGRATION_ENABLED", undefined);
    const store = await import("../lib/inventory-domain/procurement-store");
    const custody = await import("../lib/inventory-domain/custody-store");
    const actor = { userId: 1, username: "synthetic", role: "admin" };
    const work = vi.fn();
    for (const call of [() => store.readProcurementRequests(actor), () => store.readProcurementCatalog(actor), () => store.readProcurementWorkbench(actor), () => custody.readDoctorCustody(actor), () => store.inventoryOperation(actor, "synthetic-key", "test", {}, true, work)]) {
      await expect(call()).rejects.toMatchObject({ code: "inventory_integration_disabled" });
    }
    expect(database.ensureSchema).not.toHaveBeenCalled();
    expect(database.getPool).not.toHaveBeenCalled();
    expect(work).not.toHaveBeenCalled();
  });
});
