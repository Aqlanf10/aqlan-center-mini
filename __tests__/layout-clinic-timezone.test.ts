import { Children, isValidElement, type ReactNode } from "react";
import { afterAll, expect, it, vi } from "vitest";

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
