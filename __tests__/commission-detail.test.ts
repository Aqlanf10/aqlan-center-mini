import { describe, expect, it } from "vitest";
import {
  buildCaseOverrideResolver,
  commissionForPatientAtEventTime,
  findServiceRate,
  resolveLegacyServiceRateNames,
  RULE_SOURCE_LABEL,
  type CaseOverrideRow,
  type CommissionDetailLine,
  type CommissionInvoice,
  type ServiceRateFinding,
} from "../lib/commission";
import { parseDoctorCommissionConfig } from "../lib/doctor-permissions";

/**
 * (COMM-DETAIL-1) المحرّك الواحد: مصبّ التفصيل، النسبة الخاصة بالحالة وقت الحدث،
 * مطابقة الخدمة بالمعرّف أو بالاسم التامّ، وحلّ القواعد القديمة بالاسم.
 */

const invoice = (over: Partial<CommissionInvoice> = {}): CommissionInvoice => ({
  id: 1, netMinor: 10000, currency: "YER", createdAt: "2024-01-01T09:00:00.000Z",
  doctorShares: [{ doctorId: 7, amountMinor: 10000, currency: "YER" }],
  ...over,
});

describe("F-5 — مطابقة الخدمة بالمعرّف، والاسم تامًّا فقط", () => {
  it("قاعدة «زراعة» بالاسم لا تمسّ «إزالة زراعة» (كانت «يحتوي»)", () => {
    const config = { customServiceRates: [{ id: "a", serviceName: "زراعة", percent: 45 }] };
    expect(findServiceRate(config, 10, "إزالة زراعة")).toBeUndefined();
    expect(findServiceRate(config, undefined, "زراعة سن")).toBeUndefined();
    expect(findServiceRate(config, 11, "زراعة")?.percent).toBe(45);
    // التطبيع: المسافات وصور التاء المربوطة لا تُسقط المطابقة التامّة.
    expect(findServiceRate(config, 11, "  زراعه ")?.percent).toBe(45);
  });

  it("قاعدة بمعرّف لا تطابق خدمةً أخرى بالاسم نفسه", () => {
    const config = { customServiceRates: [{ id: "a", serviceId: 5, serviceName: "زراعة", percent: 45 }], serviceRates: { "زراعة": 45, "5": 45 } };
    expect(findServiceRate(config, 5, "زراعة")?.percent).toBe(45);
    expect(findServiceRate(config, 9, "زراعة")).toBeUndefined();
    // بندٌ بلا معرّف (وصفٌ حرّ) يطابق بالاسم التامّ.
    expect(findServiceRate(config, undefined, "زراعة")?.percent).toBe(45);
  });

  it("الفهرس القديم وحده: مفتاح رقمي = معرّف، والاسم تامّ", () => {
    const config = { customServiceRates: [], serviceRates: { "7": 20, "تقويم": 35 } };
    expect(findServiceRate(config, 7, "أي شيء")?.percent).toBe(20);
    expect(findServiceRate(config, 8, "تقويم")?.percent).toBe(35);
    expect(findServiceRate(config, 8, "تقويم ثابت")).toBeUndefined();
  });

  it("حلّ الاسم القديم مرّةً: وحيدٌ ⇒ معرّف؛ ملتبس وغير محلول ⇒ يُبلَّغ", () => {
    const config = parseDoctorCommissionConfig({
      customServiceRates: [
        { id: "1", serviceName: "زراعة", percent: 45 },
        { id: "2", serviceName: "تنظيف", percent: 20 },
        { id: "3", serviceName: "تبييض قديم", percent: 15 },
      ],
    });
    const findings: ServiceRateFinding[] = [];
    const resolved = resolveLegacyServiceRateNames(config, [
      { id: 1, name: "زراعة" }, { id: 2, name: "إزالة زراعة" }, { id: 3, name: "تنظيف" }, { id: 4, name: "تنظيف " },
    ], 7, findings);
    expect(resolved.customServiceRates?.find((rule) => rule.id === "1")?.serviceId).toBe(1);
    expect(resolved.customServiceRates?.find((rule) => rule.id === "2")?.serviceId).toBeUndefined();
    expect(findings).toEqual([
      { doctorId: 7, ruleName: "تنظيف", percent: 20, status: "ambiguous", candidateServiceIds: [3, 4] },
      { doctorId: 7, ruleName: "تبييض قديم", percent: 15, status: "unresolved", candidateServiceIds: [] },
    ]);
    // بعد الحلّ: قاعدة «زراعة» صارت للخدمة 1 وحدها.
    expect(findServiceRate(resolved, 1, "زراعة")?.percent).toBe(45);
    expect(findServiceRate(resolved, 2, "إزالة زراعة")).toBeUndefined();
  });
});

