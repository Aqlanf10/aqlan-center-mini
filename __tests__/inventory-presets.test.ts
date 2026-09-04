import { describe, expect, it } from "vitest";
import {
  DENTAL_SUPPLY_PRESETS,
  calculateInventoryHealth,
} from "../lib/inventory";

describe("قوالب المواد السنية ومؤشر صحة المخزون", () => {
  it("تحتوي قوالب المواد السنية على التصنيفات السريرية الأساسية", () => {
    expect(DENTAL_SUPPLY_PRESETS.length).toBeGreaterThan(10);

    const categories = new Set(DENTAL_SUPPLY_PRESETS.map((p) => p.category));
    expect(categories.has("anesthesia")).toBe(true);
    expect(categories.has("filling")).toBe(true);
    expect(categories.has("surgical")).toBe(true);
    expect(categories.has("impression")).toBe(true);
    expect(categories.has("hygiene")).toBe(true);
    expect(categories.has("ortho")).toBe(true);

    for (const preset of DENTAL_SUPPLY_PRESETS) {
      expect(preset.name.length).toBeGreaterThan(3);
      expect(preset.unit.length).toBeGreaterThan(1);
      expect(preset.minLevel).toBeGreaterThanOrEqual(1);
    }
  });

  it("يحسب مؤشر صحة وأمان المخزون بدقة", () => {
    // 1. Perfect stock: 100% health
    const perfectHealth = calculateInventoryHealth(
      [
        { balance: 10, minLevel: 2 },
        { balance: 5, minLevel: 1 },
      ],
      0,
      0,
    );
    expect(perfectHealth.healthScore).toBe(100);
    expect(perfectHealth.outOfStockCount).toBe(0);
    expect(perfectHealth.lowStockCount).toBe(0);

    // 2. Out of stock item + expired batch
    const penalizedHealth = calculateInventoryHealth(
      [
        { balance: 0, minLevel: 3 }, // out of stock (-15)
        { balance: 2, minLevel: 4 }, // low stock (-5)
      ],
      1, // 1 expired batch (-20)
      1, // 1 soon expiring batch (-5)
    );
    // 100 - (15 + 5 + 20 + 5) = 55%
    expect(penalizedHealth.healthScore).toBe(55);
    expect(penalizedHealth.outOfStockCount).toBe(1);
    expect(penalizedHealth.lowStockCount).toBe(1);
    expect(penalizedHealth.expiredCount).toBe(1);
    expect(penalizedHealth.soonExpiringCount).toBe(1);
  });
});
