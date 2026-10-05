import type { ComponentProps, ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LegacyReconciliationPreview } from "../components/LegacyReconciliationPreview";
import { PatientLedger } from "../components/PatientLedger";
import { LegacyBalanceArrangementPanel } from "../components/LegacyBalanceArrangementPanel";
import type { SessionInfo } from "../components/SessionProvider";
import { formatMoney } from "../lib/money";
import { previewTextLineHasOwnedHits, type PreviewTextLineEvidence } from "./fixtures/preview-label-text-boundary";

// Actual components with the repository's existing bounded hook/key driver.
// Leaf editors never execute. These tests do not open a browser or a database.
const hooks = vi.hoisted(() => ({
  values: [] as unknown[], cursor: 0, changed: false, key: null as string | null,
  effects: new Map<number, { deps?: readonly unknown[]; cleanup?: () => void }>(),
  memos: new Map<number, { deps?: readonly unknown[]; value: unknown }>(), pending: [] as Array<() => void>,
  session: { username: "synthetic-admin-a", role: "admin" } as SessionInfo | null,
}));
vi.mock("../components/SessionProvider", () => ({ useSession: () => hooks.session }));
vi.mock("../components/ServiceSelect", () => ({ ServiceSelect: () => null }));
vi.mock("../components/CollectPaymentModal", () => ({ CollectPaymentModal: () => null }));
vi.mock("../components/InvoiceCorrection", () => ({ InvoiceCorrection: () => null }));
vi.mock("../components/ReceiptCorrection", () => ({ ReceiptCorrection: () => null }));
vi.mock("../components/LegacyBalanceArrangementPanel", () => ({ LegacyBalanceArrangementPanel: () => null }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const slot = (initial: unknown) => { const i = hooks.cursor++; if (!(i in hooks.values)) hooks.values[i] = initial; return i; };
  const same = (a?: readonly unknown[], b?: readonly unknown[]) => !!a && !!b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const memo = (factory: () => unknown, deps?: readonly unknown[]) => {
    const i = slot(undefined); const old = hooks.memos.get(i);
    if (old && same(old.deps, deps)) return old.value;
    const value = factory(); hooks.memos.set(i, { deps, value }); return value;
  };
  return { ...react,
    useState: (initial: unknown) => {
      const i = slot(typeof initial === "function" ? initial() : initial); const values = hooks.values;
      return [values[i], (update: unknown) => {
        const value = typeof update === "function" ? update(values[i]) : update;
        if (values === hooks.values && !Object.is(value, values[i])) hooks.changed = true;
        values[i] = value;
      }];
    },
    useRef: (initial: unknown) => hooks.values[slot({ current: initial })],
    useMemo: memo, useCallback: (callback: unknown, deps?: readonly unknown[]) => memo(() => callback, deps),
    useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
      const i = slot(undefined); const old = hooks.effects.get(i);
      if (old && same(old.deps, deps)) return;
      hooks.pending.push(() => { old?.cleanup?.(); const cleanup = effect(); hooks.effects.set(i, { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined }); });
    },
  };
});

type Element = ReactElement<Record<string, unknown>>;
type Props = ComponentProps<typeof LegacyReconciliationPreview>;
const position = { currency: "SAR" as const, openingMinor: 35_000, settledMinor: 5_000, remainingMinor: 30_000 };
const receipt = { id: 31, receiptNumber: "SYNTH-31", invoiceId: null, planId: null, openingCurrency: "SAR" as const,
  kind: "payment" as const, amountMinor: 5_000, currency: "SAR" as const, baseAmountMinor: 700_000,
  exchangeRate: 140, method: "cash", note: null, createdAt: "2026-10-05T09:00:00.000Z" };
