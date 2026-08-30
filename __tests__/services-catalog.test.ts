import { describe, expect, it } from "vitest";
import { CATEGORY_LABEL, CHART_CATEGORIES, DEFAULT_SERVICES, validateCatalog } from "../lib/services-catalog";
import { CATEGORY_TO_CONDITION, conditionForCategory } from "../lib/clinical";

/**
 * دليل الخدمات الافتراضي — عقد الدليل مع السلسلة المالية.
 *
 * هذا الدليل يُزرع مرةً واحدة على قاعدةٍ فارغة، فخطأ فيه يتكرر على كل قاعدة جديدة
 * قبل أن يلمسه أحد. والفحوص هنا تحمي ثلاث نقاط بالتحديد: سلامة القائمة نفسها،
 * توافق فئاتها مع خريطة المخطط السني، ووجود خدمة السيناريو اليومي الذي بُني
 * الدليل لأجله (نزع عصب + وتد + بناء).
 */
describe("دليل الخدمات الافتراضي", () => {
  it("القائمة المدمجة سليمة بلا أخطاء", () => {
    expect(validateCatalog()).toEqual([]);
  });

  it("كل الأسعار أعداد صحيحة موجبة — صفرٌ يفوتر العمل ببلاش بصمت", () => {
    for (const service of DEFAULT_SERVICES) {
      expect(Number.isInteger(service.priceMinor), service.name).toBe(true);
      expect(service.priceMinor, service.name).toBeGreaterThan(0);
    }
  });

  it("الأسماء فريدة — اختيارٌ غامض للموظفة هو أول ما يُجادل عليه المريض", () => {
    const names = DEFAULT_SERVICES.map((s) => s.name.trim());
    expect(new Set(names).size).toBe(names.length);
  });

  it("كل فئة من الفئات معروفة في قاموس الفئات", () => {
    for (const service of DEFAULT_SERVICES) {
      if (service.category === null) continue;
      expect(CATEGORY_LABEL[service.category], service.name).toBeDefined();
    }
  });

  it("الفئات المخططية تُحدّث المخطط السني فعلًا — التوافق مع خريطة clinical.ts", () => {
    for (const category of CHART_CATEGORIES) {
      expect(conditionForCategory(category), category).not.toBeNull();
    }
    // وكل مفتاح في خريطة المخطط له فئة معروفة في الدليل — لا فئة يتيمة.
    for (const category of Object.keys(CATEGORY_TO_CONDITION)) {
      expect(CHART_CATEGORIES as readonly string[]).toContain(category);
    }
  });

  it("«وتد وبناء» خارج خريطة المخطط عمدًا — الوتد وحده ليس حالةً نهائية للسن", () => {
    expect(CHART_CATEGORIES as readonly string[]).not.toContain("post");
    expect(conditionForCategory("post")).toBeNull();
    // ومع ذلك يجب أن يوجد في الدليل — هذا بند السيناريو المالي نفسه.
    expect(DEFAULT_SERVICES.some((s) => s.category === "post")).toBe(true);
  });

  it("سيناريو العيادة اليومي موجود كاملًا: نزع عصب وتد بناء تاج", () => {
    const names = DEFAULT_SERVICES.map((s) => s.name);
    expect(names.some((n) => n.includes("نزع عصب"))).toBe(true);
    expect(names.some((n) => n.includes("وتد"))).toBe(true);
    expect(names.some((n) => n.includes("بناء"))).toBe(true);
    expect(names.some((n) => n.includes("تاج"))).toBe(true);
    expect(names.some((n) => n.includes("حشوة"))).toBe(true);
  });

  it("validateCatalog يصطاد الفساد لا يصفّه", () => {
    expect(validateCatalog([
      { name: "حشوة", category: "filling", priceMinor: 100, sortOrder: 1 },
      { name: "حشوة", category: "filling", priceMinor: 100, sortOrder: 1 },
    ]).length).toBeGreaterThanOrEqual(2); // الاسم مكرر + الترتيب مكرر

    expect(validateCatalog([
      { name: "خدعة", category: "filling", priceMinor: -5, sortOrder: 1 },
    ]).length).toBeGreaterThan(0); // سعر سالب

    expect(validateCatalog([
      { name: "فئة منسية", category: "mystery", priceMinor: 10, sortOrder: 1 },
    ])[0]).toContain("غير معروفة");
  });
});
