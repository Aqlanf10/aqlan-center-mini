import { describe, expect, it } from "vitest";
import {
  CEPH_SCHOOLS, computeAll, generateCephExpertDiagnosis, getClinicalInterpretation, getSeverityStars,
  LANDMARKS, MEASUREMENTS, measure, suggestDiagnosis, suggestLandmarks,
  type LandmarkCode, type LandmarkMap, type Pt,
} from "../lib/ceph";

const img = (x: number, y: number): Pt => ({ x, y: -y });

describe("معالم الأنسجة الرخوة والبروفايل الجمالي", () => {
  it("المعالم الخمسة الجديدة مسجلة في سجل المعالم بخصائصها الصحيحة", () => {
    const codes = ["Prn", "Sn", "Ls", "Li", "PogS"] as const;
    for (const code of codes) {
      const def = LANDMARKS.find((l) => l.code === code);
      expect(def).toBeDefined();
      expect(def?.required).toBe(false);
      expect(def?.ar.length).toBeGreaterThan(0);
      expect(def?.en.length).toBeGreaterThan(0);
      expect(def?.hint.length).toBeGreaterThan(0);
    }
  });

  it("قياسات الأنسجة الرخوة مسجلة في مجموعة softTissue بالمعدلات الصحيحة", () => {
    const eUl = MEASUREMENTS.find((m) => m.code === "E_LINE_UL");
    const eLl = MEASUREMENTS.find((m) => m.code === "E_LINE_LL");
    const naso = MEASUREMENTS.find((m) => m.code === "NASOLABIAL");

    expect(eUl).toBeDefined();
    expect(eUl?.group).toBe("softTissue");
    expect(eUl?.unit).toBe("mm");
    expect(eUl?.needs).toEqual(["Prn", "PogS", "Ls"]);

    expect(eLl).toBeDefined();
    expect(eLl?.group).toBe("softTissue");
    expect(eLl?.unit).toBe("mm");
    expect(eLl?.needs).toEqual(["Prn", "PogS", "Li"]);

    expect(naso).toBeDefined();
    expect(naso?.group).toBe("softTissue");
    expect(naso?.unit).toBe("°");
    expect(naso?.needs).toEqual(["Prn", "Sn", "Ls"]);
  });

  it("حساب خط ريكتس E-Line: المسافة الموقعة من Ls وLi للخط Prn-PogS", () => {
    // خط عمودي من Prn(100, 20) إلى PogS(100, 120) على الشاشة
    const map: LandmarkMap = {
      Prn: { x: 100, y: 20 },
      PogS: { x: 100, y: 120 },
      // Ls خلف الخط بـ 4 وحدات (غربًا نحو -x)
      Ls: { x: 96, y: 60 },
      // Li أمام الخط بـ 2 وحدة (شرقًا نحو +x)
      Li: { x: 102, y: 80 },
    };

    const scale = 1.0; // 1 بكسل = 1 مم
    const dUl = measure("E_LINE_UL", map, scale);
    const dLl = measure("E_LINE_LL", map, scale);

    expect(dUl).toBeCloseTo(-4, 2);
    expect(dLl).toBeCloseTo(2, 2);
  });

  it("حساب الزاوية الأنفية الشفوية NASOLABIAL عند Subnasale", () => {
    // زاوية قائمة بالضبط 90° عند Sn
    const map: LandmarkMap = {
      Sn: { x: 100, y: 100 },
      Prn: { x: 100, y: 70 }, // شعاع رأسي للأعلى
      Ls: { x: 130, y: 100 }, // شعاع أفقي للأمام
    };

    const angle = measure("NASOLABIAL", map, 1.0);
    expect(angle).toBeCloseTo(90, 2);
  });
});

