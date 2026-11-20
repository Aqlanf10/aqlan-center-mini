import type { ReactElement, ReactNode } from "react";
import { expect, it, vi, afterEach } from "vitest";
import { PatientNumberingSettingsHost } from "../components/settings/PatientNumberingSettingsHost";
import { PatientNumberingSaveCandidate } from "../components/settings/PatientNumberingSaveCandidate";
import { readPendingNumberingReceipt, rememberNumberingReceipt } from "../components/settings/patient-numbering-receipt-journal";
import type { NumberingSaveOperations, NumberingSaveTicket } from "../components/settings/patient-numbering-save-model";
import type { NumberingSettingsTransport, SettingsNumberingRead } from "../lib/patient-numbering-settings-contract";

const h = vi.hoisted(() => ({ cursor: 0, slots: [] as unknown[], pending: [] as (() => void)[] }));
vi.mock("react", async original => {
  const react = await original<typeof import("react")>();
  function slot(initial: unknown) {
    const next = h.cursor++;
    if (!(next in h.slots)) h.slots[next] = initial;
    return next;
  }
  function memo(fn: () => unknown, deps: unknown[]) {
    const index = slot(null);
    const prev = h.slots[index] as { deps: unknown[]; value: unknown } | null;
    if (prev && deps.every((value, i) => value === prev.deps[i])) return prev.value;
    const value = fn(); h.slots[index] = { deps, value }; return value;
  }
  return { ...react,
    useState(initial: unknown) { const index = slot(initial); return [h.slots[index], (value: unknown) => { h.slots[index] = value; }]; },
    useRef(initial: unknown) { return h.slots[slot({ current: initial })]; },
    useMemo: memo,
    useCallback(fn: unknown, deps: unknown[]) { return memo(() => fn, deps); },
    useLayoutEffect(fn: () => void | (() => void), deps: unknown[]) {
      const index = slot(null);
      const prev = h.slots[index] as { deps: unknown[]; cleanup?: void | (() => void) } | null;
      if (prev && deps.every((value, i) => value === prev.deps[i])) return;
      h.pending.push(() => { prev?.cleanup?.(); h.slots[index] = { deps, cleanup: fn() }; });
    },
  };
});
type Tree = ReactElement<Record<string, unknown>>;
function nodes(node: ReactNode): Tree[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const entry = node as Tree;
  return [entry, ...nodes(entry.props.children as ReactNode)];
}
function text(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(text).join("");
  if (typeof node === "string") return node;
  return node && typeof node === "object" && "props" in node ? text((node as Tree).props.children as ReactNode) : "";
}
function render(transport?: NumberingSettingsTransport) {
  h.cursor = 0; const tree = PatientNumberingSettingsHost({ transport });
  h.pending.splice(0).forEach(effect => effect());
  return tree;
}
const ticketId = "synthetic_receipt_request_01";
const current = { prefix: "A", next: "1501", revision: "2:A:A:1500:1:0:1" };
const saved = { prefix: "A", next: "1500", preview: "A-01500", revision: "2:A:A:1500:0:0:1" };
const verified: SettingsNumberingRead = { ok: true, current, readId: "synthetic-new-read-id-001", receipt: { requestId: ticketId, value: saved } };
const settle = async () => { for (let step = 0; step < 6; step++) await Promise.resolve(); };
function fixture(result: SettingsNumberingRead) {
  const values = new Map<string, string>();
  const storage = { getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string,v: string) => { values.set(k,v); }, removeItem: (k: string) => { values.delete(k); } };
  vi.stubGlobal("window", { sessionStorage: storage });
  const transport = {
    read: vi.fn(async (_id: string | null) => result),
    preview: vi.fn(async () => ({ ok: false as const, reason: "synthetic-only" })),
    save: vi.fn(async () => ({ ok: false as const, reason: "synthetic-only" })),
  };
  return { transport, storage, values };
}
afterEach(() => { h.cursor = 0; h.slots = []; h.pending = []; vi.unstubAllGlobals(); });
it("has no mounted settings save form when no authenticated transport was installed", () => {
  expect(text(render())).toContain("غير مفعّل");
  expect(nodes(render()).some(n => n.type === PatientNumberingSaveCandidate)).toBe(false);
});
it("reconciles an exact saved request on reload; displays historical result and distinct current state", async () => {
  const { transport, storage } = fixture(verified);
  rememberNumberingReceipt(storage, ticketId);
  render(transport); await settle();
  const tree = render(transport);
  expect(transport.read).toHaveBeenCalledExactlyOnceWith(ticketId);
  expect(transport.save).not.toHaveBeenCalled();
  expect(text(tree)).toContain("A-01500");
  expect(text(tree)).toContain("ليست الرقم التالي الآن");
  const component = nodes(tree).find(n => n.type === PatientNumberingSaveCandidate);
  expect(component?.props.current).toEqual(current);
  expect(readPendingNumberingReceipt(storage)).toEqual({ ok: true, requestId: null });
});
it.each([
  { ok: false, reason: "receipt-unresolved" } as const,
  { ...verified, receipt: { requestId: "synthetic_other_request_01", value: saved } },
])("holds without the exact persisted request and never clears it or mounts save", async result => {
  const { transport, storage, values } = fixture(result);
  rememberNumberingReceipt(storage, ticketId);
  render(transport); await settle();
  const tree = render(transport);
  expect(text(tree)).toContain("الحفظ متوقف");
  expect(nodes(tree).some(n => n.type === PatientNumberingSaveCandidate)).toBe(false);
  expect(transport.save).not.toHaveBeenCalled();
  expect([...values.values()]).toEqual([ticketId]);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const componentIn = (tree: ReactNode) => nodes(tree).find(n => n.type === PatientNumberingSaveCandidate);
const otherId = "synthetic_new_intent_request";
const exactTicket: NumberingSaveTicket = {
  ...saved, expectedRevision: current.revision, requestId: ticketId,
  reason: "fixture", previewToken: "synthetic_only_index",
};
it("renders exact historical receipt together with explicit exhaustion, and never creates an invented next number", async () => {
  const exhausted = { ...current, next: null, revision: "2:A:A:999999999999999999:1:0:1" };
  const { transport, storage } = fixture({ ...verified, current: exhausted });
  rememberNumberingReceipt(storage, ticketId);
  render(transport); await settle();
  const tree = render(transport);
  expect(text(tree)).toContain("A-01500");
  expect(componentIn(tree)?.props.current).toEqual(exhausted);
  expect(readPendingNumberingReceipt(storage)).toEqual({ ok: true, requestId: null });
});
it("ignores an older same-host lookup even if its expected ID is still present", async () => {
  const { transport, storage } = fixture(verified);
  const older = deferred<SettingsNumberingRead>(), newer = deferred<SettingsNumberingRead>();
  render(transport); await settle(); // No pending identifier: fixture returns an unexpected receipt, so hold.
  rememberNumberingReceipt(storage, ticketId);
  transport.read.mockImplementationOnce(() => older.promise).mockImplementationOnce(() => newer.promise);
  const held = render(transport), review = nodes(held).find(n => n.type === "button")?.props.onClick as () => void;
  review(); review();
  older.resolve(verified); await settle();
  expect(readPendingNumberingReceipt(storage)).toEqual({ ok: true, requestId: ticketId });
  newer.resolve({ ok: false, reason: "receipt-unresolved" }); await settle();
  expect(componentIn(render(transport))).toBeUndefined();
  expect(readPendingNumberingReceipt(storage)).toEqual({ ok: true, requestId: ticketId });
});
it("does not clear or replace a newer transport and journal when an old lookup completes", async () => {
  const old = fixture(verified);
  const earlier = deferred<SettingsNumberingRead>(), replacement = deferred<SettingsNumberingRead>();
  const next: NumberingSettingsTransport = { ...old.transport, read: vi.fn(() => replacement.promise) };
  rememberNumberingReceipt(old.storage, ticketId);
  old.transport.read.mockImplementationOnce(() => earlier.promise);
  render(old.transport); await settle();
  // Same attempted request cannot be cleared by a prior transport generation,
  // even before the replacement lookup finishes.
  render(next); await settle();
  earlier.resolve(verified); await settle();
  expect(readPendingNumberingReceipt(old.storage)).toEqual({ ok: true, requestId: ticketId });
  expect(componentIn(render(next))).toBeUndefined();
  replacement.resolve({ ok: false, reason: "receipt-unresolved" }); await settle();
  expect(text(render(next))).toContain("الحفظ متوقف");
});
it("holds on a different exact journal id and does not clear a late prior lookup", async () => {
  const { transport, storage, values } = fixture(verified);
  const late = deferred<SettingsNumberingRead>();
  rememberNumberingReceipt(storage, ticketId);
  transport.read.mockImplementationOnce(() => late.promise);
  render(transport); await settle();
  storage.setItem([...values.keys()][0], otherId);
  late.resolve(verified); await settle();
  expect(text(render(transport))).toContain("الحفظ متوقف");
  expect(readPendingNumberingReceipt(storage)).toEqual({ ok: true, requestId: otherId });
});
it("does not clear after supersession by a read even when a delayed first save returns a definite denial", async () => {
  const { transport, storage } = fixture({ ...verified, receipt: null });
  const attempted = deferred<Awaited<ReturnType<NumberingSaveOperations["save"]>>>();
  const widened: NumberingSettingsTransport = {
    ...transport, save: vi.fn(() => attempted.promise),
  };
  render(widened); await settle();
  const active = componentIn(render(widened))!;
  const operations = active.props.operations as NumberingSaveOperations;
  const save = operations.save(exactTicket);
  (active.props.onRequestReconciliation as () => void)();
  attempted.resolve({ ok: false, reason: "owner-required" });
  expect(await save).toEqual({ ok: false, reason: "owner-required" });
  await settle();
  expect(readPendingNumberingReceipt(storage)).toEqual({ ok: true, requestId: ticketId });
  expect(text(render(widened))).toContain("الحفظ متوقف");
  expect(await operations.save(exactTicket)).toEqual({ ok: false, reason: "idempotency-conflict" });
  expect(widened.save).toHaveBeenCalledTimes(1);
});
