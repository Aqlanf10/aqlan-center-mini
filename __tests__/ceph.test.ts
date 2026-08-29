import { describe, expect, it } from "vitest";
import {
  angleAtVertex, angleBetween, computeAll, computeMmPerPixel, interpret,
  isCephLandmarkCode, lateralOffset, LANDMARKS, MEASUREMENTS, measure,
  missingFor, pixelsToMm, round1, summarize, REQUIRED_LANDMARKS,
  type LandmarkCode, type LandmarkMap, type MeasurementDef, type Pt,
} from "../lib/ceph";

/**
 * حالة تركيبية «معتدلة» — إحداثياتها مشتقة يدويًا من التعريفات لا من معدلاتها.
 *
 * المعدلات المنشورة (SNA ٢±٨٢ ...) وسائلُ عيّناتٍ من مصادر مختلفة، وليست نظامًا
 * هندسيًا واحدًا يُشتقّ بعضها من بعض؛ فلا يصحّ أن تُبنى الاختبارات عليها. ما
 * يثبته هذا الملف ثلاثة أشياء لا رابع لها:
 *
 * ١) **الاتجاهات**: أن ANB الأكبر نحو الصنف الثاني، وأن WITS يتحرك باتجاهه،
 *    وأن الأبعاد الأمامية موجبة.
 * ٢) **التعريفات**: كل قياسٍ يخرج بالقيمة المشتقة يدويًا من متجهاته الموثّقة —
 *    فتغيّرُ متجهٍ يكسر اختباره صراحةً لا صامتًا.
 * ٣) **الحسّيات**: المعايرة، والقيم الناقصة، والتفسير، والخلاصة.
 *
 * الإحداثيات تُبنى برياضياتٍ صاعدة (y للأعلى) ثم تُقلب إلى إحداثيات الشاشة كما
 * يفعل أي صورة — لأن الصور تحفظ y نحو الأسفل، والقياسات تعمل على إحداثيات
 * الصورة كما هي.
 */

/** من إحداثيات رياضية (y للأعلى) إلى إحداثيات الصورة (y للأسفل). */
const img = (x: number, y: number): Pt => ({ x, y: -y });

// حالة تركيبية: صنف أول معتدل النموّ — كل نقطة مشتقة بزاويةٍ معلومة من S-N.
// الإحداثيات هنا رياضية صاعدة (y للأعلى) وتُقلب بـ img() إلى إحداثيات الصورة.
const CASE: LandmarkMap = {
  S: img(0, 0),
  N: img(69, 8), // SN مائل 6.6° نحو الأمام
  // A عند 268.6° من N (نحو الأسفل بشيءٍ من الخلف) → SNA = 82 بالضبط
  A: img(67.57, -51.98),
  // B عند 266.6° من N → SNB = 80 بالضبط → ANB = 2
  B: img(63.84, -79.85),
  // Pog عند 267° من N → الزاوية الوجهية FH-NPog = 87 بالضبط
  Pog: img(64.03, -86.87),
  Me: img(60, -105),
  // Go على 155° من Me → FMA = 25 بالضبط مع FH الأفقية (Or→Po)
  Go: img(-17.03, -69.08),
  Or: img(60, -25),
  Po: img(0, -25),
  // القاطع العلوي تشريحيًا: القمة فوق-خلف الحافة، والمحور مبنيّ بحيث
  // U1-SN = 104 بالضبط وU1-NA = 22 بالضبط (المحور عند اتجاه N→S ناقص ١٠٤°).
  U1A: img(60, -34),
  U1: img(74.08, -71.44),
  // القاطع السفلي تشريحيًا: القمة فوق الحافة، والمحور عند اتجاه N→B زائد ٢٥°
  // → L1-NB = 25 بالضبط، والتاج خلف امتداد NB (مثالية Tweed مع FMA = ٢٥)
  // → IMPA ≈ 86.6 وبُعد الحافة عن NB سالب.
  L1A: img(68, -64),
  L1: img(49.0, -99.2),
  // مستوى إطباق ينحدر 10° نحو الأمام → WITS = -1.3 (قريب من المعدل المنشور -1)
  OcclA: img(70, -48),
  OcclP: img(0, -35.3),
  // منتصف قوس الذقن بين Pog وMe
  Gn: img(61.5, -95.5),
};