describe("محرك اقتراح المعالم التشريحية الذكي suggestLandmarks", () => {
  it("يقترح كافة المعالم الـ 25 بنسب تناسب أبعاد الصورة", () => {
    const suggested = suggestLandmarks(1000, 1000);
    expect(Object.keys(suggested).length).toBe(LANDMARKS.length);

    for (const def of LANDMARKS) {
      const pt = suggested[def.code];
      expect(pt).toBeDefined();
      expect(pt.x).toBeGreaterThan(0);
      expect(pt.x).toBeLessThan(1000);
      expect(pt.y).toBeGreaterThan(0);
      expect(pt.y).toBeLessThan(1000);
    }
  });

  it("يحافظ على المعالم المحددة مسبقًا ولا يستبدلها", () => {
    const existing: LandmarkMap = {
      S: { x: 450, y: 320 },
      N: { x: 680, y: 310 },
      Prn: { x: 790, y: 440 },
    };

    const suggested = suggestLandmarks(1200, 1200, existing);
    expect(suggested.S).toEqual(existing.S);
    expect(suggested.N).toEqual(existing.N);
    expect(suggested.Prn).toEqual(existing.Prn);
    // المعالم الأخرى يتم تقديرها
    expect(suggested.A).toBeDefined();
    expect(suggested.B).toBeDefined();
  });

  it("يكيف المقياس والدوران تلقائيًا عند توفر نقطتي S و N", () => {
    // جمجمة مائلة ومكبرة بمقدار الضعف
    const s1: Pt = { x: 200, y: 200 };
    const n1: Pt = { x: 430, y: 200 }; // مسافة S-N أطول
    const res = suggestLandmarks(1000, 1000, { S: s1, N: n1 });

    expect(res.S).toEqual(s1);
    expect(res.N).toEqual(n1);
    expect(res.A.x).toBeGreaterThan(s1.x);
    expect(res.Pog.y).toBeGreaterThan(res.A.y);
  });
});

