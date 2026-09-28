import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { displayAppManifest } from "../lib/display-app-manifest";

/**
 * (INSTALL-1) تطبيقان يُثبَّتان: الطاقم يبدأ من «/»، وشاشة الصالة تبدأ من «/display» بملء
 * الشاشة أفقيًّا — فلا يرى أحد في الصالة رابطًا ولا يُطلب من التلفاز تسجيل دخول.
 */

describe("the waiting-room TV app", () => {
  const manifest = displayAppManifest("مركز عقلان", "v1");

  it("opens straight on the display screen, full screen, landscape, with its own identity", () => {
    expect(manifest).toMatchObject({
      id: "/display", start_url: "/display", scope: "/display",
      display: "fullscreen", orientation: "landscape", short_name: "شاشة الصالة",
    });
    expect(manifest.display_override).toEqual(["fullscreen", "standalone"]);
    expect(manifest.name).toBe("مركز عقلان — شاشة الصالة");
  });

  it("carries installable icons (192, 512 and maskable)", () => {
    const sizes = (manifest.icons ?? []).map((icon) => `${icon.sizes}:${icon.purpose ?? "any"}`);
    expect(sizes).toEqual(["192x192:any", "512x512:any", "512x512:maskable"]);
  });

  it("the display page links this manifest and the proxy serves it without a session", () => {
    expect(readFileSync("app/display/layout.tsx", "utf8")).toContain('manifest: "/display-app.webmanifest"');
    expect(readFileSync("proxy.ts", "utf8")).toContain('pathname === "/display-app.webmanifest"');
  });

  it("the staff app is not locked to portrait (computers and TVs are landscape)", () => {
    const staff = readFileSync("app/manifest.webmanifest/route.ts", "utf8");
    expect(staff).toContain('orientation: "any"');
    expect(staff).not.toContain('orientation: "portrait"');
  });
});