const SCALE = 1; // إحداثيات الحالة بالمليمتر نفسها — بكسل واحد = مليمتر واحد

const byCode = (code: string) => {
  const r = computeAll(CASE, SCALE).find((m) => m.code === code);
  return r?.value ?? null;
};

describe("هندسة السيفالو الأساسية", () => {
  it("الزاوية عند رأس: قائمة تعطي ٩٠°", () => {
    const v: Pt = { x: 0, y: 0 };
    expect(angleAtVertex(v, { x: 10, y: 0 }, { x: 0, y: 10 })).toBeCloseTo(90, 5);
  });

  it("الزاوية بين متجهين متطابقين صفر، والمتجه الصفر يعطي NaN", () => {
    const v: Pt = { x: 3, y: 4 };
    expect(angleBetween(v, v)).toBeCloseTo(0, 5);
    expect(angleBetween(v, { x: 0, y: 0 })).toBeNaN();
  });

  it("الإزاحة الجانبية: الأمام موجب — نقطة شرق خطٍّ نازل", () => {
    const a: Pt = { x: 0, y: 0 };
    const b: Pt = { x: 0, y: 10 }; // نازل على الشاشة
    expect(lateralOffset({ x: 5, y: 5 }, a, b)).toBeCloseTo(5, 5);
    expect(lateralOffset({ x: -5, y: 5 }, a, b)).toBeCloseTo(-5, 5);
  });

  it("المعايرة: مليمتر لكل بكسل تُحسب من نقطتين ومسافة حقيقية", () => {
    expect(computeMmPerPixel({ x: 0, y: 0 }, { x: 100, y: 0 }, 10)).toBeCloseTo(0.1, 8);
    expect(pixelsToMm(50, 0.1)).toBeCloseTo(5, 8);
    // حالات تالف: مسافة صفرية أو قيمة غير منطقية → NaN لا رقمٌ زوّار
    expect(computeMmPerPixel({ x: 3, y: 3 }, { x: 3, y: 3 }, 10)).toBeNaN();
    expect(computeMmPerPixel({ x: 0, y: 0 }, { x: 1, y: 0 }, -5)).toBeNaN();
  });

  it("التقريب إلى منزلة عشرية واحدة", () => {
    expect(round1(82.03)).toBe(82.0);
    // JS يقرّب الأنصاف نحو اللانهاية الموجبة — والاختبار يوثّق ذلك.
    expect(round1(-1.35)).toBe(-1.3);
    expect(round1(63.96)).toBe(64.0);
  });
});

