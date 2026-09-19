import { describe, expect, it } from "vitest";
import {
  CASH_ACCOUNT,
  invoiceEntry,
  paymentEntry,
  expenseEntry,
  trialBalance,
  type JournalEntry,
} from "../lib/accounting";
import type { Visit } from "../lib/flow";
import {
  chairOccupancy,
  collectionsFromBalances,
  executiveCsv,
  executiveKpis,
  periodRange,
  splitPeriod,
} from "../lib/executive";

/**
 * غرفة القيادة — اختبارات.
 *
 * الجوهر هنا معيار قبول المرحلة: **مطابقة أرقام لوحة القيادة مع مراجعها
 * المصرَّح بها 100%** (P-01 owner review — تصحيح ١): الفواتير والذمم من
 * نماذج القراءة القانونية لكل عملة (تُمرَّر كما يمررها محرك التقارير)،
 * والصندوق والمصروفات والذمم الدائنة من الدفاتر — قيودها أساسية خالصة.
 * فلا يُبنى أي رقم مالي في الاختبار إلا من مصدره نفسه، ثم يُقارن بما تُخرجه
 * المؤشرات. لو افترق الرقمان فالخطأ في المؤشرات لا في المراجع.
 */

const FROM = "2026-07-01";
const TO = "2026-07-31";

function buildBooks(): JournalEntry[] {
  // فاتورة يوليو: 100,000 بخصم 20,000 — قيدها: مدين ذمم 80,000 + مدين خصم 20,000، دائن إيراد 100,000.
  const julyInvoice = invoiceEntry({
    invoiceNumber: "INV-J1", date: "2026-07-10", patientName: "عبدالله",
    totalMinor: 100_000, discountMinor: 20_000, cancelled: false,
  })!;
  // تحصيل يوليو باليمني.
  const julyPayment = paymentEntry({
    receiptNumber: "R-J1", date: "2026-07-12", patientName: "عبدالله",
    currency: "YER", baseAmountMinor: 30_000, kind: "payment",
  })!;
  // مصروف يوليو — مواد.
  const julyExpense = expenseEntry({
    voucherNumber: "EV-J1", date: "2026-07-15", payeeName: "مورد",
    category: "materials", currency: "YER", baseAmountMinor: 10_000,
    settlesPayable: false,
  })!;
  // فاتورة يونيو — خارج الفترة، تظهر في التراكمي وحده.
  const juneInvoice = invoiceEntry({
    invoiceNumber: "INV-N1", date: "2026-06-20", patientName: "سعيد",
    totalMinor: 50_000, discountMinor: 0, cancelled: false,
  })!;
  return [juneInvoice, julyInvoice, julyPayment, julyExpense];
}

/** (تصحيح ١) نماذج القراءة القانونية كما يمررها محرك التقارير للفترة نفسها. */
function canonicalReadModels() {
  return {
    // يوليو: فاتورة واحدة 100,000 بخصم 20,000 (صافي 80,000) باليمني،
    // وسعودي 2,000، ودولار 300 — ثلاثة دلول منفصلة لا رقمًا واحدًا.
    billingByCurrency: [
      { currency: "YER" as const, grossMinor: 100_000, discountMinor: 20_000, netMinor: 80_000 },
      { currency: "SAR" as const, grossMinor: 2_000, discountMinor: 0, netMinor: 2_000 },
      { currency: "USD" as const, grossMinor: 300, discountMinor: 0, netMinor: 300 },
    ],
    // الذمم حتى نهاية يوليو بدلائل عملاتها: يمني 100,000 وسعودي 2,000 ودولار 300.
    receivableByCurrency: [
      { currency: "YER" as const, dueMinor: 100_000 },
      { currency: "SAR" as const, dueMinor: 2_000 },
      { currency: "USD" as const, dueMinor: 300 },
    ],
  };
}

function visit(partial: Partial<Visit> & { id: number }): Visit {
  return {
    patientName: "مريض", patientPhone: null, note: null, status: "done",
    chair: 1, arrivedAt: "2026-07-10T06:00:00.000Z",
    seatedAt: null, calledAt: null, finishedAt: null, patientId: 1,
    ...partial,
  };
}

describe("فصل الفترة عن التراكمي", () => {
  it("قيود ما قبل الفترة لا تدخل ميزان الفترة", () => {
    const books = buildBooks();
    const period = splitPeriod(books, FROM);
    expect(period.every((entry) => entry.date >= FROM)).toBe(true);
    expect(period).toHaveLength(3);
  });

  it("فواتير الفترة وذممها من المرجع القانوني، والمصروفات من ميزان الفترة وحده", () => {
    const books = buildBooks();
    const periodBalances = trialBalance(splitPeriod(books, FROM));
    const kpis = executiveKpis({
      from: FROM, to: TO,
      baseCurrency: "YER",
      ...canonicalReadModels(),
      periodBalances,
      cumulativeBalances: trialBalance(books),
      parties: [],
      operational: { newPatients: 3, totalPatients: 40 },
      occupancy: chairOccupancy([], { chairs: 2, dayStart: "09:00", dayEnd: "21:00", activeDays: 0 }),
    });
    // (تصحيح ١) فواتير الفترة لكل عملة — كما مرّرها المرجع القانوني حرفيًا.
    expect(kpis.billingByCurrency).toEqual(canonicalReadModels().billingByCurrency);
    // المصروفات من ميزان الفترة (يوليو وحده): 10,000 مواد.
    expect(kpis.totalExpensesMinor).toBe(10_000);
    // الذمم لكل عملة من المرجع القانوني حرفيًا — بلا رقم دفترٍ ممزوج.
    expect(kpis.receivableByCurrency).toEqual(canonicalReadModels().receivableByCurrency);
  });
});