const props = (changes: Partial<Props> = {}): Props => ({ patientId: 11, ready: true, positions: [position], payments: [receipt], ...changes });
const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
const storage = { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() };
let readLedger: () => Promise<Response>;
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function retire() {
  for (const effect of hooks.effects.values()) effect.cleanup?.();
  hooks.values = []; hooks.effects.clear(); hooks.memos.clear(); hooks.pending = []; hooks.changed = false;
}
function keyed(scope: ReactElement | null, prefix: string): ReactNode {
  const key = scope ? `${prefix}:${scope.key}` : null;
  if (key !== hooks.key) { retire(); hooks.key = key; }
  if (!scope) return null;
  let tree: ReactNode = null; let count = 0;
  do {
    if (++count > 12) throw new Error("Synthetic render did not settle");
    hooks.cursor = 0; hooks.changed = false;
    tree = (scope.type as (properties: unknown) => ReactNode)(scope.props);
    hooks.pending.splice(0).forEach((effect) => effect());
  } while (hooks.changed);
  return tree;
}
const render = (value: Props = props()) => keyed(LegacyReconciliationPreview(value), "preview");
function renderLedger(patientId = 11): ReactNode {
  const scope = PatientLedger({ patientId });
  if (typeof scope.type !== "function") { keyed(null, "ledger"); return scope; }
  return keyed(scope, "ledger");
}
function nodes(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as Element; return [element, ...nodes(element.props.children as ReactNode)];
}
function text(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  return node && typeof node === "object" && "props" in node ? text((node as Element).props.children as ReactNode) : "";
}
function button(tree: ReactNode) { const matches = nodes(tree).filter((node) => node.type === "button"); expect(matches).toHaveLength(1); return matches[0]; }
function control(tree: ReactNode, label: string) {
  const labels = nodes(tree).filter((node) => node.type === "label" && text(node).startsWith(label));
  expect(labels).toHaveLength(1);
  const fields = nodes(labels[0]).filter((node) => node.type === "input" || node.type === "select");
  expect(fields).toHaveLength(1); return fields[0];
}
function change(field: Element, value: string) { (field.props.onChange as (event: { target: { value: string } }) => void)({ target: { value } }); }
function expand(value: Props = props()) { (button(render(value)).props.onClick as () => void)(); return render(value); }
function fill(value: Props = props()) {
  expand(value); change(control(render(value), "عملة الاتفاق التاريخي"), "SAR");
  change(control(render(value), "البيانات التاريخية حتى"), "2026-09-01");
  change(control(render(value), "كامل المبلغ المتفق عليه"), "600");
  change(control(render(value), "المدفوع حتى التاريخ المحدد"), "250");
  return render(value);
}
function dd(tree: ReactNode, label: string) {
  const pair = nodes(tree).find((node) => node.type === "div" && nodes(node).some((child) => child.type === "dt" && text(child) === label)
    && nodes(node).filter((child) => child.type === "dt").length === 1);
  expect(pair).toBeDefined(); return text(nodes(pair).find((node) => node.type === "dd"));
}
async function settle() { for (let i = 0; i < 40; i++) await Promise.resolve(); }
const empty = { billedMinor: 0, collectedMinor: 0, openingMinor: 0, dueMinor: 0 };
const ledger = () => ({ invoices: [], payments: [receipt], opening: null,
  openings: [{ patientId: 11, amountMinor: 35_000, currency: "SAR", asOfDate: "2026-09-01", note: null }],
  openingAccess: { add: false, edit: false }, balance: empty, baseCurrency: "YER", plans: [],
  balances: { YER: empty, SAR: { billedMinor: 0, collectedMinor: 5_000, openingMinor: 35_000, dueMinor: 30_000 }, USD: empty },
  legacyOpeningPositions: [position], legacyBalanceArrangements: [], legacyArrangementAccess: { manage: false } });
