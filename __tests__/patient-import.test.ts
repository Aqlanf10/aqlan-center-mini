import { describe, expect, it } from "vitest";
import {
  IMPORT_MAX_ROWS, classifyImportRows, importSummary, looksLikeBrokenEncoding, mapHeaders,
  normalizeImportDate, parseCsv,
} from "../lib/patient-import";
import type { CandidatePatient } from "../lib/duplicates";
import { parseAmount } from "../lib/money";

/**
 * (P1-5) استيراد مرضى المركز القديم — التحليل والتصنيف الخالصان.
 */

const TODAY = "2026-09-25";

const existing: CandidatePatient[] = [
  { id: 1, patientNumber: "P-00001", fullName: "علي حسن محمد", phone: "967777111222", altPhone: null, birthYear: 1990 },
  { id: 2, patientNumber: "P-00002", fullName: "فاطمة عبدالله سعيد", phone: null, altPhone: null, birthYear: 2001 },
  { id: 3, patientNumber: "P-00003", fullName: "خالد عمر ناصر", phone: null, altPhone: null, birthYear: 1985 },
];

describe("parseCsv", () => {
  it("strips the Excel BOM, honours quotes, escaped quotes and newlines inside a cell", () => {
    const rows = parseCsv("﻿الاسم,ملاحظات\r\n\"سالم, أحمد\",\"قال \"\"مرحبا\"\"\nسطر ثانٍ\"\r\n\r\n");
    expect(rows).toEqual([["الاسم", "ملاحظات"], ["سالم, أحمد", "قال \"مرحبا\"\nسطر ثانٍ"]]);
  });

  it("detects semicolon and tab delimiters (Excel in Arabic/European locales)", () => {
    expect(parseCsv("الاسم;الهاتف\nسالم;777")).toEqual([["الاسم", "الهاتف"], ["سالم", "777"]]);
    expect(parseCsv("الاسم\tالهاتف\nسالم\t777")).toEqual([["الاسم", "الهاتف"], ["سالم", "777"]]);
  });

  it("flags text decoded from a legacy Arabic code page", () => {
    expect(looksLikeBrokenEncoding("��,�")).toBe(true);
    expect(looksLikeBrokenEncoding("الاسم,الهاتف")).toBe(false);
  });
});

describe("mapHeaders", () => {
  it("maps Arabic and English aliases, ignores case/spacing/hamza, reports unknown columns", () => {
    const { mapping, unknown } = mapHeaders(["اسم المريض", "Phone", " رقم الملف ", "الرصيد", "لون المفضل", "إسم"]);
    expect(mapping).toMatchObject({ fullName: 0, phone: 1, legacyNumber: 2, openingBalance: 3 });
    expect(unknown).toContain("لون المفضل");
  });
});

describe("normalizeImportDate", () => {
  it("reads day/month/year as Excel writes it in Yemen, and Arabic-Indic digits", () => {
    expect(normalizeImportDate("15/03/2010")).toBe("2010-03-15");
    expect(normalizeImportDate("٥-٣-٢٠١٠")).toBe("2010-03-05");
    expect(normalizeImportDate("2010/3/5")).toBe("2010-03-05");
    expect(normalizeImportDate("")).toBe("");
  });
});