describe("المطابقة مع المراجع المصرَّح بها — معيار القبول (تصحيح ١)", () => {
  it("المصروف والتحصيل والذمم الدائنة أرقام ميزان حصرًا، والفواتير والذمم من المرجع القانوني", () => {
    const books = buildBooks();
    const periodBalances = trialBalance(splitPeriod(books, FROM));

    const kpis = executiveKpis({
      from: FROM, to: TO,
      baseCurrency: "YER",
      ...canonicalReadModels(),
      periodBalances, cumulativeBalances: trialBalance(books),
      parties: [{ kind: "lab", label: "مختبر النور", dueMinor: 5_000 }],
      operational: {},
      occupancy: chairOccupancy([], { chairs: 2, dayStart: "09:00", dayEnd: "21:00", activeDays: 20 }),
    });

    // المصروف من الدفاتر مباشرة — نفس ما تعيده شاشة المحاسبة (أساس خالص).
    const materialsInBooks = periodBalances.find((row) => row.code === "5201")!.balanceMinor;
    expect(kpis.expenses.find((row) => row.code === "5201")!.amountMinor).toBe(materialsInBooks);
    // التحصيل = مدين النقدية اليمنية في ميزان الفترة.
    const cashDebit = periodBalances.find((row) => row.code === CASH_ACCOUNT.YER)!.debitMinor;
    expect(kpis.collections.find((row) => row.currency === "YER")!.collectedMinor).toBe(cashDebit);
    // ميزان القيود المزدوجة يوازن دائمًا — والرقم الذي لا يوازن لا يدخل الدفاتر أصلًا.
    const totalDebit = periodBalances.reduce((sum, row) => sum + row.debitMinor, 0);
    const totalCredit = periodBalances.reduce((sum, row) => sum + row.creditMinor, 0);
    expect(totalDebit).toBe(totalCredit);
  });

  it("لا عددَ ماليًّا ممزوجًا في العقد — فواتير وذمم بعملتها فقط (تصحيح ١)", () => {
    const kpis = executiveKpis({
      from: FROM, to: TO,
      baseCurrency: "YER",
      ...canonicalReadModels(),
      periodBalances: trialBalance(splitPeriod(buildBooks(), FROM)),
      cumulativeBalances: trialBalance(buildBooks()),
      parties: [],
      operational: {},
      occupancy: chairOccupancy([], { chairs: 2, dayStart: "09:00", dayEnd: "21:00", activeDays: 0 }),
    });
    // العقد الجديد لا يحمل أصلًا عددًا واحدًا للإيراد أو الذمم (حُذفا).
    expect("receivableMinor" in kpis).toBe(false);
    expect("income" in kpis).toBe(false);
    expect("netProfitMinor" in kpis).toBe(false);
    // ثلاثة دلول فواتير وثلاثة دلول ذمم — كلٌّ بعملته، بلا أي جمع عابر.
    expect(kpis.billingByCurrency.map((row) => row.currency)).toEqual(["YER", "SAR", "USD"]);
    expect(kpis.receivableByCurrency.map((row) => row.currency)).toEqual(["YER", "SAR", "USD"]);
    // 102,300 (مجموع ممزوج) لا وجود له كرقمٍ واحدٍ في الكائن.
    expect(JSON.stringify(kpis)).not.toContain("102300");
  });

  it("حركة الصندوق لكل عملة: دخلًا وخروجًا وصافيًا", () => {
    const balances = collectionsFromBalances(trialBalance(splitPeriod(buildBooks(), FROM)));
    const yer = balances.find((row) => row.currency === "YER")!;
    expect(yer.collectedMinor).toBe(30_000);
    // المصروف نقدًا يخرج من الصندوق.
    expect(yer.paidOutMinor).toBe(10_000);
    expect(yer.netMinor).toBe(20_000);
    // عملات بلا حركة تظهر بأصفار — لا تغيب عن الجدول.
    expect(balances.find((row) => row.currency === "USD")!.collectedMinor).toBe(0);
  });
});

