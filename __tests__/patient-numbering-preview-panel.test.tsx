import { readFileSync } from "node:fs";
import type { ReactElement, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PatientNumberingPreviewPanel, type PatientNumberingPreviewPanelProps } from "../components/settings/PatientNumberingPreviewPanel";
import { normalizeNumberingFormDigits, numberingDraft, numberingPreviewProblem, validNumberingSnapshot, type NumberingPreviewInput, type NumberingPreviewResult } from "../components/settings/patient-numbering-preview-model";

// Actual component callbacks, synthetic display values, no DOM or backend. This
// checks async state and native semantics, not browser focus/keyboard rendering.
const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, changed: false,
  effects: new Map<number, { deps?: readonly unknown[]; cleanup?: () => void }>(), pending: [] as Array<() => void> }));
vi.mock("react", async original => {
  const react = await original<typeof import("react")>();
  const slot = (initial: unknown) => { const index = hooks.cursor++; if (!(index in hooks.values)) hooks.values[index] = initial; return index; };
  const effect = (run: () => void | (() => void), deps?: readonly unknown[]) => {
    const index = slot(undefined), old = hooks.effects.get(index);
    if (old?.deps && deps && old.deps.length === deps.length && deps.every((v, i) => Object.is(v, old.deps![i]))) return;
    hooks.pending.push(() => { old?.cleanup?.(); const cleanup = run(); hooks.effects.set(index, { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined }); });
  };
  return { ...react,
    useState: (initial: unknown) => { const index = slot(typeof initial === "function" ? initial() : initial); return [hooks.values[index], (value: unknown) => {
      const next = typeof value === "function" ? value(hooks.values[index]) : value;
      if (!Object.is(next, hooks.values[index])) hooks.changed = true; hooks.values[index] = next;
    }]; },
    useRef: (initial: unknown) => hooks.values[slot({ current: initial })],
    useId: () => `synthetic-numbering-${slot("id")}`, useEffect: effect, useLayoutEffect: effect,
  };
});
type Element = ReactElement<Record<string, unknown>>;
const nodes = (node: ReactNode): Element[] => Array.isArray(node) ? node.flatMap(nodes)
  : node && typeof node === "object" && "props" in node ? [node as Element, ...nodes((node as Element).props.children as ReactNode)] : [];
const text = (node: ReactNode): string => typeof node === "string" || typeof node === "number" ? String(node)
  : Array.isArray(node) ? node.map(text).join("") : node && typeof node === "object" && "props" in node ? text((node as Element).props.children as ReactNode) : "";
let props: PatientNumberingPreviewPanelProps;
function render(): ReactNode {
  for (let i = 0; i < 10; i++) {
    hooks.cursor = 0; hooks.changed = false;
    const tree = PatientNumberingPreviewPanel(props);
    // Render-phase updates settle before effects are committed, as in React.
    if (hooks.changed) { hooks.pending.length = 0; continue; }
    hooks.pending.splice(0).forEach(run => run());
    if (!hooks.changed) return tree;
  }
  throw new Error("Preview did not settle");
}
function element(type: string, tree = render()) { const match = nodes(tree).find(n => n.type === type); expect(match).toBeDefined(); return match!; }
const status = () => text(nodes(render()).find(n => n.props.role === "status"));
function change(type: "input" | "select", value: string) {
  (element(type).props.onChange as (e: { target: { value: string } }) => void)({ target: { value } }); render();
}
function submit(tree = render()) {
  const preventDefault = vi.fn();
  (element("form", tree).props.onSubmit as (e: { preventDefault: () => void }) => void)({ preventDefault });
  expect(preventDefault).toHaveBeenCalledOnce();
}
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); render(); };
const accept = (input: NumberingPreviewInput): NumberingPreviewResult => ({ ok: true, ...input, preview: `${input.prefix}-${input.next.padStart(5, "0")}` });
function deferred() {
  let resolve!: (r: NumberingPreviewResult) => void;
  const promise = new Promise<NumberingPreviewResult>(r => { resolve = r; });
  const provider = vi.fn((_input: NumberingPreviewInput) => promise);
  return { provider, resolve: () => resolve(accept(provider.mock.calls[0][0])) };
}
beforeEach(() => {
  hooks.effects.forEach(e => e.cleanup?.()); hooks.values = []; hooks.cursor = 0; hooks.changed = false; hooks.effects.clear(); hooks.pending = [];
  props = { current: { prefix: "P", next: "1500", revision: "synthetic-r1" } };
});

