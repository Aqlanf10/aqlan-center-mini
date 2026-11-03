import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { visibleCategories } from "../lib/settings-definitions";
import { CANONICAL_PAGES } from "../lib/canonical-navigation";
import {
  SETTINGS_DOMAINS,
  primaryDomainForCategory,
  projectSettingsDomains,
  searchSettingsLinks,
} from "../lib/settings-navigation";

describe("الهيكل المؤسسي الموحّد للإعدادات (8 نطاقات)", () => {
  it("يضم الثمانية نطاقات المؤسسية المطلوبة ويغطي كل فئة إعدادات مرئية مرة واحدة بالضبط", () => {
    expect(SETTINGS_DOMAINS.map((domain) => domain.id)).toEqual([
      "identity_print",
      "staff_permissions",
      "hours_appointments_reception",
      "clinical_services_rx",
      "finance_currency_commissions",
      "labs_inventory_procurement",
      "messaging_integrations",
      "security_audit_backup",
    ]);

    const visible = visibleCategories();
    const mapped = SETTINGS_DOMAINS.flatMap((domain) => domain.categories);
    expect(new Set(mapped).size).toBe(mapped.length);
    expect([...mapped].sort()).toEqual([...visible].sort());
    expect(mapped[0]).toBe("general");

    for (const category of visible) {
      expect(primaryDomainForCategory(category)).not.toBeNull();
    }
  });

  it("يصفي الشاشات المتخصصة حسب صلاحية الدور الفعلي ولا يعرض روابط المدير للاستقبال أو الطبيب", () => {
    const adminLinks = projectSettingsDomains({ canonical: false, role: "admin" })
      .flatMap((domain) => domain.links.map((link) => link.href));
    expect(adminLinks).toContain("/settings/users");
    expect(adminLinks).toContain("/settings/backup");
    expect(adminLinks).toContain("/settings/readiness");
    expect(adminLinks).toContain("/settings/patient-numbering");
    expect(adminLinks).toContain("/settings/messaging");
    expect(adminLinks).toContain("/finance/services");
    expect(adminLinks).toContain("/inventory/procurement/setup");

    for (const role of ["reception", "doctor"] as const) {
      const links = projectSettingsDomains({ canonical: false, role })
        .flatMap((domain) => domain.links.map((link) => link.href));
      expect(links).not.toContain("/settings/users");
      expect(links).not.toContain("/settings/audit");
      expect(links).not.toContain("/settings/history");
      expect(links).not.toContain("/settings/backup");
      expect(links).not.toContain("/settings/export");
      expect(links).not.toContain("/settings/import");
      expect(links).not.toContain("/settings/reset");
      expect(links).not.toContain("/settings/patient-numbering");
      expect(links).not.toContain("/settings/messaging");
      expect(links).not.toContain("/settings/ai");
      expect(links).toContain("/settings/appointment-services");
      expect(links).toContain("/finance/services");
    }
  });

  it("يلتزم بعقد الهوية الموحّدة: لا يعرض للجلسة الموحّدة إلا الشاشات المسجّلة في CANONICAL_PAGES والممنوحة لها", () => {
    const canonicalHrefs = new Set(CANONICAL_PAGES.map((page) => page.href));

    const opsLinks = projectSettingsDomains({
      canonical: true,
      role: "reception",
      isOwner: false,
      capabilities: ["settings.view", "settings.operational.edit"],
    }).flatMap((domain) => domain.links.map((link) => link.href));
    expect(opsLinks).toEqual([]);

    const staffAndInvLinks = projectSettingsDomains({
      canonical: true,
      role: "reception",
      isOwner: false,
      capabilities: ["settings.view", "staff.view", "inventory.references.view"],
    }).flatMap((domain) => domain.links.map((link) => link.href));
    expect(staffAndInvLinks).toEqual(["/staff-access", "/inventory/procurement/setup"]);

    const ownerLinks = projectSettingsDomains({
      canonical: true,
      role: "admin",
      isOwner: true,
      capabilities: [],
    }).flatMap((domain) => domain.links.map((link) => link.href));
    for (const href of ownerLinks) {
      expect(canonicalHrefs.has(href)).toBe(true);
    }
    expect(ownerLinks).not.toContain("/settings/users");
    expect(ownerLinks).not.toContain("/settings/history");
  });

  it("يدعم البحث عن الشاشات المتخصصة المصرّح بها فقط ويصلح الروابط الميتة والمكررة", () => {
    const adminMatches = searchSettingsLinks("واتساب", { canonical: false, role: "admin" });
    expect(adminMatches.map((entry) => entry.link.href)).toContain("/settings/messaging");

    const receptionMatches = searchSettingsLinks("واتساب", { canonical: false, role: "reception" });
    expect(receptionMatches).toEqual([]);

    const redirectPage = readFileSync(
      resolve(process.cwd(), "app/settings/laboratories/services/page.tsx"),
      "utf8",
    );
    expect(redirectPage).toContain('redirect("/settings/lab-services")');

    const mgmtTools = readFileSync(resolve(process.cwd(), "lib/ai-tools/management-tools.ts"), "utf8");
    const registry = readFileSync(resolve(process.cwd(), "lib/ai-tools/system-feature-registry.ts"), "utf8");
    expect(mgmtTools).not.toContain("/settings/services");
    expect(registry).not.toContain("/settings/services");
    expect(mgmtTools).toContain("/finance/services");
    expect(registry).toContain("/finance/services");
  });
});
