import { createElement, type DependencyList, type EffectCallback } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "../components/AppShell";

// Exercise the real shell's clock effect without adding a DOM test dependency.
// Other hooks keep React's implementation; effects are mounted explicitly below.
const clock = vi.hoisted(() => ({
  value: { date: "", time: "" },
  effects: [] as { run: EffectCallback; deps: DependencyList | undefined }[],
}));
vi.mock("react", async (importOriginal) => {
  const react = await importOriginal<typeof import("react")>();
  return {
    ...react,
    useEffect: (run: EffectCallback, deps?: DependencyList) => { clock.effects.push({ run, deps }); },
    useState: (initial: unknown) => {
      if (initial && typeof initial === "object" && "date" in initial && "time" in initial) {
        return [clock.value, (value: typeof clock.value) => { clock.value = value; }];
      }
      return react.useState(initial);
    },
  };
});
vi.mock("next/navigation", () => ({ usePathname: () => "/finance", useRouter: () => ({}) }));
vi.mock("../components/SessionProvider", () => ({
  useSessionActions: () => ({ session: { username: "clock-test", role: "cashier" }, logout: vi.fn() }),
}));
vi.mock("../components/GlobalSearchModal", () => ({ GlobalSearchModal: () => null }));
vi.mock("../components/QuickAppointmentModal", () => ({ QuickAppointmentModal: () => null }));
vi.mock("../components/QuickPatientModal", () => ({ QuickPatientModal: () => null }));
vi.mock("../components/ShortcutsHelpModal", () => ({ ShortcutsHelpModal: () => null }));
vi.mock("../components/AiStaffChatModal", () => ({ AiStaffChatModal: () => null }));

function renderShell(clinicTimeZone: string) {
  clock.effects = [];
  const html = renderToStaticMarkup(createElement(AppShell, { clinicTimeZone, children: "clinic content" }));
  return { html, effect: clock.effects[0] };
}

beforeEach(() => {
  clock.value = { date: "", time: "" };
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe.each(["UTC", "America/Los_Angeles", "Asia/Tokyo"])("header clock with viewer timezone %s", (viewerZone) => {
  beforeEach(() => { vi.stubEnv("TZ", viewerZone); });

  it.each([
    ["2026-10-01T22:26:00Z", "٠١:٢٦ ص"],
    ["2026-10-02T00:01:00Z", "٠٣:٠١ ص"],
  ])("shows the clinic's Friday when the incident instant is %s", (instant, expectedTime) => {
    vi.setSystemTime(new Date(instant));
    const { html, effect } = renderShell("Asia/Aden");
    // Server/first client render stay identical; the clock appears after mounting.
    expect(html).not.toContain("الجمعة، ٢ أكتوبر");
    const cleanup = effect.run();
    expect(clock.value).toEqual({ date: "الجمعة، ٢ أكتوبر", time: expectedTime });
    const mountedHtml = renderShell("Asia/Aden").html;
    expect(mountedHtml).toContain("الجمعة، ٢ أكتوبر");
    expect(mountedHtml).toContain(expectedTime);
    expect(vi.getTimerCount()).toBe(1);
    if (typeof cleanup === "function") cleanup();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("honors a non-default configured zone instead of the Aden fallback", () => {
    vi.setSystemTime(new Date("2026-10-01T22:26:00Z"));
    const cleanup = renderShell("America/New_York").effect.run();
    expect(clock.value).toEqual({ date: "الخميس، ١ أكتوبر", time: "٠٦:٢٦ م" });
    if (typeof cleanup === "function") cleanup();
  });

  it.each([
    ["Asia/Aden", "2026-10-01T20:59:50Z"],
    ["America/New_York", "2026-10-02T03:59:50Z"],
  ])("rolls both day and minute together at midnight in %s", (clinicZone, instant) => {
    vi.setSystemTime(new Date(instant));
    const cleanup = renderShell(clinicZone).effect.run();
    expect(clock.value).toEqual({ date: "الخميس، ١ أكتوبر", time: "١١:٥٩ م" });
    vi.advanceTimersByTime(30_000);
    expect(clock.value).toEqual({ date: "الجمعة، ٢ أكتوبر", time: "١٢:٠٠ ص" });
    vi.advanceTimersByTime(60_000);
    expect(clock.value).toEqual({ date: "الجمعة، ٢ أكتوبر", time: "١٢:٠١ ص" });
    if (typeof cleanup === "function") cleanup();
    vi.advanceTimersByTime(60_000);
    expect(clock.value.time).toBe("١٢:٠١ ص");
  });
});

it("restarts the clock effect when the server-supplied timezone changes", () => {
  vi.setSystemTime(new Date("2026-10-01T22:26:00Z"));
  const first = renderShell("Asia/Aden").effect;
  expect(first.deps).toEqual(["Asia/Aden"]);
  const firstCleanup = first.run();
  if (typeof firstCleanup === "function") firstCleanup();
  const next = renderShell("America/New_York").effect;
  expect(next.deps).toEqual(["America/New_York"]);
  const cleanup = next.run();
  expect(clock.value).toEqual({ date: "الخميس، ١ أكتوبر", time: "٠٦:٢٦ م" });
  expect(vi.getTimerCount()).toBe(1);
  if (typeof cleanup === "function") cleanup();
});
