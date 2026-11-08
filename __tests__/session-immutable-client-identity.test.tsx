import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { SessionProvider } from "../components/SessionProvider";
import { GET } from "../app/api/auth/me/route";
const state = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, effects: [] as (() => void)[], mounted: false,
  session: vi.fn(), user: vi.fn() }));
vi.mock("../lib/session", () => ({ requireSession: state.session }));
vi.mock("../lib/db", () => ({ findUserByUsername: state.user }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return { ...react,
    useState: (initial: unknown) => {
      const index = state.cursor++;
      if (!(index in state.values)) state.values[index] = typeof initial === "function" ? initial() : initial;
      return [state.values[index], (value: unknown) => { state.values[index] = value; }];
    },
    useCallback: (callback: unknown) => callback,
    useEffect: (callback: () => void) => { if (!state.mounted) state.effects.push(callback); },
  };
});
function render(value: Parameters<typeof SessionProvider>[0]["value"] = null) {
  state.cursor = 0; const result = SessionProvider({ value, children: null });
  state.mounted = true; state.effects.splice(0).forEach((effect) => effect());
  return result.props.value;
}
beforeEach(() => {
  state.values = []; state.cursor = 0; state.effects = []; state.mounted = false; vi.clearAllMocks();
  vi.stubGlobal("localStorage", { removeItem: vi.fn() });
});
afterEach(() => { vi.unstubAllGlobals(); });
describe("immutable client identity projection", () => {
  it("auth/me returns identity from the authenticated session, not a display lookup", async () => {
    state.session.mockResolvedValue({ userId: 7, username: "synthetic", role: "doctor" });
    state.user.mockResolvedValue({ id: 99, displayName: "Display lookup" });
    const response = await GET();
    expect(await response.json()).toMatchObject({ userId: 7, username: "synthetic" });
  });
  it("provider preserves server-rendered immutable identity", () => {
    expect(render({ userId: 7, username: "synthetic", role: "doctor" }).session.userId).toBe(7);
  });
  it("provider preserves auth/me immutable identity after client hydration", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ userId: 7, username: "synthetic", role: "doctor" }) }));
    render(); for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(render().session.userId).toBe(7);
  });
  it("server layout and successful login project only the nonsecret user id", () => {
    // Source contract only for these server composition points; route/provider tests above execute code.
    expect(readFileSync("app/layout.tsx", "utf8")).toContain("userId: session.userId");
    expect(readFileSync("app/api/auth/login/route.ts", "utf8")).toMatch(/NextResponse\.json\(\{\s*userId: user\.id,/);
  });
});