describe("F-11 — المحلِّل: أحدث صفٍّ سريانه ≤ اللحظة، والإلغاء يُسقط", () => {
  const rows: CaseOverrideRow[] = [
    { id: 1, doctorId: 7, caseId: 3, planId: null, percent: 25, action: "set", effectiveFrom: "2024-02-01T00:00:00Z" },
    { id: 2, doctorId: 7, caseId: 3, planId: null, percent: 30, action: "set", effectiveFrom: "2024-03-01T00:00:00Z" },
    { id: 3, doctorId: 7, caseId: 3, planId: null, percent: null, action: "void", effectiveFrom: "2024-04-01T00:00:00Z" },
    { id: 4, doctorId: 7, caseId: null, planId: 9, percent: 40, action: "set", effectiveFrom: "2024-01-01T00:00:00Z" },
  ];
  const resolve = buildCaseOverrideResolver(rows);
  it("يتبع الزمن ولا يخلط الأطباء", () => {
    expect(resolve(7, { caseId: 3 }, "2024-01-15T00:00:00Z")).toBeUndefined();
    expect(resolve(7, { caseId: 3 }, "2024-02-15T00:00:00Z")).toEqual({ overrideId: 1, percent: 25 });
    expect(resolve(7, { caseId: 3 }, "2024-03-15T00:00:00Z")).toEqual({ overrideId: 2, percent: 30 });
    expect(resolve(7, { caseId: 3 }, "2024-05-01T00:00:00Z")).toBeUndefined();
    expect(resolve(8, { caseId: 3 }, "2024-03-15T00:00:00Z")).toBeUndefined();
  });
  it("الحالة أولى من الخطة؛ والإلغاء على الحالة يسقط إلى الخطة", () => {
    expect(resolve(7, { caseId: 3, planId: 9 }, "2024-02-15T00:00:00Z")?.overrideId).toBe(1);
    expect(resolve(7, { caseId: 3, planId: 9 }, "2024-05-01T00:00:00Z")?.overrideId).toBe(4);
    expect(resolve(7, { planId: 9 }, "2024-05-01T00:00:00Z")?.percent).toBe(40);
  });
});

describe("F-8 — مصبّ التفصيل من المحرّك نفسه", () => {
  it("السطور تجمع المجاميع حرفيًّا، والنسبة الخاصة تُحلّ وقت كل حدث", () => {
    const overrideAt = buildCaseOverrideResolver([
      { id: 11, doctorId: 7, caseId: 3, planId: null, percent: 50, action: "set", effectiveFrom: "2024-02-01T00:00:00Z" },
    ]);
    const lines: CommissionDetailLine[] = [];
    const invoices = [invoice({
      netMinor: 30000,
      doctorShares: [
        { doctorId: 7, amountMinor: 20000, currency: "YER", caseId: 3, labCostMinor: 3333 },
        { doctorId: 8, amountMinor: 10001, currency: "YER" },
      ],
    })];
    const result = commissionForPatientAtEventTime(
      invoices,
      [{ invoiceId: 1, amount: 10000, sourceTime: "2024-01-10T00:00:00Z" }, { invoiceId: 1, amount: 7777, sourceTime: "2024-02-10T00:00:00Z" }],
      () => ({ percent: 30, config: null }),
      undefined,
      { overrideAt, sink: (line) => lines.push(line) },
    );
    for (const doctorId of [7, 8]) {
      const mine = lines.filter((line) => line.doctorId === doctorId);
      expect(mine.reduce((sum, line) => sum + line.accruedMinor, 0)).toBe(result.get(doctorId)?.YER.accruedMinor);
      expect(mine.reduce((sum, line) => sum + line.earnedMinor, 0)).toBe(result.get(doctorId)?.YER.earnedMinor);
    }
    const seven = lines.find((line) => line.doctorId === 7)!;
    // وقت الفاتورة (يناير) قبل النسبة الخاصة ⇒ الافتراضي؛ دفعة فبراير بعدها ⇒ ٥٠٪.
    expect(seven.ruleSource).toBe("default");
    expect(seven.percent).toBe(30);
    expect(seven.labDeducted).toBe(true);
    expect(seven.baseMinor).toBe(16667);
    expect(seven.earnedParts.map((part) => [part.percent, part.ruleSources, part.overrideIds])).toEqual([
      [30, ["default"], []], [50, ["case_override"], [11]],
    ]);
    expect(RULE_SOURCE_LABEL[seven.earnedParts[1].ruleSources[0]]).toBe("نسبة خاصة بالحالة");
  });

  it("بلا نسبة خاصة ولا مصبّ ⇒ الأرقام نفسها حرفيًّا", () => {
    const invoices = [invoice({ netMinor: 33333, doctorShares: [{ doctorId: 7, amountMinor: 33333, currency: "YER", caseId: 3 }] })];
    const chunks = [{ invoiceId: 1, amount: 12345, sourceTime: "2024-02-01T00:00:00Z" }];
    const policy = () => ({ percent: 30, config: null });
    expect(commissionForPatientAtEventTime(invoices, chunks, policy, undefined, {
      overrideAt: buildCaseOverrideResolver([]), sink: () => undefined,
    })).toEqual(commissionForPatientAtEventTime(invoices, chunks, policy));
  });

  it("F-4 — تكلفة المواد تُخصم فقط حين تنصّ سياسة الطبيب", () => {
    const shares = [{ doctorId: 7, amountMinor: 10000, currency: "YER" as const, materialCostMinor: 2000 }];
    const chunks = [{ invoiceId: 1, amount: 10000, sourceTime: "2024-02-01T00:00:00Z" }];
    const on = parseDoctorCommissionConfig({ defaultPercent: 30, deductMaterialCost: true });
    const off = parseDoctorCommissionConfig({ defaultPercent: 30, deductMaterialCost: false });
    expect(commissionForPatientAtEventTime([invoice({ doctorShares: shares })], chunks, () => ({ percent: 0, config: on })).get(7)?.YER.earnedMinor).toBe(2400);
    expect(commissionForPatientAtEventTime([invoice({ doctorShares: shares })], chunks, () => ({ percent: 0, config: off })).get(7)?.YER.earnedMinor).toBe(3000);
  });
});
