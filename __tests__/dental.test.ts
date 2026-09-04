import { describe, expect, it } from "vitest";
import {
  ALL_TEETH, PERMANENT_LOWER, PERMANENT_UPPER,
  buildChart, chartSummary, isPrimary, isValidTooth,
  normalizeSurfaces, toothName, toUniversal, calculatePerioAssessment,
  type ToothRecord, type ToothPerioRecord,
} from "../lib/dental";

const record = (over: Partial<ToothRecord>): ToothRecord => ({
  id: 1, toothCode: 16, condition: "caries", stage: "existing", surfaces: null,
  note: null, recordedBy: "د. عقلان", recordedAt: "2026-08-01T09:00:00.000Z",
  visitId: null, ...over,
});

describe("ترقيم FDI", () => {
  it("اثنان وثلاثون سنًّا دائمًا وعشرون لبنيًّا", () => {
    expect(PERMANENT_UPPER).toHaveLength(16);
    expect(PERMANENT_LOWER).toHaveLength(16);
    expect(ALL_TEETH).toHaveLength(52);
    expect(new Set(ALL_TEETH).size).toBe(52);
  });

  it("يرفض الأرقام التي ليست أسنانًا", () => {
    expect(isValidTooth(16)).toBe(true);
    expect(isValidTooth(19)).toBe(false);
    expect(isValidTooth(10)).toBe(false);
    expect(isValidTooth(99)).toBe(false);
  });

  it("يميّز اللبني عن الدائم", () => {
    expect(isPrimary(55)).toBe(true);
    expect(isPrimary(85)).toBe(true);
    expect(isPrimary(15)).toBe(false);
  });

  it("يسمّي السن بالعربية — «16» وحده لا يُقرأ في تقرير للمريض", () => {
    expect(toothName(16)).toBe("الرحى الأولى العلوي الأيمن");
    expect(toothName(31)).toBe("القاطع الأوسط السفلي الأيسر");
    expect(toothName(53)).toBe("الناب العلوي الأيمن (لبني)");
  });
});

describe("بناء المخطط", () => {
  it("الحالة السارية آخر قائم أو منجَز — لا آخر سطر", () => {
    // خطةٌ سُجّلت اليوم لا تعني أن السن صار تاجًا.
    const chart = buildChart([
      record({ id: 1, condition: "caries", stage: "existing", recordedAt: "2026-08-01T09:00:00.000Z" }),
      record({ id: 2, condition: "crown", stage: "planned", recordedAt: "2026-08-02T09:00:00.000Z" }),
    ]);
    expect(chart.get(16)?.current?.condition).toBe("caries");
    expect(chart.get(16)?.planned).toHaveLength(1);
  });

  it("إنجاز المخطَّط يشطب الخطة — وإلا عُمل العمل مرتين وفُوتر مرتين", () => {
    const chart = buildChart([
      record({ id: 1, condition: "crown", stage: "planned", recordedAt: "2026-08-01T09:00:00.000Z" }),
      record({ id: 2, condition: "crown", stage: "completed", recordedAt: "2026-08-05T09:00:00.000Z" }),
    ]);
    expect(chart.get(16)?.planned).toHaveLength(0);
    expect(chart.get(16)?.current?.condition).toBe("crown");
  });

  it("لا يشطب خطةً مختلفة عن المنجَز", () => {
    const chart = buildChart([
      record({ id: 1, condition: "rct", stage: "planned", recordedAt: "2026-08-01T09:00:00.000Z" }),
      record({ id: 2, condition: "filling", stage: "completed", recordedAt: "2026-08-05T09:00:00.000Z" }),
    ]);
    expect(chart.get(16)?.planned.map((p) => p.condition)).toEqual(["rct"]);
  });

  it("يعرف السن الغائب", () => {
    const chart = buildChart([record({ condition: "extracted", stage: "completed" })]);
    expect(chart.get(16)?.absent).toBe(true);
  });

  it("الترتيب بالتاريخ لا بترتيب الوصول", () => {
    const chart = buildChart([
      record({ id: 2, condition: "filling", stage: "completed", recordedAt: "2026-08-05T09:00:00.000Z" }),
      record({ id: 1, condition: "caries", stage: "existing", recordedAt: "2026-08-01T09:00:00.000Z" }),
    ]);
    expect(chart.get(16)?.current?.condition).toBe("filling");
  });

  it("يلخّص المخطط بدل عدّ الأسنان بالعين", () => {
    const summary = chartSummary(buildChart([
      record({ id: 1, toothCode: 16, condition: "caries", stage: "existing" }),
      record({ id: 2, toothCode: 26, condition: "caries", stage: "existing" }),
      record({ id: 3, toothCode: 36, condition: "crown", stage: "planned" }),
      record({ id: 4, toothCode: 46, condition: "extracted", stage: "completed" }),
    ]));
    expect(summary).toEqual({ charted: 4, caries: 2, planned: 1, completed: 1, absent: 1 });
  });
});

describe("أسطح السن", () => {
  it("يرتّبها بالترتيب المتعارف عليه لا بترتيب الكتابة", () => {
    expect(normalizeSurfaces("do")).toBe("DO");
    expect(normalizeSurfaces("odm")).toBe("MDO");
  });

  it("يحذف المكرّر وغير المعروف", () => {
    expect(normalizeSurfaces("MMOZ")).toBe("MO");
    expect(normalizeSurfaces("xyz")).toBeNull();
    expect(normalizeSurfaces(null)).toBeNull();
  });
});

describe("الترقيم العالمي Universal Dental Numbering System", () => {
  it("يحول أرقام FDI الدائمة إلى Universal (1-32)", () => {
    expect(toUniversal(18)).toBe("1");
    expect(toUniversal(11)).toBe("8");
    expect(toUniversal(21)).toBe("9");
    expect(toUniversal(28)).toBe("16");
    expect(toUniversal(38)).toBe("17");
    expect(toUniversal(31)).toBe("24");
    expect(toUniversal(41)).toBe("25");
    expect(toUniversal(48)).toBe("32");
  });

  it("يحول أسنان الأطفال اللبنية إلى Universal (A-T)", () => {
    expect(toUniversal(55)).toBe("A");
    expect(toUniversal(51)).toBe("E");
    expect(toUniversal(61)).toBe("F");
    expect(toUniversal(65)).toBe("J");
    expect(toUniversal(75)).toBe("K");
    expect(toUniversal(71)).toBe("O");
    expect(toUniversal(81)).toBe("P");
    expect(toUniversal(85)).toBe("T");
  });
});

describe("فحص اللثة والجيوب السنية (Perio Assessment)", () => {
  it("يحسب نسبة النزف والجيوب العميقة ويصنف الحالة بدقة", () => {
    const mockRecord: ToothPerioRecord = {
      toothCode: 16,
      facial: [
        { depth: 2, bleeding: false },
        { depth: 3, bleeding: false },
        { depth: 5, bleeding: true },
      ],
      lingual: [
        { depth: 2, bleeding: false },
        { depth: 3, bleeding: false },
        { depth: 3, bleeding: false },
      ],
    };
    const summary = calculatePerioAssessment([mockRecord]);
    expect(summary.totalSites).toBe(6);
    expect(summary.bleedingSites).toBe(1);
    expect(summary.bopPercentage).toBe(17);
    expect(summary.deepPocketsCount).toBe(1);
    expect(summary.severity).toBe("moderate_periodontitis");
  });
});


