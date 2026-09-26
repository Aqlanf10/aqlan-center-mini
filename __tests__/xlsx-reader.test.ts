import { readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { excelSerialToDate, readFirstSheet, rowsToCsv } from "../lib/xlsx-reader";

/** (P1-5c) The built-in xlsx reader on synthetic old-system exports (no real patients). */

const inflate = async (bytes: Uint8Array) => new Uint8Array(inflateRawSync(bytes));
const read = (name: string) => readFirstSheet(new Uint8Array(readFileSync(`__tests__/fixtures/${name}`)), inflate);

describe("readFirstSheet", () => {
  it("reads inline strings, numbers, blanks and date-styled serials", async () => {
    const rows = await read("old-treatments.xlsx");
    expect(rows[0].slice(0, 3)).toEqual(["رقم المعالجة", "تاريخ المعالجة", "المريض"]);
    expect(rows[1].slice(0, 7)).toEqual(["1", "2026-01-17", "سالم تجربة احمد", "دكتور تجربة", "تقويم اسنان", "2000", "ريال سعودي"]);
    expect(rows[5][5]).toBe("171.22");
    expect(rows[1][9]).toBe("");
    expect(rows).toHaveLength(6);
  });

  it("keeps the unnamed index column and phone numbers as written", async () => {
    const rows = await read("old-patients.xlsx");
    expect(rows[0][0]).toBe("");
    expect(rows[0][1]).toBe("اسم المريض");
    expect(rows[2][3]).toBe("7");
    expect(rows[3][3]).toBe("771000003 733000003");
  });

  it("refuses a file that is not an xlsx archive", async () => {
    await expect(readFirstSheet(new TextEncoder().encode("الاسم,الهاتف"), inflate)).rejects.toThrow("Excel");
  });

  it("converts Excel serials and writes CSV that the importer parses back", () => {
    expect(excelSerialToDate(46039)).toBe("2026-01-17");
    expect(rowsToCsv([["a,b", "x\"y"], ["1", ""]])).toBe("\"a,b\",\"x\"\"y\"\r\n1,");
  });
});