describe("محرك التشخيص التقويمي السردي والخبير generateCephExpertDiagnosis", () => {
  const balancedCase: LandmarkMap = {
    S: img(0, 0),
    N: img(69, 8),
    A: img(67.57, -51.98), // SNA = 82
    B: img(63.84, -79.85), // SNB = 80 -> ANB = 2 (Class I)
    Pog: img(64.03, -86.87),
    Me: img(60, -105),
    Go: img(-17.03, -69.08), // FMA = 25 (Normodivergent)
    Or: img(60, -25),
    Po: img(0, -25),
    U1A: img(60, -34),
    U1: img(74.08, -71.44), // U1-NA = 22
    L1A: img(68, -64),
    L1: img(49.0, -99.2),   // L1-NB = 25
    OcclA: img(70, -48),
    OcclP: img(0, -35.3),
    Gn: img(61.5, -95.5),
    Prn: img(92, -45),
    Sn: img(78, -52),
    Ls: img(79, -60),
    Li: img(75, -75),
    PogS: img(70, -88),
  };

  it("تشخيص حالة صنف أول متوازنة طبيعية", () => {
    const results = computeAll(balancedCase, 1.0);
    const dx = generateCephExpertDiagnosis(results, { age: 13, gender: "female" });

    expect(dx.sagittalSkeletal.classification).toBe("Class I");
    expect(dx.sagittalSkeletal.severity).toBe("normal");
    expect(dx.verticalSkeletal.pattern).toBe("Normodivergent");
    expect(dx.treatmentRecommendations.extractionDecision).toBe("non-extraction");
    expect(dx.treatmentRecommendations.orthognathicSurgery).toBe(false);
    expect(dx.formatted.skeletal).toContain("صنف أول");
    expect(dx.formatted.finalDx).toContain("Class I");
  });

  it("تشخيص صنف ثانٍ نموذج 1 شديد مع بروز ثنائي واستطباب قلع الضواحك", () => {
    // تراجع الفك السفلي + بروز مفرط للقواطع
    const classTwoCase: LandmarkMap = {
      ...balancedCase,
      B: img(55, -80), // SNB ينخفض بشدة -> ANB = 82 - 74 = 8°
      // قواطع علوية وسفلية مائلة للأمام بشدة
      U1: img(86, -71.44), // ميلان شفوي كبير U1-NA
      L1: img(62, -99.2),
      Ls: img(90, -60),   // بروز الشفة العليا أمام خط ريكتس
      Li: img(88, -75),
    };

    const results = computeAll(classTwoCase, 1.0);
    const dx = generateCephExpertDiagnosis(results, { age: 14, gender: "male" });

    expect(dx.sagittalSkeletal.classification).toBe("Class II div 1");
    expect(dx.sagittalSkeletal.severity).toBe("moderate");
    expect(dx.treatmentRecommendations.extractionDecision).toBe("extraction-indicated");
    expect(dx.treatmentRecommendations.growthModification).toBe(true);
    expect(dx.formatted.recommendationsText).toContain("قلع");
  });

  it("تشخيص صنف ثانٍ نموذج 2 مع ارتداد القواطع العلوية وخطة غير قالعة مع توسيع", () => {
    const classTwoDivTwoCase: LandmarkMap = {
      ...balancedCase,
      B: img(57, -80), // ANB > 4
      // ارتداد حاد في القاطع العلوي
      U1A: img(66, -34),
      U1: img(65, -71.44), // U1-NA < 15°
    };

    const results = computeAll(classTwoDivTwoCase, 1.0);
    const dx = generateCephExpertDiagnosis(results, { age: 12 });

    expect(dx.sagittalSkeletal.classification).toBe("Class II div 2");
    expect(dx.treatmentRecommendations.extractionDecision).toBe("non-extraction");
    expect(dx.treatmentRecommendations.expansion).toBe(true);
  });

  it("تشخيص صنف ثالث مع قصور الفك العلوي في طفل صغير يستدعي Facemask", () => {
    const classThreeChild: LandmarkMap = {
      ...balancedCase,
      A: img(57, -51.98), // SNA = 74° (تراجع فك علوي)
      B: img(65, -79.85), // SNB = 80° -> ANB = -6°
    };

    const results = computeAll(classThreeChild, 1.0);
    const dx = generateCephExpertDiagnosis(results, { age: 9, gender: "female" });

    expect(dx.sagittalSkeletal.classification).toBe("Class III");
    expect(dx.sagittalSkeletal.maxilla).toBe("retrognathic");
    expect(dx.treatmentRecommendations.growthModification).toBe(true);
    expect(dx.treatmentRecommendations.growthModificationAr).toContain("Facemask");
  });

  it("تشخيص صنف ثالث هيكلي شديد لدى شخص بالغ يستدعي جراحة تقويمية للفكين", () => {
    const severeAdultClassThree: LandmarkMap = {
      ...balancedCase,
      A: img(58, -51.98),
      B: img(72, -79.85), // ANB = -7°
    };

    const results = computeAll(severeAdultClassThree, 1.0);
    const dx = generateCephExpertDiagnosis(results, { age: 24, gender: "male" });

    expect(dx.sagittalSkeletal.classification).toBe("Class III");
    expect(dx.sagittalSkeletal.severity).toBe("severe");
    expect(dx.treatmentRecommendations.orthognathicSurgery).toBe(true);
    expect(dx.treatmentRecommendations.orthognathicSurgeryAr).toContain("جراحة تقويمية");
  });

  it("تشخيص النمط العمودي المنفتح Hyperdivergent واستطباب زرعات TADs", () => {
    const hyperCase: LandmarkMap = {
      ...balancedCase,
      // زاوية الفك مفتوحة جداً
      Go: img(-25, -50),
      Me: img(60, -115), // FMA > 32
    };

    const results = computeAll(hyperCase, 1.0);
    const dx = generateCephExpertDiagnosis(results);

    expect(dx.verticalSkeletal.pattern).toBe("Hyperdivergent");
    expect(dx.treatmentRecommendations.anchorageOrTADs).toBe(true);
  });

  it("اقتراح التشخيص suggestDiagnosis يدعم قسم الأنسجة الرخوة عند توفر قياساتها", () => {
    const resultsWithSoftTissue = computeAll(balancedCase, 1.0);
    const suggestion = suggestDiagnosis(resultsWithSoftTissue);

    expect(suggestion.softTissue).not.toContain("غير متاح");
    expect(suggestion.softTissue).toContain("ريكتس");
  });
});