describe("inert numbering display grammar", () => {
  it.each([..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"])("supports %s without numerical identifier coercion", prefix => {
    expect(numberingDraft(` ${prefix.toLowerCase()} `, " 1500 ")).toEqual({ prefix, next: "1500", preview: `${prefix}-01500` });
    expect(numberingDraft(prefix, "999999999999999999")?.preview).toBe(`${prefix}-999999999999999999`);
  });
  it.each(["", "0", "01500", "-1", "+1", "1.5", "1e3", "1,500", "1 500", "١٥٠٠", "۱۵۰۰", "１２", "1000000000000000000"])("rejects unsupported next %j without guessing", next => expect(numberingDraft("A", next)).toBeNull());
  it.each(["", "AA", "أ", "Ａ", "А", "1", "P-"])("rejects non-ASCII-single-letter prefix %j", prefix => expect(numberingDraft(prefix, "1500")).toBeNull());
  it("maps every Arabic/Persian digit at the form boundary without rewriting other characters", () => {
    expect(normalizeNumberingFormDigits("٠١٢٣٤٥٦٧٨٩")).toBe("0123456789");
    expect(normalizeNumberingFormDigits("۰۱۲۳۴۵۶۷۸۹")).toBe("0123456789");
    expect(normalizeNumberingFormDigits("A-١٬٢٫۳ +٠")).toBe("A-1٬2٫3 +0");
    expect(numberingDraft("A", "١٥٠٠")).toBeNull();
  });
  it("does not enforce a global starting number, and preserves exact padding rule", () => {
    expect(numberingDraft("B", "1")?.preview).toBe("B-00001");
    expect(numberingDraft("Z", "123456")?.preview).toBe("Z-123456");
    expect(validNumberingSnapshot({ prefix: "A", next: "1", revision: "" })).toBe(false);
  });
  it("treats nonempty revision as an opaque token, not a numbering input", () => {
    expect(validNumberingSnapshot({ prefix: "A", next: "1", revision: "synthetic/+revision=2" })).toBe(true);
  });
  it("does not expose raw unknown errors", () => expect(numberingPreviewProblem("synthetic-private-error")).not.toContain("synthetic-private-error"));
});

