import { afterEach, describe, expect, it, vi } from "vitest";
import { createInventoryRecoveryCommand, describeInventoryRecoveryCommand, inventoryRecoveryDigest, inventoryRecoveryIdentity, isInventoryRecoveryCommand, readInventoryRecoveryAcknowledgement, verifyInventoryRecoveryCommand, INVENTORY_RECOVERY_PROTOCOL } from "../lib/inventory-command-recovery";
import { readInventoryCommandJournal, reserveInventoryRecoveryCommand } from "../lib/inventory-command-journal";

const scope = { actor: "synthetic-owner", actorUserId: 7, workspace: "custody" as const };
const document = { usage: { id: "synthetic", quantity: "1", patientId: 19, reason: "Synthetic actual usage" } };
afterEach(() => vi.unstubAllGlobals());
describe("inventory recovery identity", () => {
  it("snapshots before hashing, preserves types/currency and validates the exact serialized command", async () => {
    const input = structuredClone(document);
    const pending = createInventoryRecoveryCommand(scope, "custody.consume", input);
    input.usage.quantity = "99";
    const command = await pending;
    expect(JSON.parse(command.body).usage.quantity).toBe("1");
    expect(isInventoryRecoveryCommand(command)).toBe(true);
    expect(await verifyInventoryRecoveryCommand(command)).toBe(true);
    expect(await verifyInventoryRecoveryCommand({ ...command, body: command.body.replace('"quantity":"1"', '"quantity":"2"') })).toBe(false);
    expect(inventoryRecoveryIdentity({ currency: "SAR", amount: 3 })).toBe(inventoryRecoveryIdentity({ amount: 3, currency: "SAR" }));
    for (const changed of [{ currency: "USD", amount: 3 }, { currency: "SAR", amount: "3" }, { currency: "SAR", amount: 3, reason: null }]) {
      expect(await inventoryRecoveryDigest(changed)).not.toBe(await inventoryRecoveryDigest({ currency: "SAR", amount: 3 }));
    }
  });
  it.each([{ command: "receipt.post" }, { operationKey: "another-key" }])("refuses reserved envelope overrides before persistence %j", async input => {
    await expect(createInventoryRecoveryCommand(scope, "custody.consume", input)).rejects.toThrow();
  });
  it("accepts only exact committed identity, never generic errors or a mismatched actor", async () => {
    const command = await createInventoryRecoveryCommand(scope, "custody.consume", document);
    const recovery = { protocol: INVENTORY_RECOVERY_PROTOCOL, status: "committed", actorUserId: 7, key: command.key, digest: command.digest };
    expect(readInventoryRecoveryAcknowledgement({ recovery, replayed: true }, command)).not.toBeNull();
    for (const patch of [{ actorUserId: 8 }, { key: "other-key" }, { digest: "0".repeat(64) }, { status: "rejected" }, { protocol: "legacy" }]) {
      expect(readInventoryRecoveryAcknowledgement({ recovery: { ...recovery, ...patch }, replayed: true }, command)).toBeNull();
    }
    expect(readInventoryRecoveryAcknowledgement({ ok: true }, command)).toBeNull();
    expect(readInventoryRecoveryAcknowledgement({ recovery }, command)).toBeNull();
  });
  it("summarizes saved values without reading today's form or inferring a material cost", async () => {
    const command = await createInventoryRecoveryCommand(scope, "custody.consume", { usage: { ...document.usage, kind: "approved_waste" } });
    const summary = describeInventoryRecoveryCommand(command, "en");
    expect(summary).toContain("Approved custody waste"); expect(summary).toContain("Quantity: 1");
    expect(summary).toContain("Reference: synthetic"); expect(summary).not.toMatch(/cost|price|patientId|digest/i);
    expect(describeInventoryRecoveryCommand(null, "ar")).toBe("");
  });
  it("fails closed when durable storage is unavailable and rejects cross-actor reservation before opening storage", async () => {
    const command = await createInventoryRecoveryCommand(scope, "custody.consume", document);
    vi.stubGlobal("indexedDB", undefined);
    await expect(readInventoryCommandJournal(scope)).rejects.toMatchObject({ code: "unavailable" });
    await expect(reserveInventoryRecoveryCommand({ ...scope, actorUserId: 8 }, 0, command)).rejects.toMatchObject({ code: "invalid" });
    await expect(reserveInventoryRecoveryCommand({ ...scope, actor: "other" }, 0, command)).rejects.toMatchObject({ code: "invalid" });
    await expect(reserveInventoryRecoveryCommand({ ...scope, workspace: "requests" }, 0, command)).rejects.toMatchObject({ code: "invalid" });
  });
});