describe("مدارس كبار علماء التقويم ومضلع بيورك وجاراك (WebCeph Parity)", () => {
  it("معلم المفصل Ar مسجل كمعلم اختياري للتحاليل الموسعة", () => {
    const ar = LANDMARKS.find((l) => l.code === "Ar");
    expect(ar).toBeDefined();
    expect(ar?.required).toBe(false);
    expect(ar?.en).toBe("Articulare");
    expect(ar?.hint).toContain("بيورك");
  });

  it("حساب زوايا مضلع بيورك الثلاث ومجموع بيورك (Bjork Polygon Sum = ~396°)", () => {
    // حالة اختبارية هندسية معلومة الزوايا لمضلع بيورك
    const map: LandmarkMap = {
      N: { x: 100, y: 50 },
      S: { x: 40, y: 50 },  // زاوية السرج عند S
      Ar: { x: 30, y: 90 }, // زاوية الارتكاز المفصلي عند Ar
      Go: { x: 25, y: 150 }, // زاوية الفك السفلي عند Go
      Me: { x: 90, y: 170 },
    };

    const saddle = measure("SADDLE", map, 1.0);
    const articular = measure("ARTICULAR", map, 1.0);
    const gonial = measure("GONIAL", map, 1.0);
    const bjorkSum = measure("BJORK_SUM", map, 1.0);

    expect(saddle).toBeGreaterThan(90);
    expect(articular).toBeGreaterThan(90);
    expect(gonial).toBeGreaterThan(90);
    expect(bjorkSum).toBeCloseTo(saddle + articular + gonial, 2);
  });

  it("تأثير مجموع مضلع بيورك على تشخيص الدوران الفكي (Clockwise vs Counter-clockwise)", () => {
    // حالة مضلع بيورك مرتفع > 402° (دوران مع عقارب الساعة وميل لانفتاح العضة)
    const hyperBjorkResults = [
      { code: "BJORK_SUM", value: 408, ar: "", en: "", unit: "°", group: "vertical" as const, schools: ["jarabak" as const], display: "408", mean: 396, tol: 6, status: "above" as const, severityStars: "**" as const, interpretationEn: "", interpretationAr: "", source: "Bjork" },
      { code: "FMA", value: 29, ar: "", en: "", unit: "°", group: "vertical" as const, schools: ["tweed" as const], display: "29", mean: 25, tol: 3, status: "above" as const, severityStars: "*" as const, interpretationEn: "", interpretationAr: "", source: "Tweed" },
    ];

    const dx = generateCephExpertDiagnosis(hyperBjorkResults);
    expect(dx.verticalSkeletal.pattern).toBe("Hyperdivergent");
    expect(dx.verticalSkeletal.detailsAr.some((d) => d.includes("عقارب الساعة"))).toBe(true);
  });

  it("تحقق من تصنيف المدارس السبع الكلاسيكية لكبار العلماء", () => {
    const schoolSet = new Set(MEASUREMENTS.flatMap((m) => m.schools));
    expect(schoolSet.has("steiner")).toBe(true);
    expect(schoolSet.has("tweed")).toBe(true);
    expect(schoolSet.has("downs")).toBe(true);
    expect(schoolSet.has("mcnamara")).toBe(true);
    expect(schoolSet.has("ricketts")).toBe(true);
    expect(schoolSet.has("jarabak")).toBe(true);
    expect(schoolSet.has("wits")).toBe(true);
    expect(schoolSet.has("softTissue")).toBe(true);

    const steinerList = MEASUREMENTS.filter((m) => m.schools.includes("steiner"));
    expect(steinerList.length).toBeGreaterThanOrEqual(10);

    const tweedList = MEASUREMENTS.filter((m) => m.schools.includes("tweed"));
    expect(tweedList.map((m) => m.code)).toContain("FMA");
    expect(tweedList.map((m) => m.code)).toContain("IMPA");
    expect(tweedList.map((m) => m.code)).toContain("FMIA");

    const bjorkList = MEASUREMENTS.filter((m) => m.schools.includes("jarabak"));
    expect(bjorkList.map((m) => m.code)).toContain("BJORK_SUM");
    expect(bjorkList.map((m) => m.code)).toContain("SADDLE");
    expect(bjorkList.map((m) => m.code)).toContain("ARTICULAR");
    expect(bjorkList.map((m) => m.code)).toContain("GONIAL");
  });
});

