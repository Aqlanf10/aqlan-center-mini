import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { InventoryCommandJournal } from "../lib/inventory-command-journal";
import type { InventoryRecoveryCommand } from "../lib/inventory-command-recovery";
// Production hook with controlled React lifecycle/storage adapters. This proves
// execution ordering and recovery state; it is not real-browser/IDB acceptance.
const mock = vi.hoisted(() => ({
  journal: { revision: 0, command: null } as InventoryCommandJournal,
  read: vi.fn(), reserve: vi.fn(), acknowledge: vi.fn(), fetch: vi.fn(), post: vi.fn(),
  cleanups: [] as (() => void)[], events: new Map<string, () => void>(),
}));
vi.mock("react", () => ({
  useCallback: (fn: unknown) => fn, useMemo: (fn: () => unknown) => fn(), useRef: (current: unknown) => ({ current }),
  useState: (initial: unknown) => [initial, vi.fn()],
  useLayoutEffect: (fn: () => unknown) => { const cleanup = fn(); if (typeof cleanup === "function") mock.cleanups.push(cleanup as () => void); },
  useEffect: (fn: () => unknown) => { fn(); },
}));
vi.mock("../components/SessionProvider", () => ({ useSession: () => ({ username: "synthetic-owner", role: "doctor" }) }));
vi.mock("../lib/inventory-command-journal", async importOriginal => ({
  ...await importOriginal<typeof import("../lib/inventory-command-journal")>(),
  readInventoryCommandJournal: mock.read, reserveInventoryRecoveryCommand: mock.reserve, acknowledgeInventoryRecoveryCommand: mock.acknowledge,
}));
const input = { usage: { id: "synthetic", quantity: "1", patientId: 19 } };
async function mount() {
  const { useInventoryCommand } = await import("../components/inventory/useInventoryCommand");
  const Fixture = () => useInventoryCommand("custody");
  const hook = Fixture();
  await vi.waitFor(() => expect(mock.read).toHaveBeenCalled());
  await Promise.resolve(); return hook;
}
function receipt(command: InventoryRecoveryCommand, patch: Record<string, unknown> = {}) {
  return Response.json({ id: "synthetic", replayed: false, recovery: { protocol: "inventory-command-v1", status: "committed", actorUserId: 7, key: command.key, digest: command.digest, ...patch } });
}
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks();
  mock.journal = { revision: 0, command: null }; mock.cleanups = []; mock.events.clear();
  mock.read.mockImplementation(async () => structuredClone(mock.journal));
  mock.reserve.mockImplementation(async (_scope: unknown, revision: number, command: InventoryRecoveryCommand) => {
    if (mock.journal.command) return structuredClone(mock.journal);
    if (revision !== mock.journal.revision) throw new Error("CAS changed");
    mock.journal = { revision, command: structuredClone(command) }; return structuredClone(mock.journal);
  });
  mock.acknowledge.mockImplementation(async () => { mock.journal = { revision: mock.journal.revision + 1, command: null }; return structuredClone(mock.journal); });
  mock.fetch.mockImplementation(async (url: string, init?: RequestInit) => url === "/api/auth/me"
    ? Response.json({ id: 7, username: "synthetic-owner", role: "doctor" }) : mock.post(url, init));
  vi.stubGlobal("fetch", mock.fetch);
  vi.stubGlobal("window", { addEventListener: (name: string, fn: () => void) => mock.events.set(name, fn), removeEventListener: vi.fn(), dispatchEvent: vi.fn() });
  vi.stubGlobal("BroadcastChannel", class { onmessage = null; postMessage() {} close() {} });
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
it("locks same-tick submits and persists the exact payload before POST", async () => {
  let finish!: (response: Response) => void;
  mock.post.mockImplementation((_url: string, init: RequestInit) => {
    expect(mock.journal.command).not.toBeNull();
    expect(init.body).toBe(mock.journal.command!.body);
    expect(new Headers(init.headers).get("X-Inventory-Digest")).toBe(mock.journal.command!.digest);
    return new Promise<Response>(resolve => { finish = resolve; });
  });
  const hook = await mount(); const first = hook.send("custody.consume", input);
  expect(await hook.send("custody.consume", input)).toBeNull();
  await vi.waitFor(() => expect(mock.post).toHaveBeenCalledTimes(1));
  finish(receipt(mock.journal.command!)); expect(await first).toMatchObject({ id: "synthetic" });
  expect(mock.journal.command).toBeNull();
});
it("lost response and reload recover the identical key/payload and never create an edited replacement", async () => {
  mock.post.mockRejectedValueOnce(new Error("response lost"));
  const first = await mount(); expect(await first.send("custody.consume", input)).toBeNull();
  const saved = structuredClone(mock.journal.command!); expect(saved).not.toBeNull();
  mock.read.mockClear(); vi.resetModules(); const reloaded = await mount();
  expect(await reloaded.send("custody.consume", { usage: { ...input.usage, quantity: "2" } })).toBeNull();
  expect(mock.post).toHaveBeenCalledTimes(1);
  mock.post.mockResolvedValueOnce(receipt(saved)); expect(await reloaded.retry()).toMatchObject({ id: "synthetic" });
  expect(mock.post.mock.calls[1]).toEqual([mock.post.mock.calls[0][0], expect.objectContaining({ body: saved.body, headers: mock.post.mock.calls[0][1].headers })]);
  expect(mock.journal.command).toBeNull();
});
it.each([400, 401, 403, 409, 503])("retains pending identity after HTTP %d rather than treating generic rejection as proof", async status => {
  mock.post.mockResolvedValue(Response.json({ code: "synthetic", message: "refused" }, { status }));
  const hook = await mount(); await hook.send("custody.consume", input);
  const saved = structuredClone(mock.journal.command!); await hook.retry();
  expect(mock.journal.command).toEqual(saved); expect(mock.acknowledge).not.toHaveBeenCalled();
  expect(mock.post.mock.calls[1][1].body).toBe(saved.body);
});
it("does not retire a success carrying another actor's acknowledgement", async () => {
  mock.post.mockImplementation(() => receipt(mock.journal.command!, { actorUserId: 8 }));
  const hook = await mount(); expect(await hook.send("custody.consume", input)).toBeNull();
  expect(mock.journal.command).not.toBeNull(); expect(mock.acknowledge).not.toHaveBeenCalled();
});
it("unmount or principal change while reservation is pending leaves recovery but sends nothing", async () => {
  let release!: () => void;
  mock.reserve.mockImplementation(async (_scope: unknown, revision: number, command: InventoryRecoveryCommand) => {
    mock.journal = { revision, command }; await new Promise<void>(resolve => { release = resolve; }); return structuredClone(mock.journal);
  });
  const hook = await mount(); const work = hook.send("custody.consume", input);
  await vi.waitFor(() => expect(mock.reserve).toHaveBeenCalled());
  mock.cleanups.splice(0).forEach(fn => fn()); release(); await work;
  expect(mock.post).not.toHaveBeenCalled(); expect(mock.journal.command).not.toBeNull();
});
it("storage failure is never a network fallback, and a known empty journal permits editing again", async () => {
  mock.reserve.mockRejectedValueOnce(new Error("quota"));
  const hook = await mount(); await hook.send("custody.consume", input);
  expect(mock.post).not.toHaveBeenCalled(); expect(mock.journal.command).toBeNull();
  mock.post.mockImplementation(() => receipt(mock.journal.command!));
  expect(await hook.send("custody.consume", { usage: { ...input.usage, quantity: "2" } })).toMatchObject({ id: "synthetic" });
});
it("local invalid input is editable and never reserves or sends", async () => {
  const hook = await mount(); await hook.send("unknown.command", input);
  expect(mock.reserve).not.toHaveBeenCalled(); expect(mock.post).not.toHaveBeenCalled();
  mock.post.mockImplementation(() => receipt(mock.journal.command!));
  expect(await hook.send("custody.consume", input)).toMatchObject({ id: "synthetic" });
});
it("another tab winning the durable reservation prevents this tab sending its new command", async () => {
  const { createInventoryRecoveryCommand } = await import("../lib/inventory-command-recovery");
  const winner = await createInventoryRecoveryCommand({ actor: "synthetic-owner", actorUserId: 7, workspace: "custody" }, "custody.consume", { usage: { ...input.usage, quantity: "2" } });
  const hook = await mount(); mock.journal = { revision: 0, command: winner };
  await hook.send("custody.consume", input); expect(mock.post).not.toHaveBeenCalled();
  mock.post.mockResolvedValueOnce(receipt(winner)); await hook.retry();
  expect(mock.post.mock.calls[0][1].body).toBe(winner.body);
});
it("stale tab never erases its uncertain command after two other acknowledged revisions", async () => {
  mock.post.mockRejectedValueOnce(new Error("lost response"));
  const hook = await mount(); await hook.send("custody.consume", input);
  const original = structuredClone(mock.journal.command!);
  // Other tab acknowledged A, submitted and acknowledged B; A is no longer the
  // last durable acknowledgement. The stale reservation CAS must now fail.
  mock.journal = { revision: 2, command: null };
  mock.reserve.mockRejectedValueOnce(new Error("changed"));
  await hook.retry();
  await hook.send("custody.consume", { usage: { ...input.usage, quantity: "99" } });
  expect(mock.post).toHaveBeenCalledTimes(1);
  expect(mock.reserve.mock.calls[1][2]).toEqual(original);
  expect(mock.reserve).toHaveBeenCalledTimes(2);
});
it("retirement persistence failure retains exact command for a committed replay", async () => {
  mock.post.mockImplementation(() => receipt(mock.journal.command!));
  mock.acknowledge.mockRejectedValueOnce(new Error("quota after response"));
  const hook = await mount(); expect(await hook.send("custody.consume", input)).toBeNull();
  const saved = structuredClone(mock.journal.command!); expect(saved).not.toBeNull();
  expect(await hook.retry()).toMatchObject({ id: "synthetic" });
  expect(mock.post.mock.calls[1][1].body).toBe(saved.body);
  expect(mock.journal.command).toBeNull();
});
it("transient identity read failure retains saved payload; focus rechecks it without automatic replay", async () => {
  mock.post.mockRejectedValueOnce(new Error("lost response"));
  const hook = await mount(); await hook.send("custody.consume", input);
  const saved = structuredClone(mock.journal.command!);
  mock.fetch.mockRejectedValueOnce(new Error("auth read unavailable"));
  await hook.refresh(); expect(mock.journal.command).toEqual(saved); expect(mock.post).toHaveBeenCalledTimes(1);
  await hook.refresh(); expect(mock.post).toHaveBeenCalledTimes(1);
  mock.post.mockResolvedValueOnce(receipt(saved)); expect(await hook.retry()).toMatchObject({ id: "synthetic" });
});
it("an observed principal replacement revokes old continuations and retains durable recovery", async () => {
  mock.post.mockRejectedValueOnce(new Error("lost response"));
  const hook = await mount(); await hook.send("custody.consume", input);
  const saved = structuredClone(mock.journal.command!);
  mock.fetch.mockResolvedValueOnce(Response.json({ id: 8, username: "another-user", role: "doctor" }));
  await hook.refresh(); await hook.retry(); await hook.send("custody.consume", input);
  expect(mock.post).toHaveBeenCalledTimes(1); expect(mock.journal.command).toEqual(saved);
});