describe("actual source-only Arabic panel", () => {
  it("is disconnected by default, RTL and uses native labeled controls with text-preserving inputs", () => {
    const tree = render();
    expect(element("section", tree).props.dir).toBe("rtl");
    expect(element("input", tree).props).toMatchObject({ type: "text", inputMode: "numeric", dir: "ltr", value: "1500" });
    expect(element("input", tree).props.maxLength).toBeUndefined();
    const options = nodes(tree).filter(n => n.type === "option").map(n => n.props.value);
    expect(options).toEqual(["", ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"]);
    for (const kind of ["input", "select"]) expect(nodes(tree).some(n => n.type === "label" && n.props.htmlFor === element(kind, tree).props.id)).toBe(true);
    expect(element("button", tree).props).toMatchObject({ type: "submit", disabled: true });
    expect(nodes(tree).filter(n => n.type === "button")).toHaveLength(1);
    expect(nodes(tree).find(n => n.props.role === "status")?.props).toMatchObject({ "aria-live": "polite", "aria-atomic": "true" });
    expect(text(tree)).toContain("لا يوجد زر حفظ هنا"); expect(text(tree)).toContain("لا تتغيّر أرقام الملفات الموجودة");
    expect(text(tree)).not.toContain("7000"); submit(tree);
  });
  it("initializes normalized single-letter display and separates current from proposed", () => {
    props.current.prefix = " p "; render(); expect(element("select").props.value).toBe("P");
    change("select", "A"); change("input", "999999999999999999");
    expect(nodes(render()).filter(n => n.type === "bdi").map(text)).toEqual(["P-01500", "A-999999999999999999"]);
    expect(props.current.next).toBe("1500");
  });
  it("passes exact strings and displayed revision only to the injected preview, never claims saved", async () => {
    const provider = vi.fn(async (input: NumberingPreviewInput) => accept(input)); props.onPreview = provider;
    change("select", "Z"); change("input", "999999999999999999"); submit(); await settle();
    expect(provider).toHaveBeenCalledExactlyOnceWith({ prefix: "Z", next: "999999999999999999", expectedRevision: "synthetic-r1" });
    expect(status()).toContain("اجتازت المعاينة"); expect(status()).toContain("لم يُحفظ شيء");
  });
  it.each(["١٥٠٠", "۱۵۰۰", "1٥۰0"])("normalizes form digits %s explicitly, keeping strict provider input", async value => {
    props.onPreview = vi.fn(async input => accept(input)); change("select", "A"); change("input", value);
    expect(element("input").props.value).toBe("1500"); expect(nodes(render()).filter(n => n.type === "bdi").map(text)).toEqual(["P-01500", "A-01500"]);
    submit(); await settle(); expect(props.onPreview).toHaveBeenCalledExactlyOnceWith({ prefix: "A", next: "1500", expectedRevision: "synthetic-r1" });
    expect(text(render())).toContain("تُحوّل الأرقام العربية والفارسية إلى 0–9");
  });
  it.each(["٩٩٩٩٩٩٩٩٩٩٩٩٩٩٩٩٩٩", "۹۹۹۹۹۹۹۹۹۹۹۹۹۹۹۹۹۹"])("normalizes large %s without precision loss", async value => {
    props.onPreview = vi.fn(async input => accept(input)); change("input", value); submit(); await settle();
    expect(element("input").props.value).toBe("999999999999999999");
    expect(props.onPreview).toHaveBeenCalledExactlyOnceWith({ prefix: "P", next: "999999999999999999", expectedRevision: "synthetic-r1" });
  });
  it.each(["٠١٥٠٠", "۰۰۱", "١٫٥", "۱٬۵۰۰", "１２"])("does not guess separators or strip zeros from %s", value => {
    props.onPreview = vi.fn(); change("input", value); submit(); expect(props.onPreview).not.toHaveBeenCalled();
  });
  it.each(["constructor", "toString", "__proto__"])("uses generic text for prototype-named refusal %s", async reason => {
    props.onPreview = vi.fn(async () => ({ ok: false as const, reason })); submit(); await settle();
    expect(status()).toBe("تعذّر التحقق من المعاينة. لا تعتمد هذه القيم قبل إعادة الفحص.");
  });
  it("blocks invalid input and invalid current snapshot even when submit callback is invoked", () => {
    props.onPreview = vi.fn(); change("input", "01500"); submit(); expect(props.onPreview).not.toHaveBeenCalled();
    expect(element("input").props["aria-invalid"]).toBe(true);
    change("input", "12"); props.current = { ...props.current, revision: "" }; submit(); expect(props.onPreview).not.toHaveBeenCalled();
  });
  it("blocks repeated submit synchronously before rerender", async () => {
    const d = deferred(); props.onPreview = d.provider; const tree = render(); submit(tree); submit(tree);
    expect(d.provider).toHaveBeenCalledOnce(); expect(element("button").props.disabled).toBe(true);
    d.resolve(); await settle(); expect(status()).toContain("اجتازت المعاينة");
  });
  it("discards an old reply after draft edits including A/B/A", async () => {
    const d = deferred(); props.onPreview = d.provider; submit(); change("input", "1600"); change("input", "1500");
    d.resolve(); await settle(); expect(status()).toContain("تغيّرت القيم"); expect(status()).not.toContain("اجتازت");
  });
  it.each(["revision", "provider"])("invalidates old reply and checked state across %s A/B/A", async kind => {
    const d = deferred(); props.onPreview = d.provider; submit();
    if (kind === "revision") props.current = { ...props.current, revision: "synthetic-r2" }; else props.onPreview = vi.fn(async input => accept(input));
    render();
    if (kind === "revision") props.current = { ...props.current, revision: "synthetic-r1" }; else props.onPreview = d.provider;
    render(); d.resolve(); await settle(); expect(status()).not.toContain("اجتازت");
    props.onPreview = vi.fn(async input => accept(input)); submit(); await settle(); expect(status()).toContain("اجتازت");
    const prior = props.onPreview;
    if (kind === "revision") props.current = { ...props.current, revision: "synthetic-r2" }; else props.onPreview = vi.fn(async input => accept(input));
    render();
    if (kind === "revision") props.current = { ...props.current, revision: "synthetic-r1" }; else props.onPreview = prior;
    render(); expect(status()).not.toContain("اجتازت");
  });
  it("ignores old completion while a newer request remains pending", async () => {
    const first = deferred(), second = deferred(); props.onPreview = first.provider; submit();
    change("input", "1600"); props.onPreview = second.provider; submit();
    first.resolve(); await settle(); expect(status()).toContain("جارٍ");
    second.resolve(); await settle(); expect(status()).toContain("اجتازت");
  });
  it("ignores completion after unmount", async () => {
    const d = deferred(); props.onPreview = d.provider; submit(); render();
    hooks.effects.forEach(e => e.cleanup?.()); const before = [...hooks.values]; d.resolve();
    for (let i = 0; i < 8; i++) await Promise.resolve(); expect(hooks.values).toEqual(before);
  });
  it.each(["prefix", "next", "preview", "expectedRevision"])("fails closed on mismatched %s", async field => {
    props.onPreview = vi.fn(async input => ({ ...accept(input), [field]: "synthetic-other" }));
    submit(); await settle(); expect(status()).toContain("تغيّرت القيم"); expect(status()).not.toContain("اجتازت");
  });
  it.each([null, {}, { ok: "true" }, { ok: true }, { ok: false, reason: "synthetic-private-error" }])("fails closed for malformed/unknown response %j", async result => {
    props.onPreview = vi.fn(async () => result as NumberingPreviewResult); submit(); await settle();
    expect(status()).not.toContain("اجتازت"); expect(status()).not.toContain("synthetic-private-error"); expect(status().length).toBeGreaterThan(0);
  });
  it("catches provider rejection without echo and permits explicit retry", async () => {
    props.onPreview = vi.fn().mockRejectedValueOnce(new Error("synthetic-private-error")).mockImplementationOnce(async input => accept(input));
    submit(); await settle(); expect(status()).not.toContain("synthetic-private-error"); expect(element("button").props.disabled).toBe(false);
    submit(); await settle(); expect(status()).toContain("اجتازت");
  });
  it("has no transport, persistence, runtime setting, server or database import", () => {
    for (const file of ["components/settings/PatientNumberingPreviewPanel.tsx", "components/settings/patient-numbering-preview-model.ts"]) {
      const source = readFileSync(file, "utf8");
      expect(source).not.toMatch(/\b(?:fetch|XMLHttpRequest|localStorage|sessionStorage)\b|["']\/api\/|from ["'](?:.*\/db|next\/|server-only)/);
    }
  });
});