describe("classifyImportRows", () => {
  const header = ["الاسم", "الهاتف", "سنة الميلاد", "رقم الملف", "الرصيد", "العملة", "الجنس"];

  it("classifies new, duplicate by phone, duplicate by name+year, possible by name, in-file duplicate and invalid", () => {
    const { rows, problems } = classifyImportRows([
      header,
      ["سعيد ناجي", "771000001", "2000", "10", "15,000", "", "ذكر"],        // 2 new, YER balance
      ["علي حسن", "0777111222", "", "11", "", "", ""],                    // 3 phone → duplicate
      ["فاطمة عبد الله سعيد", "", "2001", "12", "", "", "أنثى"],           // 4 name+year → duplicate
      ["خالد عمر ناصر", "", "1999", "13", "", "", ""],                    // 5 same name, other year → possible
      ["سعيد ناجي", "+967 771 000 001", "", "14", "", "", ""],            // 6 same phone as line 2
      ["", "771000002", "", "15", "", "", ""],                            // 7 invalid: no name
      ["منى صالح", "771000003", "3000", "16", "", "", ""],                // 8 invalid year
      ["هدى صالح", "771000004", "", "17", "100", "دولار", ""],            // 9 USD balance stays USD
      ["ريم صالح", "771000005", "", "18", "100", "ين", ""],               // 10 unknown currency
    ], existing, TODAY);

    expect(problems).toEqual([]);
    const byLine = Object.fromEntries(rows.map((row) => [row.line, row]));
    expect(byLine[2]).toMatchObject({ status: "new", openingMinor: 15000, legacyNumber: "10" });
    expect(byLine[2].patient?.gender).toBe("male");
    expect(byLine[2].patient?.note).toContain("رقم الملف في النظام القديم: 10");
    expect(byLine[3]).toMatchObject({ status: "duplicate", matchedPatient: { id: 1 } });
    expect(byLine[4]).toMatchObject({ status: "duplicate", matchedPatient: { id: 2 } });
    expect(byLine[4].patient?.gender).toBe("female");
    expect(byLine[5]).toMatchObject({ status: "possible_duplicate", matchedPatient: { id: 3 } });
    expect(byLine[6]).toMatchObject({ status: "duplicate_in_file" });
    expect(byLine[6].reason).toContain("السطر 2");
    expect(byLine[7].status).toBe("invalid");
    expect(byLine[8].status).toBe("invalid");
    // (P1-5ب) الدولار يبقى دولارًا: رصيدٌ افتتاحي بعملته، لا تحويل ولا إدخال يدوي.
    expect(byLine[9]).toMatchObject({ status: "new", openingMinor: parseAmount("100", "USD"), openingCurrency: "USD" });
    expect(byLine[2]).toMatchObject({ openingCurrency: "YER" });
    expect(byLine[10].status).toBe("invalid");
    expect(byLine[10].reason).toContain("ين");

    expect(importSummary(rows)).toEqual({
      new: 2, duplicate: 2, possible_duplicate: 1, duplicate_in_file: 1, invalid: 3,
    });
  });

  it("refuses a file without a name column, an empty file, and an oversized batch", () => {
    expect(classifyImportRows([["الهاتف"], ["777"]], [], TODAY).problems[0]).toContain("الاسم");
    expect(classifyImportRows([["الاسم"]], [], TODAY).problems[0]).toContain("فارغ");
    const huge = [["الاسم"], ...Array.from({ length: IMPORT_MAX_ROWS + 1 }, (_, i) => [`مريض رقم ${i}`])];
    const result = classifyImportRows(huge, [], TODAY);
    expect(result.rows).toEqual([]);
    expect(result.problems[0]).toContain(String(IMPORT_MAX_ROWS));
  });

  it("still finds the duplicate among thousands of patients sharing a common first name", () => {
    const crowd: CandidatePatient[] = Array.from({ length: 20_000 }, (_, i) => ({
      id: 100 + i, patientNumber: `P-${i}`, fullName: `محمد مريض${i} الشرعبي`, phone: null, altPhone: null, birthYear: null,
    }));
    crowd.push({ id: 99_999, patientNumber: "P-X", fullName: "محمد عبده قاسم", phone: "967733000000", altPhone: null, birthYear: 1970 });
    const file = [["الاسم", "الهاتف"], ...Array.from({ length: 2000 }, (_, i) => [`محمد جديد${i} العبسي`, ""]), ["محمد عبده", "733000000"]];
    const started = Date.now();
    const { rows } = classifyImportRows(file, crowd, TODAY);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(rows.at(-1)).toMatchObject({ status: "duplicate", matchedPatient: { id: 99_999 } });
  });

  it("normalizes Arabic-Indic phone digits before matching (review)", () => {
    const { rows } = classifyImportRows([["الاسم", "الهاتف"], ["علي حسن محمد", "٧٧٧١١١٢٢٢"]], existing, TODAY);
    expect(rows[0]).toMatchObject({ status: "duplicate", matchedPatient: { id: 1 } });
    expect(rows[0].patient?.phone).toBe("777111222");
  });

  it("applies the same duplicate rules between rows of the file itself (review)", () => {
    const { rows } = classifyImportRows([
      ["الاسم", "الهاتف", "هاتف2", "سنة الميلاد"],
      ["سالم ناجي قائد", "771000010", "", "1995"],
      ["سالم ناجي قائد", "771000099", "", "1995"],          // same name + year, different phone
      ["نادر عبده سيف", "771000020", "", ""],
      ["نادر عبده", "771000077", "771000020", ""],          // similar name, shares the alt phone
    ], [], TODAY);
    expect(rows.map((row) => row.status)).toEqual(["new", "duplicate_in_file", "new", "duplicate_in_file"]);
    expect(rows[1].reason).toContain("السطر 2");
    expect(rows[3].reason).toContain("السطر 4");
  });
});

