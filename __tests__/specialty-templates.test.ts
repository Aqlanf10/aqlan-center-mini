import { describe, expect, it } from "vitest";
import {
  buildTemplateDrafts, DEFAULT_SPECIALTY_TEMPLATES, templateProblems,
  type CatalogServiceForTemplate, type SpecialtyTemplate,
} from "../lib/specialty-templates";
import { MAX_SESSION_COUNT } from "../lib/workflow";

/** (SPEC-T1) قوالب التخصص: سلامة القوالب الجاهزة، وتحويل القالب إلى بنود خطة بأسعار الدليل. */

let nextId = 1;
const svc = (name: string, category: string, priceMinor: number, extra: Partial<CatalogServiceForTemplate> = {}): CatalogServiceForTemplate => ({
  id: nextId++, name, category, priceMinor, priceSarMinor: null, priceUsdMinor: null, isActive: true, sortOrder: nextId, ...extra,
});

const catalog = [
  svc("نزع عصب — سن أمامي", "rct", 30_000),
  svc("نزع عصب — طاحونة", "rct", 40_000),
  svc("وتد ألياف زجاجية", "post", 20_000),
  svc("تاج خزفي", "crown", 60_000),
  svc("تاج زركونيا", "crown", 100_000, { priceSarMinor: 90_000 }),
  svc("كشف واستشارة", "consultation", 5_000),
  svc("تركيب تقويم ثابت (فكّان)", "ortho", 250_000),
  svc("خدمة موقوفة", "filling", 1, { isActive: false }),
];
const byId = (id: string): SpecialtyTemplate => DEFAULT_SPECIALTY_TEMPLATES.find((template) => template.id === id)!;

describe("(SPEC-T1) the ready-made templates", () => {
  it("are all valid, unique, and within the session limit", () => {
    const ids = new Set<string>();
    for (const template of DEFAULT_SPECIALTY_TEMPLATES) {
      expect(templateProblems(template), template.name).toEqual([]);
      expect(ids.has(template.id)).toBe(false);
      ids.add(template.id);
      for (const step of template.steps) expect(step.sessions.length).toBeLessThanOrEqual(MAX_SESSION_COUNT);
    }
    expect([...ids]).toEqual(expect.arrayContaining(["endo", "filling", "crowns", "bridge", "ortho", "implant", "cleaning", "surgery"]));
  });

  it("templateProblems names what is wrong, in Arabic", () => {
    const broken: SpecialtyTemplate = {
      id: "x", specialty: "س", name: "مكسور", description: "",
      steps: [{ key: "a", title: "خطوة", category: "", preferredService: null, perTooth: false, optional: true, billingRule: "on_completion", labWork: false, sessions: [] }],
    };
    expect(templateProblems(broken)).toEqual(expect.arrayContaining([
      "القالب «مكسور» يحتاج خطوةً إلزامية واحدة على الأقل.",
      "«مكسور» ← «خطوة»: فئة الخدمة فارغة.",
      "«مكسور» ← «خطوة»: بلا جلسات.",
    ]));
  });
});