describe("القياسات على الحالة التركيبية", () => {
  it("SNA = 82 وSNB = 80 بالضبط (بنيَتا على ذلك)", () => {
    expect(byCode("SNA")).toBeCloseTo(82, 1);
    expect(byCode("SNB")).toBeCloseTo(80, 1);
  });

  it("ANB = SNA − SNB = 2 — صنف أول", () => {
    expect(byCode("ANB")).toBeCloseTo(2, 1);
  });

  it("FMA = 25 وIMPA المشتقة 86.6 وFMIA = 180 − المجموع", () => {
    expect(byCode("FMA")).toBeCloseTo(25, 1);
    expect(byCode("IMPA")).toBeCloseTo(86.6, 1);
    expect(byCode("FMIA")).toBeCloseTo(68.4, 1);
  });

  it("U1-SN = 104 وU1-NA = 22 بالضبط — بمحورٍ تشريحي (القمة فوق الحافة)", () => {
    expect(byCode("U1SN")).toBeCloseTo(104, 1);
    expect(byCode("U1NA_A")).toBeCloseTo(22, 1);
  });

  it("L1-NB = 25 وINTER = 131 وSN-GoGn والزاوية الوجهية ومحور Y — قيم مشتقة يدويًا", () => {
    expect(byCode("L1NB_A")).toBeCloseTo(25, 1);
    expect(byCode("INTER")).toBeCloseTo(131, 1);
    expect(byCode("SNGOGN")).toBeCloseTo(31.6, 0);
    expect(byCode("FANGLE")).toBeCloseTo(87, 1);
    expect(byCode("YAXIS")).toBeCloseTo(63.8, 0);
  });

  it("نسبة Jarabak = 100 × (S-Go)/(N-Me)", () => {
    expect(byCode("JARABAK")).toBeCloseTo(62.8, 0);
  });

  it("الإشارة الأمامية: CONV وU1-NA موجبان — وL1-NB سالبٌ لأن تاج هذه الحالة خلف امتداد NB", () => {
    expect(byCode("CONV")).toBeCloseTo(1.7, 0);
    expect(byCode("U1NA_D")).toBeCloseTo(7.0, 1);
    // قاعدة «الأمام موجب» مثبتة عبر U1NA_D وحالة lateralOffset أعلاه؛ وهنا
    // القاطع السفلي بمثالية Tweed فياجازه امتداد NB من الخلف فيخرج البُعد سالبًا.
    expect(byCode("L1NB_D")).toBeCloseTo(-13.7, 1);
  });

  it("WITS سالب قريب من المعدل، ويتحرك نحو الصنف الثاني إذا تراجع B للخلف", () => {
    const base = byCode("WITS") as number;
    expect(base).toBeCloseTo(-1.3, 0);

    // تراجع الفك الأسفل 10 بكسل للخلف (نحو الصنف الثاني) يدفع WITS أعلى بوضوح.
    const classTwo: LandmarkMap = {
      ...CASE,
      B: img(63.84 - 10, -79.85),
    };
    const w2 = measure("WITS", classTwo, SCALE);
    expect(w2).toBeGreaterThan(base + 5);
  });

  it("الزوايا تعمل بلا معايرة والأطوال تُعطَّل بلاها", () => {
    const all = computeAll(CASE, null as unknown as number);
    const sna = all.find((m) => m.code === "SNA");
    const wits = all.find((m) => m.code === "WITS");
    expect(sna?.value).toBeCloseTo(82, 1);
    expect(wits?.value).toBeNull();
  });

  it("القياس الناقص يظهر null ويذكر معالمه الناقصة", () => {
    const withoutFMA: LandmarkMap = { ...CASE };
    delete withoutFMA.Go;
    delete withoutFMA.Me;
    expect(byCode2(withoutFMA, "FMA")).toBeNull();
    expect(missingFor("FMA", withoutFMA).sort()).toEqual(["Go", "Me"].sort());
    expect(missingFor("SNA", CASE)).toEqual([]);
  });

  const byCode2 = (L: LandmarkMap, code: string) =>
    computeAll(L, SCALE).find((m) => m.code === code)?.value ?? null;
});

describe("السجلات المغلقة والتفسير", () => {
  it("سجل المعالم كامل ومُرتّب بلا تكرار، ورمزٌ غريب يُرفض", () => {
    const codes = LANDMARKS.map((l) => l.code);
    expect(new Set(codes).size).toBe(codes.length);
    expect(REQUIRED_LANDMARKS.length).toBe(codes.length);
    expect(isCephLandmarkCode("S")).toBe(true);
    expect(isCephLandmarkCode("X")).toBe(false);
    expect(isCephLandmarkCode(42)).toBe(false);
  });

  it("سجل القياسات مكتمل التراتب: كل تعريف يحمل معدلاً ومدىً ومصدراً", () => {
    for (const def of MEASUREMENTS) {
      expect(def.mean).toBeTypeOf("number");
      expect(def.tol).toBeGreaterThan(0);
      expect(def.source.length).toBeGreaterThan(0);
      expect(def.needs.length).toBeGreaterThan(0);
    }
  });

  it("التفسير: أعلى المعدل / داخله / أدناه / لا شيء للناقص", () => {
    const def: MeasurementDef = { code: "T", ar: "ت", group: "sagittal", unit: "°", needs: [], mean: 10, tol: 2, source: "اختبار" };
    expect(interpret(12.1, def)).toBe("above");
    expect(interpret(10, def)).toBe("within");
    expect(interpret(7.9, def)).toBe("below");
    expect(interpret(NaN, def)).toBeNull();
  });

  it("الخلاصة تقرأ ANB وFMA بلا أن تُشخّص", () => {
    const all = computeAll(CASE, SCALE);
    const s = summarize(all);
    expect(s.skeletal).toContain("صنف أول");
    expect(s.vertical).toContain("متوازن");

    const classTwo = summarize(computeAll({ ...CASE, B: img(53.84, -79.85) }, SCALE));
    expect(classTwo.skeletal).toContain("ثانٍ");
  });
});