describe("معايير التحليل المتقدمة لمنصة WebCeph ونظام Kim (APDI, ODI, CF, Overjet, Overbite, Ba Landmark)", () => {
  it("معلم Basion (Ba) مسجل بدقة كمعلم اختياري ويدخل في اقتراحات الذكاء الاصطناعي", () => {
    const ba = LANDMARKS.find((l) => l.code === "Ba");
    expect(ba).toBeDefined();
    expect(ba?.required).toBe(false);
    expect(ba?.en).toBe("Basion");
    expect(ba?.ar).toBe("القاعدية — Basion");

    const suggested = suggestLandmarks(1000, 1000);
    expect(suggested.Ba).toBeDefined();
    expect(suggested.Ba.x).toBeCloseTo(330, 0);
    expect(suggested.Ba.y).toBeCloseTo(520, 0);
  });

  it("حساب درجات الشدة بالنجوم getSeverityStars وفق انحرافات WebCeph المعيارية", () => {
    // mean=82, sd=2
    // <= 1 SD -> ""
    expect(getSeverityStars(82, 82, 2)).toBe("");
    expect(getSeverityStars(83.5, 82, 2)).toBe("");
    expect(getSeverityStars(80.5, 82, 2)).toBe("");

    // 1 < Z <= 2 -> "*"
    expect(getSeverityStars(85, 82, 2)).toBe("*");
    expect(getSeverityStars(79, 82, 2)).toBe("*");

    // 2 < Z <= 3 -> "**"
    expect(getSeverityStars(87, 82, 2)).toBe("**");
    expect(getSeverityStars(77, 82, 2)).toBe("**");

    // > 3 SD -> "***"
    expect(getSeverityStars(90, 82, 2)).toBe("***");
    expect(getSeverityStars(74, 82, 2)).toBe("***");

    // Non-finite or null
    expect(getSeverityStars(null, 82, 2)).toBe("");
    expect(getSeverityStars(NaN, 82, 2)).toBe("");
  });

  it("التفسيرات السريرية الفورية getClinicalInterpretation للقياسات الرئيسية", () => {
    // SNA
    const snaHigh = getClinicalInterpretation("SNA", 86);
    expect(snaHigh.en).toContain("Prognathic maxilla");
    expect(snaHigh.ar).toContain("بروز الفك العلوي");

    const snaLow = getClinicalInterpretation("SNA", 78);
    expect(snaLow.en).toContain("Retrognathic maxilla");
    expect(snaLow.ar).toContain("تراجع الفك العلوي");

    // ANB
    const anbClass2 = getClinicalInterpretation("ANB", 5.5);
    expect(anbClass2.en).toBe("Skeletal Class II");
    expect(anbClass2.ar).toBe("صنف هيكلي ثانٍ");

    const anbClass3 = getClinicalInterpretation("ANB", -2);
    expect(anbClass3.en).toBe("Skeletal Class III");
    expect(anbClass3.ar).toBe("صنف هيكلي ثالث");

    // Kim: APDI & ODI
    const apdiClass3 = getClinicalInterpretation("APDI", 93);
    expect(apdiClass3.en).toContain("Class III");
    expect(apdiClass3.ar).toContain("صنف هيكلي ثالث");

    const odiOpen = getClinicalInterpretation("ODI", 64);
    expect(odiOpen.en).toBe("Open bite tendency");
    expect(odiOpen.ar).toContain("عضة مفتوحة");

    const odiDeep = getClinicalInterpretation("ODI", 82);
    expect(odiDeep.en).toBe("Deep bite tendency");
    expect(odiDeep.ar).toContain("عضة عميقة");

    // EXT_INDEX
    const extInd = getClinicalInterpretation("EXT_INDEX", 145);
    expect(extInd.en).toBe("Extraction indicated");
    expect(extInd.ar).toContain("قلع");

    const nonExt = getClinicalInterpretation("EXT_INDEX", 160);
    expect(nonExt.en).toBe("Non-Extraction preferred");
    expect(nonExt.ar).toContain("عدم القلع");
  });

  it("حساب Overjet و Overbite هندسياً بإسقاط متجه القواطع على المستوى الإطباقي", () => {
    // المستوى الإطباقي أفقي من OcclP(0, 100) إلى OcclA(200, 100) متجهاً للأمام (+x)
    // القاطع السفلي L1 عند (100, 100)
    // القاطع العلوي U1 متقدم 4 بكسل للأمام (+x) و2 بكسل للأسفل (+y: اتجاه العضة العمودية)
    const map: LandmarkMap = {
      OcclP: { x: 0, y: 100 },
      OcclA: { x: 200, y: 100 },
      L1: { x: 100, y: 100 },
      U1: { x: 104, y: 102 },
    };

    const scale = 1.0; // 1 بكسل = 1 مم
    const oj = measure("OVERJET", map, scale);
    const ob = measure("OVERBITE", map, scale);

    expect(oj).toBeCloseTo(4.0, 1);
    expect(ob).toBeCloseTo(2.0, 1);

    const ojInterp = getClinicalInterpretation("OVERJET", oj);
    expect(ojInterp.ar).toContain("طبيعي");

    const obInterp = getClinicalInterpretation("OVERBITE", ob);
    expect(obInterp.ar).toContain("طبيعية");
  });

  it("حساب مؤشرات كيم (Kim Analysis: APDI, ODI, CF, EXT_INDEX)", () => {
    // بناء معالم هندسية تحقق قياسات صريحة
    // FH: Po(50, 100) -> Or(150, 100) (أفقي تماماً dir=(1, 0))
    // Mandibular: Go(40, 200) -> Me(140, 200) (أفقي تماماً dir=(1, 0))
    // Palatal: PNS(60, 120) -> ANS(160, 120) (أفقي تماماً dir=(1, 0))
    // AB line: A(120, 130) -> B(120, 180) (رأسي تماماً dir=(0, 1))
    // الزاوية بين FH و AB = 90°
    // الزاوية بين Mandibular و AB = 90°
    // PP_FH = 0°
    const map: LandmarkMap = {
      Po: { x: 50, y: 100 },
      Or: { x: 150, y: 100 },
      Go: { x: 40, y: 200 },
      Me: { x: 140, y: 200 },
      PNS: { x: 60, y: 120 },
      ANS: { x: 160, y: 120 },
      A: { x: 120, y: 130 },
      B: { x: 120, y: 180 },
      // Nasolabial = 90°
      Sn: { x: 150, y: 140 },
      Prn: { x: 150, y: 110 },
      Ls: { x: 180, y: 140 },
    };

    const fhab = measure("FH_AB", map, 1.0);
    const abMand = measure("AB_MAND", map, 1.0);
    const ppFh = measure("PP_FH", map, 1.0);
    const apdi = measure("APDI", map, 1.0);
    const odi = measure("ODI", map, 1.0);
    const cf = measure("CF", map, 1.0);
    const extIndex = measure("EXT_INDEX", map, 1.0);

    expect(fhab).toBeCloseTo(90, 1);
    expect(abMand).toBeCloseTo(90, 1);
    expect(ppFh).toBeCloseTo(0, 1);
    expect(apdi).toBeCloseTo(90, 1);
    expect(odi).toBeCloseTo(90, 1);
    expect(cf).toBeCloseTo(180, 1);
    // Nasolabial = 90°, nasoAdj = (90 - 95) * 0.5 = -2.5
    expect(extIndex).toBeCloseTo(177.5, 1);
  });

  it("مدارس التحليل تضم WebCeph و Kim بجميع قياساتها وتصنيفاتها", () => {
    const webcephSchool = CEPH_SCHOOLS.find((s) => s.id === "webceph");
    expect(webcephSchool).toBeDefined();
    expect(webcephSchool?.nameEn).toContain("WebCeph");

    const kimSchool = CEPH_SCHOOLS.find((s) => s.id === "kim");
    expect(kimSchool).toBeDefined();
    expect(kimSchool?.nameEn).toContain("Kim");

    const webcephMeasurements = MEASUREMENTS.filter((m) => m.schools.includes("webceph"));
    expect(webcephMeasurements.length).toBeGreaterThanOrEqual(25);

    const kimMeasurements = MEASUREMENTS.filter((m) => m.schools.includes("kim"));
    expect(kimMeasurements.map((m) => m.code)).toEqual(
      expect.arrayContaining(["FH_AB", "AB_MAND", "PP_FH", "APDI", "ODI", "CF", "EXT_INDEX"])
    );
  });

  it("دالة computeAll تعيد قياسات كاملة مع حقول WebCeph (النجوم والتفسير ثنائي اللغة)", () => {
    const map: LandmarkMap = {
      S: { x: 100, y: 100 },
      N: { x: 200, y: 100 },
      A: { x: 190, y: 150 },
      B: { x: 185, y: 180 },
    };

    const results = computeAll(map, 1.0);
    const sna = results.find((r) => r.code === "SNA");
    expect(sna).toBeDefined();
    expect(sna?.value).toBeDefined();
    expect(sna?.severityStars).toBeDefined();
    expect(sna?.interpretationEn).toBeDefined();
    expect(sna?.interpretationAr).toBeDefined();
    expect(sna?.interpretationAr?.length).toBeGreaterThan(0);
  });
});