const previewNodes = (tree: ReactNode) => nodes(tree).filter((node) => node.type === LegacyReconciliationPreview);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-05T09:00:00Z"));
  retire(); hooks.key = null; hooks.cursor = 0;
  hooks.session = { username: "synthetic-admin-a", role: "admin" };
  fetchMock.mockReset(); Object.values(storage).forEach((spy) => spy.mockReset());
  readLedger = async () => response(ledger());
  fetchMock.mockImplementation((url, init) => {
    if (init?.method && init.method !== "GET") throw new Error("Unexpected write");
    if (url === "/api/services") return Promise.resolve(response([]));
    if (/^\/api\/patients\/\d+\/ledger$/.test(url)) return readLedger();
    throw new Error(`Unexpected read: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock); vi.stubGlobal("localStorage", storage); vi.stubGlobal("sessionStorage", storage);
});
afterEach(() => {
  retire();
  expect(storage.getItem).not.toHaveBeenCalled(); expect(storage.setItem).not.toHaveBeenCalled(); expect(storage.removeItem).not.toHaveBeenCalled();
  expect(fetchMock.mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
  vi.unstubAllGlobals(); vi.useRealTimers();
});

describe("unsaved historical comparison", () => {
  it("starts collapsed, then shows four fields without a form, link or financial action", () => {
    expect(nodes(render()).filter((node) => node.type === "input" || node.type === "select")).toHaveLength(0);
    const tree = expand();
    expect(nodes(tree).filter((node) => node.type === "input" || node.type === "select")).toHaveLength(4);
    expect(nodes(tree).some((node) => node.type === "form" || node.type === "a")).toBe(false);
    expect(text(button(tree))).toBe("إغلاق المعاينة ومسح مدخلاتها");
    expect(text(tree)).not.toMatch(/سجّل شدّة|الأسلاك|احفظ|تصحيح السند|عكس السند/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("keeps historical350, recorded principal350 and current300 separate without subtracting the receipt twice", () => {
    const input = props(); const before = structuredClone(input); const tree = fill(input);
    expect(dd(tree, "المتبقي التاريخي المحسوب")).toBe(formatMoney(35_000, "SAR"));
    expect(dd(tree, "أصل الرصيد السابق المسجل")).toBe(formatMoney(35_000, "SAR"));
    expect(dd(tree, "صافي السداد المرتبط المسجل")).toBe(formatMoney(5_000, "SAR"));
    expect(dd(tree, "المتبقي الحالي حسب الحساب")).toBe(formatMoney(30_000, "SAR"));
    expect(text(tree)).toContain("تساوي الأرقام لا يثبت ارتباطه بهذا الاتفاق");
    expect(text(tree)).toContain("الأرشيف وسجل تعديل الرصيد غير محمّلين");
    expect(input).toEqual(before); expect(fetchMock).not.toHaveBeenCalled();
  });
  it("rejects a future historical date and accepts the current clinic day without changing amounts", () => {
    fill(); change(control(render(), "البيانات التاريخية حتى"), "2026-10-06");
    const future = render(); expect(text(future)).toContain("تاريخًا مستقبليًا");
    expect(nodes(future).some((node) => node.type === "dl")).toBe(false);
    expect(control(future, "كامل المبلغ المتفق عليه").props.value).toBe("600");
    expect(control(future, "المدفوع حتى التاريخ المحدد").props.value).toBe("250");
    change(control(future, "البيانات التاريخية حتى"), "2026-10-05"); const current = render();
    expect(dd(current, "المتبقي التاريخي المحسوب")).toBe(formatMoney(35_000, "SAR"));
    expect(dd(current, "المتبقي الحالي حسب الحساب")).toBe(formatMoney(30_000, "SAR"));
    expect(text(current)).toContain("الأرشيف وسجل تعديل الرصيد غير محمّلين");
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("does not assign a same-currency aggregate opening from multiple agreements to the draft", () => {
    const tree = fill(props({ positions: [{ ...position, openingMinor: 90_000, remainingMinor: 85_000 }] }));
    expect(dd(tree, "المتبقي التاريخي المحسوب")).toBe(formatMoney(35_000, "SAR"));
    expect(dd(tree, "أصل الرصيد السابق المسجل")).toBe(formatMoney(90_000, "SAR"));
    expect(text(tree)).toContain("قد يجمع الرصيد أكثر من اتفاق");
    expect(nodes(tree).some((node) => node.type === "a")).toBe(false);
  });
  it("distinguishes missing positions/payments from an explicitly empty same-currency read", () => {
    const missing = fill(props({ positions: undefined, payments: undefined }));
    expect(text(missing)).toContain("تفصيل الرصيد السابق غير متاح");
    expect(text(missing)).toContain("تعذّر التحقق من قائمة السندات");
    const knownEmpty = render(props({ positions: [], payments: [] }));
    expect(text(knownEmpty)).toContain("لا يوجد رصيد سابق بهذه العملة في القراءة الحالية");
    expect(text(knownEmpty)).toContain("لا توجد سندات بهذه الشروط في القراءة الحالية");
    expect(text(knownEmpty)).toContain("الأرشيف وسجل تعديل الرصيد غير محمّلين");
  });
  it("lists only recorded opening targets and never labels stored dates as actual cash timing", () => {
    const tree = fill(props({ payments: [receipt,
      { ...receipt, id: 32, receiptNumber: "UNALLOCATED", openingCurrency: null },
      { ...receipt, id: 33, receiptNumber: "OTHER-CURRENCY", currency: "USD", openingCurrency: "USD" },
    ] }));
    expect(text(tree)).toContain("SYNTH-31"); expect(text(tree)).not.toContain("UNALLOCATED"); expect(text(tree)).not.toContain("OTHER-CURRENCY");
    expect(text(tree)).toContain("ولا يثبت وقت قبض المال فعليًا"); expect(fetchMock).not.toHaveBeenCalled();
  });
  it("clears the local draft on close and never persists it", () => {
    const tree = fill(); (button(tree).props.onClick as () => void)();
    const blank = expand(); expect(control(blank, "كامل المبلغ المتفق عليه").props.value).toBe("");
    expect(control(blank, "المدفوع حتى التاريخ المحدد").props.value).toBe(""); expect(control(blank, "البيانات التاريخية حتى").props.value).toBe("");
    expect(control(blank, "عملة الاتفاق التاريخي").props.value).toBe("");
  });
  it("clears amounts on currency change rather than relabeling or converting them", () => {
    fill(); change(control(render(), "عملة الاتفاق التاريخي"), "USD"); const tree = render();
    expect(control(tree, "كامل المبلغ المتفق عليه").props.value).toBe("");
    expect(control(tree, "المدفوع حتى التاريخ المحدد").props.value).toBe("");
    expect(nodes(tree).some((node) => node.type === "dl")).toBe(false);
  });
  it("starts blank after patient A→B→A and rejects old-owner input callbacks", () => {
    const oldField = control(fill(), "كامل المبلغ المتفق عليه");
    expect(nodes(render(props({ patientId: 12 }))).filter((node) => node.type === "input")).toHaveLength(0);
    render(); const blank = expand(); change(oldField, "999");
    expect(control(render(), "كامل المبلغ المتفق عليه").props.value).toBe("");
    expect(control(blank, "المدفوع حتى التاريخ المحدد").props.value).toBe("");
  });
  it.each([
    { username: "synthetic-admin-b", role: "admin" },
    { username: "synthetic-admin-a", role: "reception" },
    { username: "synthetic-admin-a", role: "admin", permissions: { canViewPatientPayments: false } },
  ] as SessionInfo[])("starts blank after authority changes to %j", (session) => {
    fill(); hooks.session = session;
    expect(nodes(render()).filter((node) => node.type === "input")).toHaveLength(0);
    expect(control(expand(), "كامل المبلغ المتفق عليه").props.value).toBe("");
  });
  it("removes financial content on missing session and does not revive the draft after return", () => {
    fill(); hooks.session = null; expect(render()).toBeNull();
    hooks.session = { username: "synthetic-admin-a", role: "admin" };
    expect(control(expand(), "كامل المبلغ المتفق عليه").props.value).toBe("");
  });
  it("withdraws the draft when the parent read is unavailable and starts blank after reread", () => {
    fill(); expect(render(props({ ready: false }))).toBeNull();
    expect(control(expand(), "كامل المبلغ المتفق عليه").props.value).toBe("");
  });
});

describe("existing Account read-grant insertion", () => {
  it("mounts only after a validated ledger read and passes the same authorized evidence", async () => {
    expect(previewNodes(renderLedger())).toHaveLength(0); await settle();
    const child = previewNodes(renderLedger()); expect(child).toHaveLength(1);
    expect(child[0].props).toMatchObject({ patientId: 11, ready: true, positions: [position], payments: [receipt] });
    expect(fetchMock.mock.calls.map(([url]) => url).sort()).toEqual(["/api/patients/11/ledger", "/api/services"]);
  });
  it.each([403, 503])("withdraws the preview during refresh and keeps it absent after HTTP%i", async (status) => {
    renderLedger(); await settle(); expect(previewNodes(renderLedger())).toHaveLength(1);
    let release!: (response: Response) => void;
    readLedger = () => new Promise<Response>((resolve) => { release = resolve; });
    const arrangement = nodes(renderLedger()).find((node) => node.type === LegacyBalanceArrangementPanel)!;
    (arrangement.props.onChanged as () => void)();
    expect(previewNodes(renderLedger())).toHaveLength(0);
    release(response({}, status)); await settle(); expect(previewNodes(renderLedger())).toHaveLength(0);
    expect(fetchMock.mock.calls.every(([url]) => url === "/api/services" || url === "/api/patients/11/ledger")).toBe(true);
  });
  it("does not expose the preview from malformed ledger evidence", async () => {
    readLedger = async () => response({ ...ledger(), legacyOpeningPositions: [{ currency: "SAR" }] });
    renderLedger(); await settle(); expect(previewNodes(renderLedger())).toHaveLength(0);
  });
});

describe("narrow native label/control text boundary evidence", () => {
  function boundary(): PreviewTextLineEvidence {
    return {
      kind: "field-label-0", bounds: { left: 268, right: 365, top: 282.5, bottom: 300.5 },
      associatedControl: { nativeLabel: true, nativeControl: true, tag: "select",
        bounds: { left: 25, right: 365, top: 299.5, bottom: 343.5 } },
      hits: [
        { point: "centre", x: 316.5, y: 291.5, owned: true, hitTag: "label", hitsNativeLabelControl: false },
        { point: "top", x: 316.5, y: 283.5, owned: true, hitTag: "label", hitsNativeLabelControl: false },
        { point: "bottom", x: 316.5, y: 299.5, owned: false, hitTag: "select", hitsNativeLabelControl: true },
        { point: "left", x: 269, y: 291.5, owned: true, hitTag: "label", hitsNativeLabelControl: false },
        { point: "right", x: 364, y: 291.5, owned: true, hitTag: "label", hitsNativeLabelControl: false },
      ],
    };
  }

  it("keeps fully owned paragraph and field-label lines strict without requiring a control", () => {
    for (const kind of ["introduction", "receipt-timing-disclaimer", "field-label-0"]) {
      const evidence = boundary(); evidence.kind = kind; evidence.associatedControl = null;
      evidence.hits = evidence.hits.map(hit => ({ ...hit, owned: true, hitTag: "p", hitsNativeLabelControl: false }));
      expect(previewTextLineHasOwnedHits(evidence)).toBe(true);
    }
  });

  it("permits only the measured trailing border for native inputs/selects without changing raw evidence", () => {
    for (const tag of ["input", "select"]) {
      for (const overlap of [0.25, 0.5, 1]) {
        const evidence = boundary(); evidence.bounds.bottom = 299.5 + overlap;
        evidence.associatedControl!.tag = tag;
        evidence.hits = evidence.hits.map(hit => hit.point === "bottom" ? { ...hit, hitTag: tag } : hit);
        const before = JSON.stringify(evidence);
        expect(previewTextLineHasOwnedHits(evidence)).toBe(true);
        expect(JSON.stringify(evidence)).toBe(before);
        expect(evidence.hits.find(hit => hit.point === "bottom")!.owned).toBe(false);
      }
    }
  });

  it("rejects deeper, zero and negative overlap without rounding or tolerance inflation", () => {
    for (const overlap of [1.000001, 2, 18, 0, -0.25]) {
      const evidence = boundary(); evidence.bounds.bottom = 299.5 + overlap;
      expect(previewTextLineHasOwnedHits(evidence)).toBe(false);
    }
    const notTrailing = boundary(); notTrailing.bounds.top = 299.5;
    notTrailing.hits = notTrailing.hits.map(hit => ({ ...hit, y: 299.5 }));
    expect(previewTextLineHasOwnedHits(notTrailing)).toBe(false);
  });

  it("rejects malformed/nonfinite rectangles and sample coordinates", () => {
    for (const invalid of [NaN, Infinity, -Infinity, "299.5", null, undefined]) {
      const control = boundary(); control.associatedControl!.bounds.top = invalid as number;
      expect(previewTextLineHasOwnedHits(control)).toBe(false);
      const line = boundary(); line.bounds.bottom = invalid as number;
      expect(previewTextLineHasOwnedHits(line)).toBe(false);
      const point = boundary(); point.hits = point.hits.map(hit => hit.point === "bottom" ? { ...hit, y: invalid as number } : hit);
      expect(previewTextLineHasOwnedHits(point)).toBe(false);
    }
    const flat = boundary(); flat.associatedControl!.bounds.right = flat.associatedControl!.bounds.left;
    expect(previewTextLineHasOwnedHits(flat)).toBe(false);
  });

  it("rejects a foreign control, descendant or chrome hit even at the same border", () => {
    for (const hitTag of ["select", "input", "span", "div", "nav"]) {
      const evidence = boundary();
      evidence.hits = evidence.hits.map(hit => hit.point === "bottom"
        ? { ...hit, hitTag, hitsNativeLabelControl: false } : hit);
      expect(previewTextLineHasOwnedHits(evidence)).toBe(false);
    }
    const contradictory = boundary();
    contradictory.hits = contradictory.hits.map(hit => hit.point === "bottom" ? { ...hit, hitTag: "nav" } : hit);
    expect(previewTextLineHasOwnedHits(contradictory)).toBe(false);
  });

  it("does not permit an unowned centre, top, left or right sample", () => {
    for (const point of ["centre", "top", "left", "right"]) {
      const evidence = boundary();
      evidence.hits = evidence.hits.map(hit => ({ ...hit, owned: hit.point !== point,
        hitTag: hit.point === point ? "select" : "label", hitsNativeLabelControl: hit.point === point }));
      expect(previewTextLineHasOwnedHits(evidence)).toBe(false);
    }
  });

  it("does not permit paragraph/chrome targets or an unknown field-label index", () => {
    for (const kind of ["introduction", "receipt-timing-disclaimer", "paragraph", "header", "bottomNavigation",
      "field-label", "field-label-4", "field-label-0-suffix"]) {
      const evidence = boundary(); evidence.kind = kind;
      expect(previewTextLineHasOwnedHits(evidence)).toBe(false);
    }
  });

  it("requires all other four label samples to remain owned", () => {
    const evidence = boundary();
    evidence.hits = evidence.hits.map(hit => hit.point === "left" ? { ...hit, owned: false } : hit);
    expect(previewTextLineHasOwnedHits(evidence)).toBe(false);
  });

  it("rejects missing, duplicate or unknown samples instead of weakening the five-hit gate", () => {
    const missing = boundary(); missing.hits = missing.hits.slice(0, 4);
    expect(previewTextLineHasOwnedHits(missing)).toBe(false);
    const duplicate = boundary(); duplicate.hits = duplicate.hits.map(hit => hit.point === "right" ? { ...hit, point: "left" } : hit);
    expect(previewTextLineHasOwnedHits(duplicate)).toBe(false);
    const unknown = boundary(); unknown.hits = unknown.hits.map(hit => hit.point === "right" ? { ...hit, point: "corner" } : hit);
    expect(previewTextLineHasOwnedHits(unknown)).toBe(false);
  });

  it("requires a native associated control and an exact top-border coordinate", () => {
    const absent = boundary(); absent.associatedControl = null;
    expect(previewTextLineHasOwnedHits(absent)).toBe(false);
    for (const patch of [{ nativeLabel: false }, { nativeControl: false }, { tag: "div" }, { tag: "button" }]) {
      const evidence = boundary(); Object.assign(evidence.associatedControl!, patch);
      expect(previewTextLineHasOwnedHits(evidence)).toBe(false);
    }
    for (const y of [299.499999, 299.500001]) {
      const evidence = boundary(); evidence.hits = evidence.hits.map(hit => hit.point === "bottom" ? { ...hit, y } : hit);
      expect(previewTextLineHasOwnedHits(evidence)).toBe(false);
    }
  });
});
