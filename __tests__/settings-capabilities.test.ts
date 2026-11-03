import { describe, expect, it } from "vitest";
import { SETTING_DEFINITIONS } from "../lib/settings-definitions";
import { SETTING_KEY_CLASSES, SETTING_WRITE_REQUIREMENT, settingBatchRequirement } from "../lib/settings-capabilities";
import { STAFF_CAPABILITIES } from "../lib/staff-capability-catalogue";

describe("per-key settings write policy (M2, Dot 6480538845 item 1)", () => {
  it("classifies every defined setting key exactly once, and nothing else", () => {
    const defined = SETTING_DEFINITIONS.map(definition => definition.key).sort();
    expect(Object.keys(SETTING_KEY_CLASSES).sort()).toEqual(defined);
  });

  it("delegable classes use catalogue capabilities; authority, integration and backup are owner-only", () => {
    for (const [cls, requirement] of Object.entries(SETTING_WRITE_REQUIREMENT)) {
      if ("capability" in requirement) {
        expect(["operational", "finance"]).toContain(cls);
        expect(STAFF_CAPABILITIES).toContain(requirement.capability);
      } else {
        expect(["authority", "integration", "backup"]).toContain(cls);
      }
    }
  });

  it("known authority, integration and backup keys never fall to the operational class", () => {
    for (const key of ["workflow.doctor_financial_view", "finance.reception_adds_opening_balance"]) expect(SETTING_KEY_CLASSES[key].class).toBe("authority");
    for (const key of ["messaging.consent_mode", "reminders.auto_enabled", "ai.clinical_external"]) expect(SETTING_KEY_CLASSES[key].class).toBe("integration");
    for (const key of Object.keys(SETTING_KEY_CLASSES).filter(key => key.startsWith("backup."))) expect(SETTING_KEY_CLASSES[key].class).toBe("backup");
    for (const definition of SETTING_DEFINITIONS.filter(definition => definition.category === "backup" || definition.category === "messaging")) {
      expect(SETTING_KEY_CLASSES[definition.key].class).not.toBe("operational");
    }
  });

  it("a mixed batch requires every key's requirement; an unknown key refuses the whole batch", () => {
    expect(settingBatchRequirement(["clinic.chairs", "finance.rate.SAR", "workflow.doctor_financial_view", "backup.enabled"])).toEqual({
      ok: true, capabilities: ["settings.finance.edit", "settings.operational.edit"], ownerOnly: ["clinic.backup.manage", "settings.security.change"],
    });
    expect(settingBatchRequirement(["clinic.chairs", "no.such.key"])).toEqual({ ok: false, reason: "unknown_setting_key", key: "no.such.key" });
    expect(settingBatchRequirement(["__proto__"])).toMatchObject({ ok: false });
  });
});
