import { describe, expect, it } from "vitest";
import { acknowledgeStoredRetentionCommand, readRetentionCommandAcknowledgment } from "../lib/ortho-retention-command-ack";
const expected = { revisionId: 43, actorId: 7, commandId: "synthetic_retention_command_001", requestFingerprint: "a".repeat(64) };
const row = { id: 43, actor_user_id: 7, command_id: expected.commandId, request_fingerprint: expected.requestFingerprint };
describe("stored exact-actor retention command acknowledgment", () => {
  it("returns only the exact canonical stored identity and no user profile", () => {
    const value = acknowledgeStoredRetentionCommand(row, expected);
    expect(value).toEqual({ schemaVersion: 1, ...expected });
    expect(Object.keys(value).sort()).toEqual(["schemaVersion", "revisionId", "actorId", "commandId", "requestFingerprint"].sort());
    expect(readRetentionCommandAcknowledgment(value)).toEqual(value);
  });
  it("refuses an actor, command, fingerprint or row mismatch without synthesizing an acknowledgment", () => {
    for (const changed of [{ ...row, actor_user_id: 8 }, { ...row, id: 44 }, { ...row, command_id: "synthetic_retention_command_002" },
      { ...row, request_fingerprint: "b".repeat(64) }]) expect(() => acknowledgeStoredRetentionCommand(changed, expected)).toThrow();
  });
  it("rejects unknown fields and unsafe/coerced identity values", () => {
    const valid = { schemaVersion: 1, ...expected };
    for (const value of [{ ...valid, actorId: "7" }, { ...valid, actorId: 0 }, { ...valid, revisionId: Number.MAX_SAFE_INTEGER + 1 },
      { ...valid, actorName: "Not a verified ID" }, { ...valid, schemaVersion: 2 }, { ...valid, requestFingerprint: "A".repeat(64) }])
      expect(() => readRetentionCommandAcknowledgment(value)).toThrow("invalid_retention_acknowledgment");
  });
});
