import { beforeEach, describe, expect, it, vi } from "vitest";
const boundary = vi.hoisted(() => ({ deleteVisit: vi.fn(), linkVisitToPatient: vi.fn() }));
vi.mock("@/lib/session", () => ({ requireSession: async () => ({ username: "identity-admin", role: "admin" }) }));
vi.mock("@/lib/operational-access", () => ({ authorizeVisit: async () => ({ ok: true }), authorizeVisitLink: async () => ({ ok: true }) }));
vi.mock("@/lib/db", () => ({ ...boundary }));
import { DELETE, PATCH } from "../app/api/visits/[id]/route";
import { VISIT_DELETE_MESSAGE } from "../lib/visit-record-identity";

// In-process response mapping only. Already-linked synthetic admin fixture;
// no real database, server, network, browser, or authorization-bypass exercise.
const context = { params: Promise.resolve({ id: "101" }) };
const request = (method: string, body: unknown) => new Request("http://test.invalid/api/visits/101", {
  method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});
beforeEach(() => { vi.resetAllMocks(); });

describe("visit identity conflict responses", () => {
  it.each(["has_clinical_history", "has_linked_workflow", "has_financial_history"] as const)(
    "maps the existing %s delete protection to 409", async reason => {
      boundary.deleteVisit.mockResolvedValue({ ok: false, reason });
      const response = await DELETE(request("DELETE", { reason: "Synthetic correction" }), context);
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ code: reason, message: VISIT_DELETE_MESSAGE[reason] });
      expect(boundary.deleteVisit).toHaveBeenCalledWith(101, {
        actor: "identity-admin", actorRole: "admin", reason: "Synthetic correction",
      });
    });
  it("retains an unexpected transactional failure as failure instead of claiming deletion", async () => {
    boundary.deleteVisit.mockRejectedValue(new Error("Synthetic late reference"));
    expect((await DELETE(request("DELETE", {}), context)).status).toBe(500);
  });
  it("returns a typed relink conflict without hiding the refusal message", async () => {
    boundary.linkVisitToPatient.mockResolvedValue({ ok: false, reason: "identity_changed", message: "Synthetic mapping changed" });
    const response = await PATCH(request("PATCH", { action: "link", patientId: 102 }), context);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ code: "identity_changed", message: "Synthetic mapping changed" });
  });
});
