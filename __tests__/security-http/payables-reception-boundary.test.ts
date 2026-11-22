import { beforeAll, describe, expect, it } from "vitest";
import { authedGet, authedMutation, harness } from "./_server";

let h: Awaited<ReturnType<typeof harness>>;
beforeAll(async () => { h = await harness(); }, 120_000);

// Built Next.js server + isolated synthetic PostgreSQL 18 fixture, no production data.
// These are read-only or pre-authorisation denial requests: no payable is created.
describe("P1 reception supplier-payables boundary over real HTTP", () => {
  it.each([
    "/api/payables",
    "/api/payables?view=party-balances-v1",
    "/api/payables?partyId=1",
  ])("denies reception clinic-wide supplier finance %s", async (path) => {
    const response = await authedGet(path, h.sessions.reception);
    expect(response.status).toBe(403);
    const body = await response.text();
    for (const forbidden of ["balancesByCurrency", "partyIdentities", "owedMinor", "dueMinor", "amountMinor", "exchangeRate"]) {
      expect(body).not.toContain(forbidden);
    }
  });

  it("rejects reception payable creation even with invalid JSON (before body or DB)", async () => {
    const response = await authedMutation(
      "/api/payables", h.sessions.reception, "POST", "{synthetic-invalid-json",
    );
    expect(response.status).toBe(403);
    expect(await response.text()).not.toMatch(/amountMinor|owedMinor|supplierId/);
  });

  it("retains authorized accountant read without making any mutation", async () => {
    const response = await authedGet("/api/payables?view=party-balances-v1", h.sessions.accountant);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.view).toBe("party-balances-v1");
  });

  it("retains reception access to individual patient ledger", async () => {
    const response = await authedGet(`/api/patients/${h.seeded.patientAId}/ledger`, h.sessions.reception);
    expect(response.status).toBe(200);
  });
});
