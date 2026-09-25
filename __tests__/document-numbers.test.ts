import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DOCUMENT_PREFIX_DEFAULT, DOCUMENT_PREFIX_SETTING, documentNumberSql, documentPrefixProblem,
} from "@/lib/document-numbers";
import { SETTING_DEFAULTS } from "@/lib/settings";
import { settingDefinition } from "@/lib/settings-definitions";
import { validateSettingSet, validateTypedSetting } from "@/lib/settings-validate";

/** (P3-1) بادئات المستندات المالية — التحقق والحارس ضد عودة البادئة المكتوبة في الكود. */

describe("documentPrefixProblem", () => {
  it.each(["INV", "FAC", "R", "ABCDEF"])("تقبل %s", (value) => {
    expect(documentPrefixProblem(value)).toBeNull();
  });

  it.each(["", "inv", "IN2026", "ABCDEFG", "FA-C", "فا", " "])("ترفض «%s» برسالة عربية", (value) => {
    expect(documentPrefixProblem(value)).toContain("حروف لاتينية كبيرة");
  });

  it("المسافة الطرفية تُقصّ كما يقصّها الخادم قبل الحفظ", () => {
    expect(documentPrefixProblem(" FAC ")).toBeNull();
  });
});

describe("مفاتيح الإعدادات", () => {
  it("الافتراضي هو البادئة التاريخية نفسها — لا يتغيّر رقمٌ يوم النشر", () => {
    for (const kind of Object.keys(DOCUMENT_PREFIX_SETTING) as (keyof typeof DOCUMENT_PREFIX_SETTING)[]) {
      expect(SETTING_DEFAULTS[DOCUMENT_PREFIX_SETTING[kind]]).toBe(DOCUMENT_PREFIX_DEFAULT[kind]);
      const definition = settingDefinition(DOCUMENT_PREFIX_SETTING[kind]);
      expect(definition?.permission).toBe("settings.manage_finance");
      expect(definition?.requiresReason).toBe(true);
    }
  });

  it("الخادم يرفض بادئة فيها رقم أو حروف صغيرة", () => {
    expect(validateTypedSetting("documents.invoice_prefix", "IN2026")).toContain("بلا أرقام");
    expect(validateTypedSetting("documents.receipt_prefix", "rcp")).toContain("حروف لاتينية كبيرة");
    expect(validateTypedSetting("documents.voucher_prefix", "SRF")).toBeNull();
  });

  it("البادئات الأربع مختلفة — سند الصرف لا يشارك سند الإبطال بادئته", () => {
    const current = { ...SETTING_DEFAULTS };
    expect(validateSettingSet({ "documents.reversal_prefix": "V" }, current)).toContain("يجب أن تختلف");
    expect(validateSettingSet({ "documents.invoice_prefix": "R" }, current)).toContain("يجب أن تختلف");
    expect(validateSettingSet({ "documents.invoice_prefix": "FAC" }, current)).toBeNull();
  });
});

describe("documentNumberSql", () => {
  it("تقرأ البادئة من الإعدادات بنمطٍ محروس وتعود للافتراضي", () => {
    const sql = documentNumberSql("reversal");
    expect(sql).toContain("s.key = 'documents.reversal_prefix'");
    expect(sql).toContain("s.value ~ '^[A-Z]{1,6}$'");
    expect(sql).toContain("'X')");
    expect(sql).toContain("nextval('voucher_number_seq')");
  });

  it("حارس: لا بادئة مالية مكتوبة في SQL الإدراج بعد اليوم", () => {
    const source = readFileSync(path.resolve(__dirname, "../lib/db.ts"), "utf8");
    for (const literal of ["'INV-' ||", "'R-' ||", "'V-' ||", "'X-' ||"]) {
      expect(source).not.toContain(literal);
    }
    expect(source.match(/documentNumberSql\("/g)?.length).toBe(7);
  });
});