describe("(SPEC-T1) building a plan from a template", () => {
  it("endo on two teeth with the crown: per-tooth items at catalog price, sessions grouped per step session across teeth", () => {
    const molar = catalog.find((service) => service.name === "نزع عصب — طاحونة")!;
    const result = buildTemplateDrafts(byId("endo"), {
      teeth: [16, 26, 16],
      steps: [{ key: "rct", include: true, serviceId: molar.id }, { key: "crown", include: true, serviceId: null }],
    }, catalog, "YER", {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.drafts.map((draft) => [draft.serviceName, draft.toothCode, draft.unitPriceMinor, draft.billingRule, draft.labWork])).toEqual([
      ["نزع عصب — طاحونة", 16, 40_000, "per_session", false],
      ["نزع عصب — طاحونة", 26, 40_000, "per_session", false],
      ["تاج زركونيا", 16, 100_000, "on_start", true],   // الخدمة المفضّلة بالاسم
      ["تاج زركونيا", 26, 100_000, "on_start", true],
    ]);
    // الوتد اختياري ولم يُختر — لا بند له.
    expect(result.drafts.some((draft) => draft.category === "post")).toBe(false);
    const rct16 = result.drafts[0].sessions;
    expect(rct16.map((item) => [item.title, item.minutes, item.afterDays, item.visitKey])).toEqual([
      ["فتح السن وتنظيف القنوات", 45, 0, "rct:0"],
      ["تشكيل وتعقيم القنوات", 45, 7, "rct:1"],
      ["حشو القنوات النهائي", 45, 7, "rct:2"],
    ]);
    expect(result.drafts[1].sessions[2].visitKey).toBe("rct:2");
    expect(rct16[2].visitTitle).toBe("حشو القنوات النهائي — سن 16، 26");
  });

  it("ortho is one whole-mouth item: bonding, 10 adjustments every 28 days, debond — fee spread over the sessions", () => {
    const result = buildTemplateDrafts(byId("ortho"), { teeth: [], steps: [] }, catalog, "YER", {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.drafts).toHaveLength(1); // الفحص اختياري ولم يُختر
    const [ortho] = result.drafts;
    expect([ortho.serviceName, ortho.toothCode, ortho.unitPriceMinor, ortho.billingRule]).toEqual(["تركيب تقويم ثابت (فكّان)", null, 250_000, "per_session"]);
    expect(ortho.sessions).toHaveLength(12);
    expect(ortho.sessions[1]).toMatchObject({ title: "مراجعة وشدّ 1", afterDays: 28 });
    expect(ortho.sessions[11].title).toBe("فكّ التقويم وتركيب المثبّت");
  });

  it("prices in the plan currency: a service's own SAR price, else converted by the saved rate", () => {
    const sar = buildTemplateDrafts(byId("crowns"), { teeth: [11], steps: [] }, catalog, "SAR", { SAR: 140 });
    expect(sar.ok && sar.drafts[0].unitPriceMinor).toBe(90_000);
    const porcelain = catalog.find((service) => service.name === "تاج خزفي")!;
    const converted = buildTemplateDrafts(byId("crowns"), { teeth: [11], steps: [{ key: "crown", include: true, serviceId: porcelain.id }] }, catalog, "SAR", { SAR: 140 });
    expect(converted.ok && converted.drafts[0].unitPriceMinor).toBe(Math.round(60_000 / 140) * 100);
    const noRate = buildTemplateDrafts(byId("crowns"), { teeth: [11], steps: [{ key: "crown", include: true, serviceId: porcelain.id }] }, catalog, "USD", {});
    expect(noRate).toEqual({ ok: false, message: "لا سعر لخدمة «تاج خزفي» بعملة الخطة (دولار) — اضبط سعرها أو سعر الصرف أولًا." });
  });

  it("refuses clearly: no teeth for a per-tooth step, an empty category, a service from another category", () => {
    expect(buildTemplateDrafts(byId("endo"), { teeth: [], steps: [] }, catalog, "YER", {}))
      .toEqual({ ok: false, message: "اختر السن أو الأسنان لخطوة «علاج الجذور»." });
    expect(buildTemplateDrafts(byId("filling"), { teeth: [11], steps: [] }, catalog, "YER", {}))
      .toEqual({ ok: false, message: "لا خدمة فعّالة في الدليل لخطوة «حشوة» — أضفها إلى الدليل أولًا." });
    const crown = catalog.find((service) => service.category === "crown")!;
    expect(buildTemplateDrafts(byId("endo"), { teeth: [11], steps: [{ key: "rct", include: true, serviceId: crown.id }] }, catalog, "YER", {}))
      .toEqual({ ok: false, message: "الخدمة المختارة لخطوة «علاج الجذور» ليست من فئتها أو غير فعّالة." });
  });

  it("a required step cannot be switched off", () => {
    const result = buildTemplateDrafts(byId("endo"), { teeth: [21], steps: [{ key: "rct", include: false, serviceId: null }] }, catalog, "YER", {});
    expect(result.ok && result.drafts.map((draft) => draft.category)).toEqual(["rct"]);
  });
});
