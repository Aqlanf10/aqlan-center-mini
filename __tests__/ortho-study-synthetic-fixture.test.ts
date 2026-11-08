import { expect, it } from "vitest";
import { syntheticStudyCommand as testCommand } from "./fixtures/ortho-case-study";
import { syntheticStudyCommand } from "../scripts/fixtures/ortho-case-study";
import { checkStudySaveCommand } from "../lib/ortho-case-study";
import { CASE_TEMPLATE_VERSION } from "../lib/ortho-case-template";
import { STUDY_TEMPLATE_HASH } from "../lib/ortho-case-study-template";

it("shares fresh synthetic-only valid commands between tests and offline verifiers", () => {
  expect(testCommand).toBe(syntheticStudyCommand);
  const first = syntheticStudyCommand();
  const second = testCommand();
  expect(checkStudySaveCommand(first).ok).toBe(true);
  expect(first.content.template).toEqual({
    key: "full-orthodontic-case", version: CASE_TEMPLATE_VERSION, contentHash: STUDY_TEMPLATE_HASH,
  });
  expect(first.content.identityDisclosure).toBe("case_only");
  expect(first.content.sources).toEqual([]);
  expect(first.content.groups).toEqual([]);
  expect(first.content.mediaUses).toEqual([]);
  expect(first.content.panels[0].state).toBe("not_recorded");
  expect(first.clientRequestId).not.toBe(second.clientRequestId);
  first.content.panels[0].comment = "Changed in one caller only";
  first.content.sources.push({ key: "synthetic", kind: "diagnosis", id: 1, version: 1, contentHash: "a".repeat(64) });
  expect(second.content.panels[0].comment).toBe("Missing findings remain explicit");
  expect(second.content.sources).toEqual([]);
});
