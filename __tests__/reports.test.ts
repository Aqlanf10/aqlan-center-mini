import { describe, expect, it } from "vitest";
import { balanceAt, classifyPayments, oldestUnpaid, resolvePeriod } from "../lib/reports";

/**
 * فحوص محرك التقارير — المنطق المحاسبي الخالص الذي لو أخطأ لظهر بعد شهر في
 * رصيد مريض. الفترة والحساب بالتواريخ الصريحة لا بتاريخ اليوم.
 */

describe("resolvePeriod", () => {
  it("يحلّ الفترة المخصصة كما هي إن كانت مرتبة", () => {
    const { from, to } = resolvePeriod("custom", "2026-01-10", "2026-02-20");
    expect(from).toBe("2026-01-10");
    expect(to).toBe("2026-02-20");
  });

  it("الفترة المخصصة المعكوسة تُستقيم لا أن تُرفض", () => {
    const { from, to } = resolvePeriod("custom", "2026-02-20", "2026-01-10");
    expect(from).toBe("2026-01-10");
    expect(to).toBe("2026-02-20");
  });

  it("الشهر الحالي: أول الشهر إلى آخره واليوم بينهما", () => {
    const { from, to } = resolvePeriod("this_month");
    expect(from.endsWith("-01")).toBe(true);
    expect(from.slice(0, 7)).toBe(to.slice(0, 7));
    const lastDay = new Date(Date.parse(`${to}T12:00:00Z`)).getUTCDate();
    expect(Number(to.slice(8))).toBe(lastDay);
  });

  it("الربع الحالي: ثلاثة أشهر كاملة تبدأ بشهر ربعي", () => {
    const { from, to } = resolvePeriod("this_quarter");
    const startMonth = Number(from.slice(5, 7));
    expect((startMonth - 1) % 3).toBe(0);
    const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
    expect(days).toBeGreaterThanOrEqual(90);
    expect(days).toBeLessThanOrEqual(92);
  });

  it("السنة الحالية: يناير إلى ديسمبر من سنة اليوم نفسها", () => {
    const { from, to } = resolvePeriod("this_year");
    expect(from.endsWith("-01-01")).toBe(true);
    expect(to.endsWith("-12-31")).toBe(true);
    expect(from.slice(0, 4)).toBe(to.slice(0, 4));
  });
});

const patient = {
  opening: { date: "2025-01-01", minor: 50_000 },
  invoices: [
    { date: "2026-05-01", netMinor: 300_000 },
    { date: "2026-06-01", netMinor: 100_000 },
  ],
  payments: [
    { date: "2026-05-01", baseMinor: 100_000, kind: "payment" },
    { date: "2026-06-15", baseMinor: 50_000, kind: "payment" },
  ],
};

describe("balanceAt", () => {
  it("قبل أي حركة: الرصيد الافتتاحي وحده (إن كان سابقًا)", () => {
    expect(balanceAt(patient, "2025-06-01")).toBe(50_000);
  });

  it("بعد فاتورة ودفعة: 50k + 300k − 100k = 250k", () => {
    expect(balanceAt(patient, "2026-05-02")).toBe(250_000);
  });

  it("في نهاية السجل: 50k + 400k − 150k = 300k", () => {
    expect(balanceAt(patient, "2026-12-31")).toBe(300_000);
  });

  it("الاسترداد يعكس الرصيد لا أن يُحذف", () => {
    const withRefund = {
      ...patient,
      payments: [...patient.payments, { date: "2026-07-01", baseMinor: 30_000, kind: "refund" }],
    };
    expect(balanceAt(withRefund, "2026-12-31")).toBe(330_000);
  });
});

describe("oldestUnpaid (FIFO)", () => {
  it("أقدم دين غير مغطّى: بعد تغطية الافتتاحي بأول دفعة", () => {
    // الدين القائم: افتتاحي 50k + فواتير 400k = 450k، والمسدد 150k.
    // FIFO: 50k الافتتاحي مغطّى كاملًا، وفاتورة مايو أول غير مغطّاة.
    const { date, ageDays } = oldestUnpaid(patient, "2026-06-30");
    expect(date).toBe("2026-05-01");
    expect(ageDays).toBe(60);
  });

  it("مسدّد بالكامل → لا دين قائمًا", () => {
    const settled = {
      opening: null,
      invoices: [{ date: "2026-05-01", netMinor: 100_000 }],
      payments: [{ date: "2026-05-02", baseMinor: 100_000, kind: "payment" }],
    };
    expect(oldestUnpaid(settled, "2026-12-31").date).toBeNull();
  });

  it("الفاتورة الأحدث هي الأقدم غير المغطّاة إذا سُدّد القديم", () => {
    const partial = {
      opening: null,
      invoices: [
        { date: "2026-05-01", netMinor: 100_000 },
        { date: "2026-06-01", netMinor: 100_000 },
      ],
      payments: [{ date: "2026-05-02", baseMinor: 100_000, kind: "payment" }],
    };
    expect(oldestUnpaid(partial, "2026-06-30").date).toBe("2026-06-01");
  });
});

describe("classifyPayments (FIFO: قديم ثم جديد)", () => {
  it("الدفعة تُغطّي رصيد ما قبل الفترة أولًا ثم الجديد", () => {
    // رصيد أول يونيو = 50k (افتتاحي؛ فاتورة 5 يونيو داخل الفترة).
    // دفعة 60k في 10 يونيو: 50k على القديم و10k على جديد.
    const classified = {
      opening: { date: "2025-01-01", minor: 50_000 },
      invoices: [{ date: "2026-06-05", netMinor: 100_000 }],
      payments: [{ date: "2026-06-10", baseMinor: 60_000, kind: "payment" }],
    };
    const result = classifyPayments(classified, "2026-06-01", "2026-06-30");
    expect(result.oldMinor).toBe(50_000);
    expect(result.newMinor).toBe(10_000);
  });

  it("فاتورة قبل بداية الفترة تجعل دفعة الفترة تحصيلًا قديمًا", () => {
    // فاتورة مايو 100k سابقة على فترة يونيو → دفعة يونيو كلها قديمة.
    const result = classifyPayments(patient, "2026-06-10", "2026-06-30");
    expect(result.oldMinor).toBe(50_000);
    expect(result.newMinor).toBe(0);
  });

  it("بلا رصيد سابق: كل الدفعة تحصيل جديد", () => {
    const fresh = {
      opening: null,
      invoices: [{ date: "2026-06-01", netMinor: 100_000 }],
      payments: [{ date: "2026-06-10", baseMinor: 40_000, kind: "payment" }],
    };
    const result = classifyPayments(fresh, "2026-06-01", "2026-06-30");
    expect(result.oldMinor).toBe(0);
    expect(result.newMinor).toBe(40_000);
  });

  it("الاسترداد يُخصم من الجديد أولًا", () => {
    const withRefund = {
      opening: null,
      invoices: [{ date: "2026-06-01", netMinor: 100_000 }],
      payments: [
        { date: "2026-06-10", baseMinor: 40_000, kind: "payment" },
        { date: "2026-06-20", baseMinor: 10_000, kind: "refund" },
      ],
    };
    const result = classifyPayments(withRefund, "2026-06-01", "2026-06-30");
    expect(result.newMinor).toBe(30_000);
    expect(result.oldMinor).toBe(0);
  });
});
