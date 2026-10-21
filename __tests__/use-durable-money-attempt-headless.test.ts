import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { FinancialCommand, FinancialJournal } from "../lib/financial-command-journal";
import type { MoneyRequest } from "../lib/money-attempt";

// Exercise the production hook state machine without Chromium. React lifecycle
// and journal persistence are controlled adapters here, not browser/IndexedDB proof.
const mock = vi.hoisted(() => ({
  journal: { revision: 0, command: null } as FinancialJournal,
  read: vi.fn(), reserve: vi.fn(), acknowledge: vi.fn(), fetch: vi.fn(),
}));
vi.mock("react", () => ({
  useCallback: (fn: unknown) => fn,
  useMemo: (fn: () => unknown) => fn(),
  useRef: (current: unknown) => ({ current }),
  useLayoutEffect: (fn: () => unknown) => { fn(); },
  useEffect: (fn: () => unknown) => { fn(); },
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
}));
vi.mock("../components/SessionProvider", () => ({ useSession: () => ({ username: "synthetic-owner" }) }));
vi.mock("../lib/financial-command-journal", async importOriginal => ({
  ...await importOriginal<typeof import("../lib/financial-command-journal")>(),
  readFinancialJournal: mock.read,
  reserveFinancialCommand: mock.reserve,
  acknowledgeFinancialCommand: mock.acknowledge,
}));
const request: MoneyRequest = { url: "/api/payments", operation: "payment", body: JSON.stringify({ patientId: 9, amount: "205000", currency: "YER", kind: "payment", method: "cash" }) };
async function mount() {
  const { useDurableMoneyAttempt } = await import("../components/useDurableMoneyAttempt");
  const Fixture = () => useDurableMoneyAttempt("collection:9", { patientId: 9 }, true);
  const hook = Fixture();
  await Promise.resolve();
  return hook;
}
function receipt(key: string) {
  return Response.json({ id: 701, receiptNumber: "SYN-701", patientId: 9, createdBy: "synthetic-owner", kind: "payment", amountMinor: 205000,
    currency: "YER", invoiceId: null, planId: null, openingCurrency: null, method: "cash", note: null, shiftId: 1,
    createdAt: "2026-10-21T00:00:00Z", baseCurrency: "YER", baseAmountMinor: 205000, exchangeRate: 1, idempotencyKey: key });
}
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks();
  mock.journal = { revision: 0, command: null };
  mock.read.mockImplementation(async () => structuredClone(mock.journal));
  mock.reserve.mockImplementation(async (_scope: unknown, revision: number, command: FinancialCommand) => {
    if (mock.journal.command && mock.journal.command.original !== command.original || !mock.journal.command && revision !== mock.journal.revision) throw new Error("CAS changed");
    mock.journal = { revision, command: structuredClone(command) };
    return structuredClone(mock.journal);
  });
  mock.acknowledge.mockImplementation(async () => { mock.journal = { revision: mock.journal.revision + 1, command: null }; return structuredClone(mock.journal); });
  vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn() });
  vi.stubGlobal("fetch", mock.fetch);
});
afterEach(() => vi.unstubAllGlobals());

it("locks a double click synchronously and persists key/body before the first POST", async () => {
  let finish!: (response: Response) => void;
  mock.fetch.mockImplementation((_url: string, init: RequestInit) => {
    expect(mock.journal.command).not.toBeNull();
    const saved = JSON.parse(mock.journal.command!.payload);
    expect(init.body).toBe(saved.attempt.request.body);
    expect(new Headers(init.headers).get("Idempotency-Key")).toBe(saved.attempt.key);
    return new Promise<Response>(resolve => { finish = resolve; });
  });
  const hook = await mount();
  const first = hook.run(request);
  expect(await hook.run(request)).toEqual({ kind: "busy" });
  await vi.waitFor(() => expect(mock.fetch).toHaveBeenCalledTimes(1));
  finish(receipt(mock.journal.command!.key));
  expect(await first).toMatchObject({ kind: "confirmed", acknowledgment: { paymentId: 701 } });
});

it("keeps exact key and body after a lost response and a fresh module mount (reload)", async () => {
  mock.fetch.mockRejectedValueOnce(new Error("response lost"));
  const first = await mount();
  expect(await first.run(request)).toMatchObject({ kind: "uncertain" });
  const saved = structuredClone(mock.journal.command!);
  expect(saved).not.toBeNull();
  vi.resetModules();
  const reloaded = await mount();
  expect(await reloaded.run({ ...request, body: request.body.replace("205000", "205001") })).toMatchObject({ kind: "blocked" });
  mock.fetch.mockResolvedValueOnce(receipt(saved.key));
  expect(await reloaded.run()).toMatchObject({ kind: "confirmed" });
  const firstInit = mock.fetch.mock.calls[0][1] as RequestInit;
  const retryInit = mock.fetch.mock.calls[1][1] as RequestInit;
  expect(retryInit.body).toBe(firstInit.body);
  expect(retryInit.headers).toEqual(firstInit.headers);
  expect(mock.fetch.mock.calls[1][0]).toBe(mock.fetch.mock.calls[0][0]);
  expect(mock.journal.command).toBeNull();
});