describe("الإشغال", () => {
  const CAP = 12 * 60; // 09:00 → 21:00

  it("دقائق الشغل من الجلوس إلى الانتهاء، والسعة على أيام العمل الفعلية", () => {
    const visits = [
      visit({ id: 1, seatedAt: "2026-07-10T07:00:00.000Z", finishedAt: "2026-07-10T08:00:00.000Z" }),
      visit({ id: 2, chair: 2, seatedAt: "2026-07-10T07:00:00.000Z", finishedAt: "2026-07-10T07:30:00.000Z" }),
    ];
    const occupancy = chairOccupancy(visits, { chairs: 2, dayStart: "09:00", dayEnd: "21:00", activeDays: 2 });
    expect(occupancy.occupiedMinutes).toBe(60 + 30);
    expect(occupancy.capacityMinutes).toBe(2 * 2 * CAP);
    expect(occupancy.pct).toBe(Math.round((90 * 100) / (4 * CAP)));
  });

  it("زيارة بلا جلوس أو بلا انتهاء لا تُحسب، والشاذ يُسقَّف بطول اليوم", () => {
    const visits = [
      visit({ id: 1, status: "waiting", seatedAt: null, finishedAt: null }),
      visit({ id: 2, chair: null, seatedAt: "2026-07-10T07:00:00.000Z", finishedAt: "2026-07-10T08:00:00.000Z" }),
      visit({ id: 3, seatedAt: "2026-07-11T06:00:00.000Z", finishedAt: "2026-07-12T06:00:00.000Z" }),
    ];
    const occupancy = chairOccupancy(visits, { chairs: 2, dayStart: "09:00", dayEnd: "21:00", activeDays: 5 });
    expect(occupancy.occupiedMinutes).toBe(CAP);
    expect(occupancy.pct).toBe(Math.round((CAP * 100) / (2 * 5 * CAP)));
  });

  it("صفر سعة يعطي صفرًا لا نهايةً بالمئة", () => {
    const occupancy = chairOccupancy([], { chairs: 2, dayStart: "09:00", dayEnd: "21:00", activeDays: 0 });
    expect(occupancy.pct).toBe(0);
  });
});

describe("مركز التقارير الموحّد — CSV", () => {
  it("الملف يُسطّر الكائن نفسه — لا استعلام ثانٍ ولا إعادة حساب", () => {
    const books = buildBooks();
    const kpis = executiveKpis({
      from: FROM, to: TO,
      baseCurrency: "YER",
      ...canonicalReadModels(),
      periodBalances: trialBalance(splitPeriod(books, FROM)),
      cumulativeBalances: trialBalance(books),
      parties: [{ kind: "lab", label: "مختبر النور", dueMinor: 5_000 }],
      operational: { arrived: 9, done: 7, stillOpen: 2, noShow: 1, cancelled: 0, newPatients: 3, totalPatients: 40, orthoActive: 6, orthoTotal: 11, inventoryAlerts: 2 },
      occupancy: chairOccupancy([], { chairs: 2, dayStart: "09:00", dayEnd: "21:00", activeDays: 20 }),
    });

    const csv = executiveCsv(kpis);
    // كل رقم مالي في الكائن يظهر في الملف بنفس قيمته الصغرى — بعملته المصرَّحة.
    for (const row of kpis.billingByCurrency) {
      for (const value of [row.grossMinor, row.discountMinor, row.netMinor]) {
        expect(csv).toContain(`,${value}`);
      }
    }
    for (const row of kpis.receivableByCurrency) {
      expect(csv).toContain(`,${row.dueMinor}`);
    }
    for (const value of [kpis.totalExpensesMinor, kpis.payableMinor]) {
      expect(csv).toContain(`,${value}`);
    }
    // كل صف مالي يحمل عملته صراحة.
    for (const row of kpis.billingByCurrency) {
      expect(csv).toContain(`${row.currency},${row.netMinor}`);
    }
    // والتشغيلي كذلك.
    expect(csv).toContain(",9");
    expect(csv).toContain("مختبر النور");
    expect(csv).toContain(`نسبة الإشغال %,,${kpis.occupancy.pct}`);
  });
});

describe("نطاقات الفترة", () => {
  it("هذا الشهر والشهر الماضي والسنة — بتوقيت جهاز العيادة", () => {
    const today = new Date(2026, 7, 15); // 15 أغسطس 2026
    expect(periodRange("thisMonth", today)).toEqual({ from: "2026-08-01", to: "2026-08-15" });
    expect(periodRange("lastMonth", today)).toEqual({ from: "2026-07-01", to: "2026-07-31" });
    expect(periodRange("last3", today)).toEqual({ from: "2026-06-01", to: "2026-08-15" });
    expect(periodRange("thisYear", today)).toEqual({ from: "2026-01-01", to: "2026-08-15" });
    expect(periodRange("lastYear", today)).toEqual({ from: "2025-01-01", to: "2025-12-31" });
  });

  it("حدود الشهر المتقاطعة مع السنة تعمل", () => {
    const today = new Date(2027, 0, 3); // 3 يناير 2027
    expect(periodRange("lastMonth", today)).toEqual({ from: "2026-12-01", to: "2026-12-31" });
  });
});
