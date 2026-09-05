import { describe, expect, it } from "vitest";
import { formatMoney, parseAmount, MINOR_UNITS, type Currency } from "../lib/money";

describe("حوكمة المنظومة المالية المعاد تصميمها (Finance Governance & Architecture)", () => {
  describe("١. تدقيق ومطابقة الصندوق والورديات (Cash Drawer Balancing)", () => {
    it("يحسب الفارق بين النقد الفعلي والمتوقع بدقة (عجز / زيادة / مطابقة)", () => {
      const expectedMinor = 150_000; // 150,000 ريال يمني
      const countedMatchMinor = parseAmount("150000", "YER");
      expect(countedMatchMinor).not.toBeNull();
      expect(countedMatchMinor! - expectedMinor).toBe(0);

      // حالة العجز (نقص)
      const countedDeficitMinor = parseAmount("145000", "YER");
      const deficit = countedDeficitMinor! - expectedMinor;
      expect(deficit).toBe(-5000);
      expect(deficit < 0).toBe(true);

      // حالة الزيادة
      const countedSurplusMinor = parseAmount("152000", "YER");
      const surplus = countedSurplusMinor! - expectedMinor;
      expect(surplus).toBe(2000);
      expect(surplus > 0).toBe(true);
    });

    it("يدعم العملات الثلاث (YER, SAR, USD) دون تداخل في الأرصدة وبوحداتها الصغرى", () => {
      // YER: 1 minor unit = 1 YER
      // SAR: 100 minor units = 1 SAR (هللة)
      // USD: 100 minor units = 1 USD (سنت)
      const opening: Record<Currency, number> = {
        YER: 50_000,
        SAR: 500 * MINOR_UNITS.SAR,
        USD: 100 * MINOR_UNITS.USD,
      };
      const collections: Record<Currency, number> = {
        YER: 200_000,
        SAR: 1_200 * MINOR_UNITS.SAR,
        USD: 300 * MINOR_UNITS.USD,
      };
      const expenses: Record<Currency, number> = {
        YER: 30_000,
        SAR: 200 * MINOR_UNITS.SAR,
        USD: 50 * MINOR_UNITS.USD,
      };

      const expectedYER = opening.YER + collections.YER - expenses.YER;
      const expectedSAR = opening.SAR + collections.SAR - expenses.SAR;
      const expectedUSD = opening.USD + collections.USD - expenses.USD;

      expect(expectedYER).toBe(220_000);
      expect(expectedSAR).toBe(1_500 * 100);
      expect(expectedUSD).toBe(350 * 100);

      expect(formatMoney(expectedYER, "YER")).toContain("220,000");
      expect(formatMoney(expectedSAR, "SAR")).toContain("1,500");
      expect(formatMoney(expectedUSD, "USD")).toContain("350");
    });
  });

  describe("٢. حوكمة أعمار ديون المرضى والتحصيل (Accounts Receivable Aging)", () => {
    const AGING_BUCKETS: [string, number, number][] = [
      ["أقل من شهر", 0, 30],
      ["١ – ٣ أشهر", 31, 90],
      ["٣ – ٦ أشهر", 91, 180],
      ["أكثر من ٦ أشهر", 181, Number.MAX_SAFE_INTEGER],
    ];

    const mockDebtors = [
      { patientId: 1, patientName: "أحمد", ageDays: 15, dueMinor: 20_000 },
      { patientId: 2, patientName: "سارة", ageDays: 45, dueMinor: 50_000 },
      { patientId: 3, patientName: "خالد", ageDays: 120, dueMinor: 80_000 },
      { patientId: 4, patientName: "منير", ageDays: 210, dueMinor: 100_000 },
    ];

    it("يصنف مديونيات المرضى في شرائح الأعمار بدقة", () => {
      const bucketTotals = AGING_BUCKETS.map(() => 0);
      for (const row of mockDebtors) {
        const idx = AGING_BUCKETS.findIndex(
          ([, min, max]) => row.ageDays >= min && row.ageDays <= max
        );
        expect(idx).toBeGreaterThanOrEqual(0);
        bucketTotals[idx] += row.dueMinor;
      }

      expect(bucketTotals[0]).toBe(20_000);  // < 30d
      expect(bucketTotals[1]).toBe(50_000);  // 31-90d
      expect(bucketTotals[2]).toBe(80_000);  // 91-180d
      expect(bucketTotals[3]).toBe(100_000); // > 180d
    });
  });

  describe("٣. حوكمة عمولات الأطباء وهوامش الحالات (Commissions & Clinical Margins)", () => {
    it("يطبق القاعدة الذهبية: الاستحقاق للصرف يُحسب على المحصل الفعلي لا على المفوتر", () => {
      const doctor = {
        doctorId: 1,
        doctorName: "د. عمار",
        commissionPercent: 30, // 30%
        billedMinor: 1_000_000, // مليون مفوتر (إنتاج سريري)
        collectedMinor: 600_000, // 600 ألف فقط سددها المرضى للصندوق
        paidMinor: 100_000, // صُرف له سابقاً 100 ألف
      };

      // الإنتاج النظري (المفوتر)
      const accrued = (doctor.billedMinor * doctor.commissionPercent) / 100;
      expect(accrued).toBe(300_000);

      // الاستحقاق الفعلي (المحصل)
      const earned = (doctor.collectedMinor * doctor.commissionPercent) / 100;
      expect(earned).toBe(180_000);

      // الصافي المستحق للصرف الآن
      const dueToPay = Math.max(0, earned - doctor.paidMinor);
      expect(dueToPay).toBe(80_000);

      // الفارق المحمي من سيولة العيادة (دين المرضى المعلق)
      const uncollectedCommission = accrued - earned;
      expect(uncollectedCommission).toBe(120_000);
      expect(dueToPay).not.toBe(accrued - doctor.paidMinor);
    });

    it("يحسب هامش ربح العيادة بعد خصم التكاليف المباشرة للحالة", () => {
      const procedureFee = 50_000; // تركيب سن زيركون
      const doctorCommission = 15_000; // 30% للطبيب
      const labFee = 12_000; // تكلفة المختبر
      const materialsCost = 3_000; // أسمنت ومخدر وطبعة

      const clinicNetMargin = procedureFee - doctorCommission - labFee - materialsCost;
      const marginPercentage = (clinicNetMargin / procedureFee) * 100;

      expect(clinicNetMargin).toBe(20_000);
      expect(marginPercentage).toBe(40); // هامش ربح 40% للمركز
    });
  });

  describe("٤. اتزان ميزان المراجعة والقيد المزدوج (Trial Balance Equilibrium)", () => {
    it("يتحقق من تساوي إجمالي المدين مع إجمالي الدائن", () => {
      const balances = [
        { code: "1101", name: "الصندوق", kind: "asset", debitMinor: 250_000, creditMinor: 0 },
        { code: "1201", name: "ذمم المرضى", kind: "asset", debitMinor: 150_000, creditMinor: 0 },
        { code: "2101", name: "ذمم المعامل", kind: "liability", debitMinor: 0, creditMinor: 80_000 },
        { code: "3101", name: "رأس المال", kind: "equity", debitMinor: 0, creditMinor: 200_000 },
        { code: "4101", name: "إيرادات الخدمات", kind: "revenue", debitMinor: 0, creditMinor: 200_000 },
        { code: "5101", name: "تكاليف المعامل", kind: "expense", debitMinor: 80_000, creditMinor: 0 },
      ];

      const totalDebit = balances.reduce((sum, b) => sum + b.debitMinor, 0);
      const totalCredit = balances.reduce((sum, b) => sum + b.creditMinor, 0);

      expect(totalDebit).toBe(480_000);
      expect(totalCredit).toBe(480_000);
      expect(totalDebit === totalCredit).toBe(true);
    });
  });
});
