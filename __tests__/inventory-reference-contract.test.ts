import { describe, expect, it } from "vitest";
import { validateReferenceInput } from "../lib/inventory-domain/reference-validation";
import {
  isReferenceTerminal,
  acknowledgeReferenceCommand,
  decodeReferenceJournal,
} from "../lib/inventory-reference-journal";
import type { ReferenceIntent } from "../lib/inventory-reference-protocol";
const intent: ReferenceIntent = {
  protocol: "inventory-reference-v1",
  authority: {
    realmId: "synthetic-realm",
    subjectId: "synthetic-subject",
    generation: "synthetic-generation",
  },
  nonce: "00000000-0000-4000-8000-000000000001",
  input: {
    action: "unit.revise",
    itemId: 2,
    expectedVersion: 1,
    enteredUnit: "box",
    factor: "12",
    enteredPrecision: 0,
    basePrecision: 0,
    reason: "Verified printed package quantity",
  },
};
const ack = {
  intent,
  identity: {
    scope: "reference.setup",
    actorUserId: 3,
    username: "synthetic-admin",
    operationKey: `reference:${"a".repeat(64)}`,
    payloadDigest: "b".repeat(64),
    realmId: intent.authority.realmId,
    subjectId: intent.authority.subjectId,
  },
  status: "committed",
  result: { action: "unit.revise", id: "2", version: 2, replayed: false },
};
describe("reference setup validation and durable acknowledgement boundary", () => {
  it.each([
    { revision: 0, legacyPayload: "preserve" },
    { revision: 0, intent: undefined },
    { revision: 0, intent: false },
    { revision: 0, intent: null, legacyPayload: "preserve" },
    { revision: 0, intent: { ...intent, nonce: "bad" } },
    null,
  ])(
    "refuses existing corrupt journal without changing its bytes %j",
    (value) => {
      const before = JSON.stringify(value);
      expect(() => decodeReferenceJournal(value, intent.authority)).toThrow(
        "reference_storage_invalid",
      );
      expect(JSON.stringify(value)).toBe(before);
    },
  );
  it("only absent key or explicit null intent is empty", () => {
    expect(decodeReferenceJournal(undefined, intent.authority)).toEqual({
      revision: 0,
      intent: null,
    });
    expect(
      decodeReferenceJournal({ revision: 3, intent: null }, intent.authority),
    ).toEqual({ revision: 3, intent: null });
  });
  it("malformed terminal echoes return false", () => {
    expect(isReferenceTerminal(intent, { ...ack, intent: undefined })).toBe(
      false,
    );
    expect(isReferenceTerminal(intent, { ...ack, intent: {} })).toBe(false);
  });
  it("validates explicit package conversion", () =>
    expect(() => validateReferenceInput(intent.input)).not.toThrow());
  it.each([
    { factor: "0" },
    { factor: "-1" },
    { enteredPrecision: 4 },
    { basePrecision: 1.5 },
    { expectedVersion: -1 },
    { itemId: 0 },
    { reason: "" },
  ])("rejects invalid package input %j", (patch) =>
    expect(() =>
      validateReferenceInput({
        ...intent.input,
        ...patch,
      } as typeof intent.input),
    ).toThrow(),
  );
  it.each([
    { status: 403 },
    { status: 409 },
    { status: "pending" },
    { status: "admitted" },
    { status: "committed", result: undefined },
    { status: "committed", result: {} },
    { status: "retired", reason: "" },
  ])("never retires on incomplete/nonterminal result %j", (patch) =>
    expect(isReferenceTerminal(intent, { ...ack, ...patch })).toBe(false),
  );
  it.each([
    { id: "3" },
    { version: 3 },
    { action: "item.create" },
    { replayed: undefined },
    { replayed: "true" },
  ])("requires exact result source/version %j", (patch) =>
    expect(
      isReferenceTerminal(intent, {
        ...ack,
        result: { ...ack.result, ...patch },
      }),
    ).toBe(false),
  );
  it("preserves original generation and subject", () => {
    expect(
      isReferenceTerminal(intent, {
        ...ack,
        intent: {
          ...intent,
          authority: { ...intent.authority, generation: "changed" },
        },
      }),
    ).toBe(false);
    expect(
      isReferenceTerminal(intent, {
        ...ack,
        identity: { ...ack.identity, subjectId: "other" },
      }),
    ).toBe(false);
  });
  it("checks cryptographic key and semantic digest before opening durable storage", async () => {
    expect(isReferenceTerminal(intent, ack)).toBe(true);
    await expect(acknowledgeReferenceCommand(intent, ack)).rejects.toThrow(
      "reference_acknowledgement_invalid",
    );
  });
});
