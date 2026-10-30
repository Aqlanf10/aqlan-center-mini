import { Children, isValidElement, type ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { SETTING_DEFAULTS } from "../lib/settings";
import { SettingsProvider } from "../components/SettingsProvider";
const h = vi.hoisted(() => ({ cached: "false", stored: "true", fail: false, reads: vi.fn() }));
vi.mock("next/font/local", () => ({ default: () => ({ variable: "test-font" }) }));
vi.mock("../lib/session", () => ({ requireSession: vi.fn(async () => null) }));
vi.mock("../lib/db", () => ({
  CLINIC_TIME_ZONE: "Asia/Aden", findUserByUsername: vi.fn(),
  getSettingsSafe: vi.fn(async () => ({ ...SETTING_DEFAULTS, "clinic.login_photo_visible": h.cached })),
  readStoredSettings: async () => {
    h.reads(); if (h.fail) throw new Error("synthetic read failure");
    return new Map([["clinic.login_photo_visible", { value: h.stored, updatedAt: "synthetic" }]]);
  },
}));
vi.mock("../components/AppShell", () => ({ AppShell: () => null }));
const { default: RootLayout } = await import("../app/layout");
async function visibility() {
  const layout = await RootLayout({ children: "public login" });
  let value: Record<string, string> | undefined;
  function visit(node: ReactNode) {
    Children.forEach(node, child => {
      if (!isValidElement<{ children?: ReactNode; value?: Record<string, string> }>(child)) return;
      if (child.type === SettingsProvider) value = child.props.value;
      visit(child.props.children);
    });
  }
  visit(layout); return value?.["clinic.login_photo_visible"];
}
beforeEach(() => { h.cached = "false"; h.stored = "true"; h.fail = false; h.reads.mockClear(); });
it("reflects newly published photo on navigation despite a warm hidden settings cache", async () => {
  expect(await visibility()).toBe("true"); expect(h.reads).toHaveBeenCalledOnce();
});
it("reflects hiding despite a warm visible settings cache", async () => {
  h.cached = "true"; h.stored = "false"; expect(await visibility()).toBe("false");
});
it("fails closed instead of serving a stale visible flag when the fresh read fails", async () => {
  h.cached = "true"; h.fail = true; expect(await visibility()).toBe("false");
});
