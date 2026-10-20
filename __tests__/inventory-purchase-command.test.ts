import { afterEach, describe, expect, it, vi } from "vitest";
import { createPurchaseCommand, isPurchaseCommand, purchaseDigest, purchaseDocument, purchaseInputError, readPurchaseAcknowledgment, readPurchaseReceipt, verifyPurchaseCommand, type PurchaseCommand } from "../lib/inventory-purchase-command";
import { readPurchaseJournal, reservePurchaseCommand } from "../lib/purchase-command-journal";

const purchase = { kind: "in", qty: 1.001, unitCost: "25", supplierPartyId: 5, expiryDate: "2028-02-29", reason: "Synthetic purchase" };
const scope = { actor: "synthetic-owner", actorUserId: 7, itemId: 19 };
const make = (document: Record<string, unknown> = purchase) => createPurchaseCommand(scope.actor, scope.actorUserId, scope.itemId, document);
const proof = (command: PurchaseCommand) => ({
  protocol: "inventory-purchase-v1", status: "committed", actorUserId: scope.actorUserId, requestKey: command.key, requestDigest: command.digest,
  itemId: scope.itemId, movementId: 42, replayed: false, payableCreated: true,
  result: { ok: true, balance: 3.001, movement: { id: 42, itemId: scope.itemId, kind: "in", qty: 1.001,
    expiryDate: "2028-02-29", reason: "Synthetic purchase", visitId: null, isReturn: false, createdBy: scope.actor, createdAt: "2026-10-20T14:00:00Z" } },
});
const rejection = (command: PurchaseCommand) => ({ protocol: "inventory-purchase-v1", status: "rejected", actorUserId: scope.actorUserId,
  requestKey: command.key, requestDigest: command.digest, itemId: scope.itemId, replayed: false, message: "المورّد غير موجود أو موقوف." });
afterEach(() => vi.unstubAllGlobals());

describe("purchase command identity and acknowledged outcome", () => {
  it("freezes serialized submitted presence/types and binds the principal and item", async () => {
    const document = { ...purchase, supplierDueDate: undefined };
    const command = await make(document);
    document.qty = 2;
    expect(JSON.parse(command.body)).toEqual({ protocol: "inventory-purchase-v1", purchase });
    expect(JSON.parse(command.body)).not.toHaveProperty("kind");
    expect(command).toMatchObject(scope);
    expect(isPurchaseCommand(command)).toBe(true);
    expect(await verifyPurchaseCommand(command)).toBe(true);
    expect(await verifyPurchaseCommand({ ...command, body: JSON.stringify({ protocol: "inventory-purchase-v1", purchase: document }) })).toBe(false);
  });
  it("uses identical canonical digest despite object ordering, but preserves values, types and presence", async () => {
    const first = await make({ kind: "in", qty: 2, reason: null });
    expect(await purchaseDigest(19, { reason: null, qty: 2, kind: "in" })).toBe(first.digest);
    for (const changed of [{ kind: "in", qty: 2 }, { kind: "in", qty: "2", reason: null }, { kind: "in", qty: 3, reason: null }]) {
      expect(await purchaseDigest(19, changed)).not.toBe(first.digest);
    }
    expect(await purchaseDigest(20, { kind: "in", qty: 2, reason: null })).not.toBe(first.digest);
  });
  it("accepts only a matching committed receipt and returns no restricted movement fields", async () => {
    const command = await make(), valid = proof(command);
    expect(readPurchaseAcknowledgment(valid, command)).toEqual({ status: "committed", actorUserId: 7, requestKey: command.key, requestDigest: command.digest,
      itemId: 19, movementId: 42, replayed: false, payableCreated: true, balance: 3.001 });
    expect(readPurchaseAcknowledgment({ ...valid, result: { ...valid.result, movement: { ...valid.result.movement, payableId: 301, partyId: 5, unitCostMinor: 25 } } }, command))
      .not.toHaveProperty("payableId");
  });
  const invalid = [
    ["protocol", "legacy"], ["status", "ok"], ["actorUserId", 8], ["requestKey", "another"], ["requestDigest", "0".repeat(64)],
    ["itemId", 20], ["movementId", 43], ["replayed", "false"], ["payableCreated", false],
  ] as const;
  it.each(invalid)("rejects mismatched %s", async (field, value) => {
    const command = await make(); expect(readPurchaseReceipt({ ...proof(command), [field]: value }, command)).toBeNull();
  });
  it.each([
    ["id", 43], ["itemId", 20], ["kind", "out"], ["qty", 2], ["createdBy", "another"], ["isReturn", true],
    ["visitId", 15], ["expiryDate", "2028-03-01"], ["reason", "Different"], ["createdAt", "bad-date"],
  ])("rejects contradictory movement %s", async (field, value) => {
    const command = await make(), valid = proof(command);
    expect(readPurchaseReceipt({ ...valid, result: { ...valid.result, movement: { ...valid.result.movement, [field]: value } } }, command)).toBeNull();
  });
  it.each([
    { unitCostMinor: 25 }, { partyId: 5, payableId: 301 },
    { unitCostMinor: 26, partyId: 5, payableId: 301 },
    { unitCostMinor: 25, partyId: 6, payableId: 301 },
    { unitCostMinor: 25, partyId: 5, payableId: null },
    { unitCostMinor: 25, partyId: 5, payableId: 0 },
    { unitCostMinor: 25, partyId: 5, payableId: "301" },
  ])("rejects partial or contradictory admin financial projection %j", async fields => {
    const command = await make(), valid = proof(command);
    expect(readPurchaseReceipt({ ...valid, result: { ...valid.result, movement: { ...valid.result.movement, ...fields } } }, command)).toBeNull();
  });
  it("requires null supplier/payable fields for a stock-only admin receipt", async () => {
    const command = await make({ kind: "in", qty: 1.001, expiryDate: "2028-02-29", reason: "Synthetic purchase" });
    const valid = { ...proof(command), payableCreated: false };
    const movement = { ...valid.result.movement, unitCostMinor: null, partyId: null, payableId: null };
    expect(readPurchaseReceipt({ ...valid, result: { ...valid.result, movement } }, command)).not.toBeNull();
    expect(readPurchaseReceipt({ ...valid, result: { ...valid.result, movement: { ...movement, payableId: 301 } } }, command)).toBeNull();
  });
  it("accepts only an identified terminal rejection, not generic errors or contradictory success fields", async () => {
    const command = await make(), rejected = rejection(command);
    expect(readPurchaseReceipt(rejected, command)).toMatchObject({ status: "rejected", message: rejected.message });
    for (const invalid of [{ message: rejected.message }, { ...rejected, actorUserId: 8 }, { ...rejected, requestDigest: "x" },
      { ...rejected, result: {} }, { ...rejected, movementId: 42 }, { ...rejected, payableCreated: false }, { ...rejected, message: "" }]) {
      expect(readPurchaseReceipt(invalid, command)).toBeNull();
    }
  });
  it.each(["a".repeat(299) + "😀", "lone \ud800 surrogate"])("accepts the server UTF-8 normalized reason without altering canonical identity", async reason => {
    const command = await make({ ...purchase, reason });
    const valid = proof(command);
    const normalized = new TextDecoder().decode(new TextEncoder().encode(reason.trim().slice(0, 300)));
    expect(readPurchaseReceipt({ ...valid, result: { ...valid.result, movement: { ...valid.result.movement, reason: normalized } } }, command)).not.toBeNull();
    expect(JSON.parse(command.body).purchase.reason).toBe(reason);
  });
  it("supports stock-only input without inventing a supplier obligation", async () => {
    const command = await make({ kind: "in", qty: 1.001, expiryDate: "2028-02-29", reason: "Synthetic purchase" });
    expect(readPurchaseReceipt({ ...proof(command), payableCreated: false }, command)).toMatchObject({ payableCreated: false });
  });
  it.each([{}, { protocol: "wrong", purchase }, { protocol: "inventory-purchase-v1", kind: "in", purchase },
    { protocol: "inventory-purchase-v1", purchase: { kind: "out", qty: 1 } },
    { protocol: "inventory-purchase-v1", purchase: { kind: "in", qty: 1, isReturn: true } },
    { protocol: "inventory-purchase-v1", purchase: { kind: "in", qty: 1, patientId: 9 } },
  ])("rejects unsupported envelopes before storage", document => expect(purchaseDocument(JSON.stringify(document))).toBeNull());
});

