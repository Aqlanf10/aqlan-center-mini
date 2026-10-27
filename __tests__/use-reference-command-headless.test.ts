import { beforeEach, afterEach, expect, it, vi } from "vitest";
import type {
  ReferenceAuthority,
  ReferenceIntent,
} from "../lib/inventory-reference-protocol";
// Controlled React lifecycle/storage adapters. This is hook contract evidence,
// not real browser/IDB or canonical-authority operational acceptance.
const mock = vi.hoisted(() => ({
  slots: [] as any[],
  cursor: 0,
  journal: { revision: 0, intent: null as ReferenceIntent | null },
  read: vi.fn(),
  reserve: vi.fn(),
  ack: vi.fn(),
  fetch: vi.fn(),
}));
vi.mock("react", () => ({
  useRef: (value: unknown) => {
    const n = mock.cursor++;
    return mock.slots[n] ?? (mock.slots[n] = { current: value });
  },
  useState: (value: unknown) => {
    const n = mock.cursor++;
    if (!(n in mock.slots)) mock.slots[n] = value;
    return [
      mock.slots[n],
      (next: any) => {
        mock.slots[n] = typeof next === "function" ? next(mock.slots[n]) : next;
      },
    ];
  },
  useEffect: (effect: () => void | (() => void), deps: unknown[]) => {
    const n = mock.cursor++,
      old = mock.slots[n];
    if (!old || deps.some((d, i) => !Object.is(d, old.deps[i]))) {
      old?.cleanup?.();
      mock.slots[n] = { deps, cleanup: effect() };
    }
  },
}));
vi.mock("../lib/inventory-reference-journal", async (original) => ({
  ...(await original<typeof import("../lib/inventory-reference-journal")>()),
  readReferenceCommand: mock.read,
  reserveReferenceCommand: mock.reserve,
  acknowledgeReferenceCommand: mock.ack,
}));
const authority: ReferenceAuthority = {
  realmId: "synthetic-realm",
  subjectId: "synthetic-subject",
  generation: "original-generation",
};
let hook: typeof import("../components/inventory/useReferenceCommand").useReferenceCommand;
const complete = vi.fn();
const render = (binding = authority) => {
  mock.cursor = 0;
  return hook(binding, complete);
};
beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  mock.slots = [];
  mock.journal = { revision: 0, intent: null };
  mock.read.mockImplementation(async () => structuredClone(mock.journal));
  mock.reserve.mockImplementation(async (intent: ReferenceIntent) => {
    mock.journal = { revision: 0, intent: structuredClone(intent) };
    return structuredClone(mock.journal);
  });
  vi.stubGlobal("window", {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  });
  vi.stubGlobal("fetch", mock.fetch);
  hook = (await import("../components/inventory/useReferenceCommand"))
    .useReferenceCommand;
});
afterEach(() => vi.unstubAllGlobals());
const input = {
  action: "item.create" as const,
  name: "Synthetic item",
  category: "other",
  baseUnit: "piece",
  basePrecision: 0,
  minLevel: "0",
  note: "",
  reason: "Synthetic setup request",
};
async function ready() {
  render();
  await Promise.resolve();
  return render();
}
it("generation changes release current busy presentation but preserve original in-flight journal", async () => {
  let finish!: (response: Response) => void;
  mock.fetch.mockImplementation(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  const initial = await ready(),
    work = initial.start(input);
  await vi.waitFor(() => expect(mock.fetch).toHaveBeenCalledTimes(1));
  expect(render().busy).toBe(true);
  const saved = structuredClone(mock.journal.intent),
    next = { ...authority, generation: "restored-generation" };
  expect(render(next).busy).toBe(false);
  await Promise.resolve();
  expect(render(next).pending).toEqual(saved);
  finish(Response.json({ message: "authority changed" }, { status: 403 }));
  await work;
  expect(render(next).busy).toBe(false);
  expect(mock.journal.intent).toEqual(saved);
  expect(mock.ack).not.toHaveBeenCalled();
  expect(complete).not.toHaveBeenCalled();
});
it("unmount after saved admission starts never dispatches execution from old continuation", async () => {
  let finish!: (response: Response) => void;
  mock.fetch.mockImplementation(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  const initial = await ready(),
    work = initial.start(input);
  await vi.waitFor(() => expect(mock.fetch).toHaveBeenCalledTimes(1));
  for (const slot of mock.slots) slot?.cleanup?.();
  finish(Response.json({ status: "admitted" }));
  await work;
  expect(mock.fetch).toHaveBeenCalledTimes(1);
  expect(mock.journal.intent).not.toBeNull();
  expect(mock.ack).not.toHaveBeenCalled();
});
