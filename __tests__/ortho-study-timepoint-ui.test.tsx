import type { ReactElement, ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
vi.mock("react", async original => ({ ...await original<typeof import("react")>(), useState: (value: unknown) => [value, () => undefined] }));
import { OrthoStudyTimepoints } from "../components/OrthoStudyTimepoints";
import { checkStudySaveCommand, type StudyDraftContent } from "../lib/ortho-case-study";
import { readStudyTimepoints } from "../lib/ortho-case-study-timepoints";
import { CASE_TEMPLATE_VERSION } from "../lib/ortho-case-template";
import { STUDY_TEMPLATE_HASH } from "../lib/ortho-case-study-template";
type Element = ReactElement<Record<string, unknown>>;
const elements = (node: ReactNode): Element[] => Array.isArray(node) ? node.flatMap(elements) : node && typeof node === "object" && "props" in node
  ? [node as Element, ...elements((node as Element).props.children as ReactNode)] : [];
function fixture(): StudyDraftContent { return { template: { key: "full-orthodontic-case", version: CASE_TEMPLATE_VERSION, contentHash: STUDY_TEMPLATE_HASH },
  identityDisclosure: "case_only", sources: [{ key: "dx1", id: 1, kind: "diagnosis", version: 1, contentHash: "a".repeat(64) }], groups: [], panels: [], mediaUses: [], comment: "" }; }
describe("explicit timepoint controls", () => {
  it("stores explicit assignment and historical date evidence without inventing today's date", () => {
    let content = fixture();
    const render = () => OrthoStudyTimepoints({ content, editable: true, onChange: next => { content = next; return true; } });
    const change = (label: string, value: string) => { const control = elements(render()).find(node => node.props["aria-label"] === label)!;
      (control.props.onChange as (event: { currentTarget: { value: string } }) => void)({ currentTarget: { value } }); };
    change("dx1 timepoint", "T1"); expect(readStudyTimepoints(content)[0].occurrence).toEqual({ occurredOn: null, dateProvenance: "unknown", sourceNote: "" });
    change("T1 date", "2020-02-29"); change("T1 date source", "Synthetic historical card");
    expect(readStudyTimepoints(content)[0].occurrence).toEqual({ occurredOn: "2020-02-29", dateProvenance: "historical_source", sourceNote: "Synthetic historical card" });
    change("dx1 timepoint", "T2"); expect(readStudyTimepoints(content).find(point => point.stage === "T1")?.sources).toEqual([]);
    expect(readStudyTimepoints(content).find(point => point.stage === "T2")?.occurrence.occurredOn).toBeNull();
    expect(content.sources[0].contentHash).toBe("a".repeat(64));
  });
  it("cannot mutate read-only controls even if their callback is invoked", () => {
    const onChange = vi.fn(), tree = OrthoStudyTimepoints({ content: fixture(), editable: false, onChange });
    const select = elements(tree).find(node => node.props["aria-label"] === "dx1 timepoint")!;
    expect(select.props.disabled).toBe(true); (select.props.onChange as (event: unknown) => void)({ currentTarget: { value: "T1" } }); expect(onChange).not.toHaveBeenCalled();
  });
  it("rejects duplicate phases in the direct write contract, not only UI", () => {
    const content = fixture(); content.groups = [1, 2].map(id => ({ id: `group${id}`, label: "T1", phase: "T1", sourceKeys: ["dx1"], occurrence: { occurredOn: null, dateProvenance: "unknown", sourceNote: "" } }));
    expect(checkStudySaveCommand({ schemaVersion: 1, clientRequestId: "synthetic_timepoint_write_001", expectedHead: null, baseDocumentedRevision: null, kind: "draft", documentedFrom: null, reason: "Synthetic", content }))
      .toEqual({ ok: false, code: "duplicate_study_timepoint" });
  });
});
