import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acknowledgeSupplierCommand,
  listSupplierCommands,
  saveSupplierCommand,
  type SupplierSavedCommand,
} from "../lib/inventory-supplier-journal";
import type { SupplierAcknowledgement } from "../lib/inventory-supplier-protocol";
const command: SupplierSavedCommand = {
  intent: {
    protocol: "inventory-supplier-v2",
    authority: {
      realmId: "realm",
      subjectId: "subject",
      executionEpochId: "epoch",
    },
    nonce: "nonce",
    action: "post",
    input: {
      invoiceId: "invoice",
      expectedVersion: 1,
      expectedDigest: "a".repeat(64),
      reason: "Reviewed source",
    },
  },
};
command.admission = {
  envelope: {
    ...command.intent,
    operationKey: "key",
    actorUserId: 7,
    username: "owner",
  },
  digest: "b".repeat(64),
};
afterEach(() => vi.unstubAllGlobals());
describe("supplier durable acknowledgement boundary", () => {
  it.each([
    { status: 403 },
    { status: 409 },
    { status: "pending" },
    { status: "failed" },
  ])("never clears on nonterminal transport outcome %j", async (patch) => {
    await expect(
      acknowledgeSupplierCommand(command, {
        ...command.admission,
        ...patch,
      } as unknown as SupplierAcknowledgement),
    ).rejects.toThrow("supplier_acknowledgement_mismatch");
  });
  it.each(["operationKey", "actorUserId", "authority"] as const)(
    "refuses altered %s before durable storage",
    async (field) => {
      const ack = {
        ...command.admission!,
        status: "committed" as const,
        envelope: {
          ...command.admission!.envelope,
          [field]:
            field === "actorUserId"
              ? 8
              : field === "authority"
                ? { ...command.intent.authority, subjectId: "other" }
                : "other",
        },
      };
      await expect(acknowledgeSupplierCommand(command, ack)).rejects.toThrow(
        "supplier_acknowledgement_mismatch",
      );
    },
  );
  it.each([
    { status: "committed" },
    { status: "committed", result: {} },
    {
      status: "committed",
      result: {
        invoiceId: "other",
        status: "posted",
        payableId: 1,
        replayed: false,
        stockEffects: 0,
        cashEffects: 0,
        payableEffects: 1,
      },
    },
    {
      status: "committed",
      result: {
        invoiceId: "invoice",
        status: "posted",
        payableId: null,
        replayed: false,
        stockEffects: 0,
        cashEffects: 0,
        payableEffects: 1,
      },
    },
    { status: "retired" },
    { status: "retired", reason: "" },
  ])("holds incomplete terminal acknowledgement %j", async (patch) => {
    await expect(
      acknowledgeSupplierCommand(command, {
        ...command.admission,
        ...patch,
      } as SupplierAcknowledgement),
    ).rejects.toThrow("supplier_acknowledgement_mismatch");
  });
  it("fails closed before any admission request when IndexedDB is unavailable", async () => {
    vi.stubGlobal("indexedDB", undefined);
    await expect(saveSupplierCommand(command)).rejects.toThrow(
      "supplier_storage_unavailable",
    );
    await expect(listSupplierCommands("realm", "subject")).rejects.toThrow(
      "supplier_storage_unavailable",
    );
  });
});
