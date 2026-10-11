import { describe, expect, it } from "vitest";
import { checkStudyExportCommand, type StudyExportCommand } from "../lib/ortho-case-study-export";
const command = (): StudyExportCommand => ({ schemaVersion: 1, clientRequestId: "synthetic_export_command_01",
  study: { id: 7, contentHash: "a".repeat(64), kind: "draft" }, formats: ["pptx", "pdf"], expectedRenderingContractHash: "b".repeat(64) });
describe("public study export intent contains no artifact authority", () => {
  it.each(["draft", "documented"] as const)("permits explicit %s export without inventing clinical approval", kind => {
    const input = command(); input.study.kind = kind;
    expect(checkStudyExportCommand(input)).toEqual({ ok: true, value: input });
  });
  it.each(["projection", "renditions", "actorId", "leaseToken", "storageKey", "workerVersion", "ready"] as const)("refuses client %s authority", field => {
    expect(checkStudyExportCommand({ ...command(), [field]: "untrusted" }).ok).toBe(false);
  });
  it.each([[], ["pdf", "pptx"], ["pptx", "pptx"], ["html"], [["pptx"]]].map(formats => ({ formats })))("refuses noncanonical format set $formats", ({ formats }) => {
    expect(checkStudyExportCommand({ ...command(), formats }).ok).toBe(false);
  });
  it("requires exact primitive study identity/kind and current expected renderer contract", () => {
    const input = command();
    for (const study of [{ ...input.study, id: "7" }, { ...input.study, kind: ["draft"] },
      { ...input.study, contentHash: "bad" }, { ...input.study, approved: true }]) {
      expect(checkStudyExportCommand({ ...input, study }).ok).toBe(false);
    }
    expect(checkStudyExportCommand({ ...input, expectedRenderingContractHash: null }).ok).toBe(false);
  });
  it("returns a detached bounded command", () => {
    const input = command(), result = checkStudyExportCommand(input); expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("fixture rejected");
    result.value.formats.pop(); result.value.study.id = 9;
    expect(input.formats).toEqual(["pptx", "pdf"]); expect(input.study.id).toBe(7);
  });
});
