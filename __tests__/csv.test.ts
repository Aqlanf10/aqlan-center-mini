import { describe, expect, it } from "vitest";
import { csvCell, csvFile, csvRow } from "../lib/csv";

describe("تهيئة خلايا CSV", () => {
  it("تترك النص البسيط كما هو", () => {
    expect(csvCell("عبدالله")).toBe("عبدالله");
    expect(csvCell(12500)).toBe("12500");
  });

  it("تحمي الفاصلة والسطر الجديد وعلامة الاقتباس", () => {
    // ثلاثة أشياء تُفسد الملف صامتًا: فاصلة تقسم الخلية، وسطر يقسم الصف،
    // واقتباس ينهي الخلية في منتصفها.
    expect(csvCell("تاج, جسر")).toBe('"تاج, جسر"');
    expect(csvCell("سطر\nآخر")).toBe('"سطر\nآخر"');
    expect(csvCell('قال "مرحبًا"')).toBe('"قال ""مرحبًا"""');
  });

  it("تكتب الفراغ لما لا قيمة له", () => {
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
  });
});

describe("ملف CSV", () => {
  it("يبدأ بعلامة ترتيب البايتات فتقرأه Excel عربيًا", () => {
    // بلا BOM تظهر الحروف مشوّهة فيظنّ صاحب العيادة أن البيانات تلفت.
    const file = csvFile(["الاسم"], [["عبدالله"]]);
    expect(file.charCodeAt(0)).toBe(0xfeff);
  });

  it("يفصل الأسطر بـCRLF كما تتوقعه برامج الجداول", () => {
    const file = csvFile(["أ", "ب"], [[1, 2], [3, 4]]);
    expect(file).toBe("﻿أ,ب\r\n1,2\r\n3,4\r\n");
  });

  it("يكتب صفًّا فيه فاصلة بلا أن يكسر الأعمدة", () => {
    const row = csvRow(["تاج, جسر", 5]);
    expect(row.split('","').length).toBe(1);
    expect(row).toBe('"تاج, جسر",5');
  });
});