describe("old-system export (real column shapes)", () => {
  const header = ["", "اسم المريض", "رقم التقويم التسلسلي", "الهاتف", "ملاحظات", "هاتف2", "هاتف3", "رقم البطاقة"];

  it("maps هاتف2 / هاتف3 / ortho serial / card number, and keeps the unnamed index column out of the way", () => {
    const { mapping, unknown } = mapHeaders(header);
    expect(mapping).toMatchObject({ fullName: 1, orthoNumber: 2, phone: 3, note: 4, altPhone: 5, extraPhone: 6, nationalId: 7 });
    expect(unknown).toEqual([]);
  });

  it("family members sharing one phone are all imported — flagged, not skipped", () => {
    const { rows } = classifyImportRows([
      header,
      ["1", "احمد علي سيف", "0", "772579675", "", "", "", ""],
      ["2", "مريم علي سيف", "0", "772579675", "", "", "", ""],
    ], [{ id: 9, patientNumber: "P-9", fullName: "فاطمة علي سيف", phone: "967772579675", altPhone: null, birthYear: null }], TODAY);
    expect(rows.map((row) => row.status)).toEqual(["new", "new"]);
    expect(rows[0].reason).toContain("يشارك الهاتف");
  });

  it("drops junk phones like «7» into the note instead of matching every such row together", () => {
    const { rows } = classifyImportRows([
      header,
      ["1", "محمود العليمي", "0", "7", "", "", "", ""],
      ["2", "نبيل مكرم", "146", "7", "", "", "", ""],
      ["3", "زكريا اسماعيل احمد", "0", "772579675733111222", "", "", "", ""],
    ], [], TODAY);
    expect(rows.map((row) => row.status)).toEqual(["new", "new", "new"]);
    expect(rows[0].patient?.phone).toBeNull();
    expect(rows[0].patient?.note).toContain("هاتف غير مكتمل في النظام القديم: 7");
    expect(rows[1].patient?.note).toContain("رقم التقويم في النظام القديم: 146");
    expect(rows[0].patient?.note ?? "").not.toContain("رقم التقويم");
    // رقمان ملتصقان في خلية واحدة يُفصلان.
    expect(rows[2].patient).toMatchObject({ phone: "772579675", altPhone: "733111222" });
  });

  it("a parent's name inside a child's full name is not «similar», and one-word names match only exactly", () => {
    const { rows } = classifyImportRows([
      header,
      ["1", "محمد حمود", "0", "", "", "", "", ""],
      ["2", "امل محمد حمود", "0", "", "", "", "", ""],
      ["3", "مهيوب", "0", "", "", "", "", ""],
      ["4", "سعيد مهيوب قاسم", "0", "", "", "", "", ""],
      ["5", "فوزية حسن", "0", "", "", "", "", ""],
      ["6", "فوزية حسن عبده", "0", "", "", "", "", ""],
    ], [], TODAY);
    expect(rows.map((row) => row.status)).toEqual(["new", "new", "new", "new", "new", "possible_duplicate"]);
  });
});
