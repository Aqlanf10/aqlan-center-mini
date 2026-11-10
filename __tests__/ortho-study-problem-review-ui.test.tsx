import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const hooks = vi.hoisted(() => ({ slots: [] as unknown[], cursor: 0, effects: [] as { index: number; effect(): void | (() => void) }[], cleanups: new Map<number, () => void>() }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useState(initial: unknown) {
    const index = hooks.cursor++;
    if (!(index in hooks.slots)) hooks.slots[index] = typeof initial === "function" ? initial() : initial;
    return [hooks.slots[index], (value: unknown) => { hooks.slots[index] = typeof value === "function" ? value(hooks.slots[index]) : value; }];
  },
  useEffect(effect: () => void | (() => void), dependencies: unknown[]) {
    const index = hooks.cursor++, prior = hooks.slots[index] as unknown[] | undefined;
    if (!prior || dependencies.some((value, offset) => value !== prior[offset])) { hooks.slots[index] = dependencies; hooks.effects.push({ index, effect }); }
  },
}));
import { SourcePicker } from "../components/OrthoCaseStudy";
import OrthoSavedStudyReview from "../components/OrthoSavedStudyReview";
import { studyPreviewFixture } from "./fixtures/ortho-study-preview";
import { makeStudyOwner } from "../lib/ortho-case-study-owner";
import { makeStudyRecoveryLedger } from "../lib/ortho-case-study-recovery";
import type { StudySourceSelection } from "../lib/ortho-case-study";
type Element = ReactElement<Record<string, unknown>>;
const nodes = (node: ReactNode): Element[] => Array.isArray(node) ? node.flatMap(nodes) : node && typeof node === "object" && "props" in node
  ? [node as Element, ...nodes((node as Element).props.children as ReactNode)] : [];
const words = (node: ReactNode): string => Array.isArray(node) ? node.map(words).join("") : node && typeof node === "object" && "props" in node
  ? words((node as Element).props.children as ReactNode) : typeof node === "string" || typeof node === "number" ? String(node) : "";
beforeEach(() => { hooks.slots = []; hooks.cursor = 0; hooks.effects = []; hooks.cleanups.clear(); });
afterEach(() => { for (const cleanup of hooks.cleanups.values()) cleanup(); vi.unstubAllGlobals(); });
const scope = { patientId: 19, orthoCaseId: 41, clinicalCaseId: 51 };
const selection: StudySourceSelection = { key: "problem_review_10", kind: "problem_review", id: 10, version: null, contentHash: "c".repeat(64) };
const makeOwner = () => {
  const owner = makeStudyOwner({ ...scope, actorId: 7, recovery: makeStudyRecoveryLedger(), authorized: () => true, writable: () => true, deny: vi.fn() });
  owner.activate(); return owner;
};
it("loads the reviewed-problem inventory and passes the exact offered hash through explicit selection", async () => {
  const owner = makeOwner(), choose = vi.fn(), fetcher = vi.fn(async (url: string) => {
    const kind = new URL(url, "https://synthetic.invalid").searchParams.get("kind");
    return new Response(JSON.stringify({ ok: true, ...scope, kind, state: "available", nextAfterId: null,
      choices: kind === "problem_review" ? [{ id: 10, version: null, kind, state: "available", unavailableReason: null, selection }] : [] }),
    { headers: { "cache-control": "no-store" } });
  });
  vi.stubGlobal("fetch", fetcher);
  const render = () => {
    hooks.cursor = 0;
    const tree = SourcePicker({ ...scope, patientName: "Synthetic", owner, ownerKey: "synthetic", confirmDiscard: () => false, locale: "en", editable: true, onChoose: choose });
    for (const { index, effect } of hooks.effects.splice(0)) { hooks.cleanups.get(index)?.(); const cleanup = effect(); if (cleanup) hooks.cleanups.set(index, cleanup); }
    return tree;
  };
  const first = nodes(render()); expect(first.some(node => node.type === "option" && node.props.value === "problem_review")).toBe(true);
  (first.find(node => node.type === "select")!.props.onChange as (event: unknown) => void)({ currentTarget: { value: "problem_review" } });
  render(); await vi.waitFor(() => expect(nodes(render()).some(node => node.type === "button" && words(node) === "Select")).toBe(true));
  const tree = render(), button = nodes(tree).find(node => node.type === "button" && words(node) === "Select")!;
  expect(button.props.disabled).toBe(false); (button.props.onClick as () => void)();
  expect(choose).toHaveBeenCalledExactlyOnceWith(selection);
  expect(fetcher.mock.calls.some(([url]) => url.includes("kind=problem_review"))).toBe(true);
  expect(words(tree)).toContain("without replacement by current data");
});
it("identifies saved problem reviews as historical without injecting local source facts", () => {
  const revision = studyPreviewFixture(); revision.authored.sources = [selection]; revision.authored.panels = []; revision.authored.mediaUses = [];
  const tree = OrthoSavedStudyReview({ owner: makeOwner(), revision, readVersion: 0, locale: "en" });
  expect(words(tree)).toContain("Problem-source reviews below are historical");
  expect(words(tree)).toContain("not a new clinical approval");
});
