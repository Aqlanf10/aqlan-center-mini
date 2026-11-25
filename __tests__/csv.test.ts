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

describe("spreadsheet formula boundary", () => {
  it.each(["=1+1", "+1+2", "-1+2", "@SUM(1)", "  =1+1", "\ttext", "\rtext", "\ntext", "\u200b=1+1", "＝1+1", "＋1+1", "－1+1", "＠SUM(1)", "-42\n"])("literalizes unsafe text %j", (value) => {
    const literal = "'" + value;
    const escaped = /[",\n\r]/.test(literal) ? '"' + literal.replace(/"/g, '""') + '"' : literal;
    expect(csvCell(value)).toBe(escaped);
  });

  it("keeps negative numbers and PostgreSQL numeric strings numeric", () => {
    expect(csvRow([-25, "-25", "-25.50", -1e21, 0])).toBe("-25,-25,-25.50,-1e+21,0");
  });

  it("escapes separators and quotes after neutralizing formula-like text", () => {
    expect(csvCell('=SUM(1,2)')).toBe('"\'=SUM(1,2)"');
    expect(csvCell('=1+"2"')).toBe('"\'=1+""2"""');
    expect(csvFile(["البيان"], [["=1+1"]])).toBe("\ufeffالبيان\r\n'=1+1\r\n");
  });
});
