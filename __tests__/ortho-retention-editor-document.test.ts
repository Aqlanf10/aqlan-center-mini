import { expect, it } from "vitest";
import { readRetentionEditorDocument } from "../lib/ortho-retention-editor-document";
import { initialRetentionEditor } from "../lib/ortho-retention-editor";
import { readFixture } from "./fixtures/ortho-retention-ui";
it("round-trips incomplete explicit drafts without filling clinical facts", () => {
  const value = initialRetentionEditor(readFixture()); expect(readRetentionEditorDocument(JSON.stringify(value))).toEqual(value);
  expect(readRetentionEditorDocument(JSON.stringify({ ...value, occurrence: { occurredOn: null, dateProvenance: "historical_source", sourceNote: "still entering" } })))
    .toMatchObject({ occurrence: { occurredOn: null, dateProvenance: "historical_source" } });
});
it("rejects extra fields, malformed identities, mismatched correction metadata and capacity overflow", () => {
  const value = initialRetentionEditor(readFixture());
  for (const raw of [{ ...value, actorId: 17 }, { ...value, device: { deviceId: "101", expectedDeviceRevisionId: 101 } },
    { ...value, supersedesEntryId: 101 }, { ...value, documentIds: [1, 1] }, { ...value, findings: {} }, { ...value, reason: "a".repeat(501) },
    { ...value, previousVersion: 1 }, { ...value, occurrence: { ...value.occurrence, dateProvenance: "guessed" } }]) expect(readRetentionEditorDocument(JSON.stringify(raw))).toBeNull();
  expect(readRetentionEditorDocument("not JSON")).toBeNull(); expect(readRetentionEditorDocument(" ".repeat(256 * 1024 + 1))).toBeNull();
});
it("never coerces array or non-string enum values into typed restored fields", () => {
  const value = initialRetentionEditor(readFixture());
  for (const raw of [{ ...value, arch: ["upper"] }, { ...value, originalArch: ["upper"], supersedesEntryId: 101 },
    { ...value, deviceType: ["fixed"] }, { ...value, status: ["lost"] },
    { ...value, occurrence: { ...value.occurrence, dateProvenance: ["unknown"] } },
    { ...value, findings: { ...value.findings, fit: { state: ["unknown"], note: "" } } }]) expect(readRetentionEditorDocument(JSON.stringify(raw))).toBeNull();
});