describe("purchase prevalidation and fail-closed recovery", () => {
  it.each(["1", 1, 1.001, 0.001, 1_000_000])("accepts exact positive quantity %s", qty => expect(purchaseInputError({ kind: "in", qty })).toBeNull());
  it.each([0, -1, 1.0001, 1_000_001, Infinity, NaN])("rejects invalid quantity %s before reservation", qty => expect(purchaseInputError({ kind: "in", qty })).not.toBeNull());
  it.each(["", "bad", "-1", "0"]) ("requires a positive supplier unit price %s", unitCost => expect(purchaseInputError({ ...purchase, unitCost })).not.toBeNull());
  it.each([true, [], "0x5", " 5", "5.0", "5e0", "+5", 0, 2_147_483_648])("rejects malformed supplier %s", supplierPartyId => expect(purchaseInputError({ ...purchase, supplierPartyId })).not.toBeNull());
  it.each(["2026-02-29", "2026-13-01", "2026-00-01", "not-date"])("rejects invalid date %s without throwing", expiryDate => expect(purchaseInputError({ ...purchase, expiryDate })).not.toBeNull());
  it("rejects a NUL retained in the normalized reason before reservation", () => {
    expect(purchaseInputError({ ...purchase, reason: "Synthetic\u0000purchase" })).not.toBeNull();
  });
  it("permits a NUL outside the existing 300-character retained reason boundary", () => {
    expect(purchaseInputError({ ...purchase, reason: "a".repeat(300) + "\u0000" })).toBeNull();
  });
  it("does not alter money rounding policy and rejects unsafe extended value", () => {
    expect(purchaseInputError({ ...purchase, qty: 0.001, unitCost: "1" })).toBeNull();
    expect(purchaseInputError({ ...purchase, qty: 1_000_000, unitCost: String(Number.MAX_SAFE_INTEGER) })).not.toBeNull();
  });
  it("fails closed when IndexedDB is absent or digest was changed", async () => {
    const command = await make(); vi.stubGlobal("indexedDB", undefined);
    await expect(readPurchaseJournal(scope)).rejects.toMatchObject({ code: "unavailable" });
    await expect(reservePurchaseCommand(scope, 0, command)).rejects.toMatchObject({ code: "unavailable" });
    await expect(reservePurchaseCommand(scope, 0, { ...command, digest: "0".repeat(64) })).rejects.toMatchObject({ code: "invalid" });
    await expect(reservePurchaseCommand({ ...scope, actorUserId: 8 }, 0, command)).rejects.toMatchObject({ code: "invalid" });
  });
});
