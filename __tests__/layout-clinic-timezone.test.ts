import { Children, isValidElement, type ReactNode } from "react";
import { afterAll, expect, it, vi } from "vitest";
const requestContext = vi.hoisted(() => ({ publicDisplay: false }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "x-aqlan-public-display": requestContext.publicDisplay ? "1" : "0" }) }));

vi.stubEnv("CLINIC_TIME_ZONE", "America/New_York");
vi.mock("next/font/local", () => ({ default: () => ({ variable: "test-font" }) }));
vi.mock("../lib/session", () => ({ requireSession: vi.fn(async () => null) }));
vi.mock("../lib/db", async (importOriginal) => {
  const db = await importOriginal<typeof import("../lib/db")>();
  const { SETTING_DEFAULTS } = await import("../lib/settings");
  return { ...db, getSettingsSafe: vi.fn(async () => SETTING_DEFAULTS) };
});
// Layout test inspects the serialized props, without rendering client hooks.
vi.mock("../components/AppShell", () => ({ AppShell: () => null }));

const { CLINIC_TIME_ZONE } = await import("../lib/db");
const { AppShell } = await import("../components/AppShell");
const { SettingsProvider } = await import("../components/SettingsProvider");
const { SessionProvider } = await import("../components/SessionProvider");
const { default: RootLayout } = await import("../app/layout");

afterAll(() => { vi.unstubAllEnvs(); });

it("passes the canonical resolved server zone through the existing root layout", async () => {
  const layout = await RootLayout({ children: "clinic content" });
  let shellProps: Record<string, unknown> | undefined;
  const visit = (node: ReactNode) => {
    Children.forEach(node, (child) => {
      if (!isValidElement<{ children?: ReactNode }>(child)) return;
      if (child.type === AppShell) shellProps = child.props;
      visit(child.props.children);
    });
  };
  visit(layout);
  expect(CLINIC_TIME_ZONE).toBe("America/New_York");
  expect(shellProps).toMatchObject({ clinicTimeZone: CLINIC_TIME_ZONE, children: "clinic content" });
  expect(layout.props.dir).toBe("rtl");
});

it("the public display serializes only clinic branding and no staff session provider", async () => {
  requestContext.publicDisplay = true;
  try {
    const layout = await RootLayout({ children: "public display" });
    let settings: Record<string, unknown> | undefined;
    const types: unknown[] = [];
    const visit = (node: ReactNode) => Children.forEach(node, child => {
      if (!isValidElement<{ children?: ReactNode; value?: Record<string, unknown> }>(child)) return;
      types.push(child.type);
      if (child.type === SettingsProvider) settings = child.props.value;
      visit(child.props.children);
    });
    visit(layout);
    expect(Object.keys(settings ?? {})).toEqual(["clinic.name"]);
    expect(types).not.toContain(SessionProvider); expect(types).not.toContain(AppShell);
  } finally { requestContext.publicDisplay = false; }
});
