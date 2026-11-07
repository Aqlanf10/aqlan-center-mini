import type { ComponentProps, ReactElement, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RetentionDocumentPicker, newRetentionEvent } from "../components/OrthoRetentionLedger";

// Synthetic hook scheduling isolates render from commit. This is not browser or
// server authorization coverage; document-response validation has separate tests.
const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0,
  effects: new Map<number, { deps?: readonly unknown[]; cleanup?: () => void }>(),
  pending: [] as Array<() => void> }));
vi.mock("react", async original => {
  const react = await original<typeof import("react")>();
  const slot = (initial: unknown) => { const i = hooks.cursor++; if (!(i in hooks.values)) hooks.values[i] = initial; return i; };
  const effect = (run: () => void | (() => void), deps?: readonly unknown[]) => {
    const i = slot(undefined), before = hooks.effects.get(i);
    if (before?.deps && deps && before.deps.length === deps.length && deps.every((v, n) => Object.is(v, before.deps![n]))) return;
    hooks.pending.push(() => { before?.cleanup?.(); const cleanup = run(); hooks.effects.set(i, { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined }); });
  };
  return { ...react, useRef: (initial: unknown) => hooks.values[slot({ current: initial })],
    useState: (initial: unknown) => { const i = slot(initial); return [hooks.values[i], (next: unknown) => { hooks.values[i] = typeof next === "function" ? next(hooks.values[i]) : next; }]; },
    useEffect: effect, useLayoutEffect: effect };
});
vi.mock("../lib/ortho-retention-client", () => ({ verifyRetentionDocumentChoices: (value: unknown) => value }));
type Props = ComponentProps<typeof RetentionDocumentPicker>;
type Element = ReactElement<Record<string, unknown>>;
const nodes = (value: ReactNode): Element[] => Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === "object" && "props" in value ? [value as Element, ...nodes((value as Element).props.children as ReactNode)] : [];
const text = (value: ReactNode): string => typeof value === "string" ? value : Array.isArray(value) ? value.map(text).join("") : value && typeof value === "object" && "props" in value ? text((value as Element).props.children as ReactNode) : "";
const click = (tree: ReactNode, label: string) => { const button = nodes(tree).find(n => n.type === "button" && text(n).startsWith(label)); if (!button) throw Error(`Missing ${label}`); (button.props.onClick as () => void)(); };
function render(props: Props, commit = true) { hooks.cursor = 0; const tree = RetentionDocumentPicker(props); if (commit) hooks.pending.splice(0).forEach(run => run()); return tree; }
afterEach(() => { hooks.effects.forEach(e => e.cleanup?.()); hooks.effects.clear(); hooks.values = []; hooks.pending = []; vi.unstubAllGlobals(); });
async function ready() {
  const witness = { id: 10, patientId: 1, orthoCaseId: 2, sha256: "a".repeat(64), metadataHash: "b".repeat(64) };
  const update = vi.fn();
  const props = { data: { scope: { patientId: 1, orthoCaseId: 2, clinicalCaseId: 3 } }, draft: { expectedDocuments: [], content: { ...newRetentionEvent("debond"), documentIds: [] } }, blocked: false, update } as unknown as Props;
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ items: [{ witness, title: "Synthetic source", mimeType: "image/png" }], nextCursor: null }), { headers: { "cache-control": "no-store" } })));
  click(render(props), "اختيار مستندات الحالة"); render(props);
  for (let i = 0; i < 20; i++) await Promise.resolve();
  return { props, update, witness, tree: render(props) };
}
describe("retention picker commit ownership", () => {
  it("does not publish an abandoned scope or permission render over the committed picker", async () => {
    const { props, update, witness, tree } = await ready();
    const values = [...hooks.values];
    render({ ...props, data: { ...props.data, scope: { ...props.data.scope, patientId: 99 } }, blocked: true }, false);
    hooks.pending = []; hooks.values = values;
    click(tree, "اختيار الشاهد الحالي");
    expect(update).toHaveBeenCalledOnce(); expect(update.mock.calls[0][0].expectedDocuments).toEqual([witness]);
  });
  it("retires retained selection callbacks at unmount", async () => {
    const { update, tree } = await ready();
    hooks.effects.forEach(effect => effect.cleanup?.()); hooks.effects.clear();
    click(tree, "اختيار الشاهد الحالي"); expect(update).not.toHaveBeenCalled();
  });
  it("rejects a retained source after a committed scope change", async () => {
    const { props, update, tree } = await ready();
    render({ ...props, data: { ...props.data, scope: { ...props.data.scope, patientId: 99 } } });
    click(tree, "اختيار الشاهد الحالي"); expect(update).not.toHaveBeenCalled();
  });
});
