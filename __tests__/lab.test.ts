import { describe, expect, it } from "vitest";
import {
  daysLate,
  defaultDueDate,
  filterOrders,
  formatLabPrescriptionText,
  isDueToday,
  isOverdue,
  labFollowUpText,
  labPricingQuantity,
  labSummary,
  sortByUrgency,
  type LabOrder,
} from "../lib/lab";

const TODAY = "2026-08-27";

function order(over: Partial<LabOrder> & { id: number }): LabOrder {
  const base: LabOrder = {
    id: over.id,
    patientId: over.id,
    patientName: `مريض ${over.id}`,
    patientNumber: null,
    patientPhone: null,
    labName: "مختبر النور",
    labPhone: null,
    partyId: null,
    labServiceId: null,
    serviceName: null,
    workType: "تاج",
    details: null,
    toothNumbers: null,
    shade: null,
    stumpShade: null,
    priority: "normal",
    impressionType: "physical",
    sentDate: "2026-08-20",
    dueDate: "2026-08-27",
    status: "sent",
    receivedAt: null,
    deliveredAt: null,
    doctorId: null,
    doctorName: null,
    visitId: null,
    qualityCheck: "pending",
    qualityNotes: null,
    remakeOriginalId: null,
    remakeReason: null,
    technicianName: null,
    note: null,
    createdAt: "2026-08-20T08:00:00Z",
    costMinor: null,
    costCurrency: null,
    baseAmountMinor: null,
    financialStatus: "pending_delivery",
    payableId: null,
  };
  return Object.assign(base, over);
}

describe("تأخر أعمال المختبر", () => {
  it("يحسب أيام التأخير ويقرأ ما لم يحن موعده صفرًا لا رقمًا سالبًا", () => {
    expect(daysLate(order({ id: 1, dueDate: "2026-08-20" }), TODAY)).toBe(7);
    expect(daysLate(order({ id: 2, dueDate: "2026-08-27" }), TODAY)).toBe(0);
    // «متأخر ‎-3 أيام» جملة لا تعني شيئًا لمن يقرؤها بسرعة بين مريضين.
    expect(daysLate(order({ id: 3, dueDate: "2026-08-30" }), TODAY)).toBe(0);
  });

  it("لا يَعُدّ ما وصل أو رُكّب متأخرًا مهما مضى على موعده", () => {
    // العمل الذي وصل خرج من ذمّة المختبر؛ إبقاؤه في قائمة المتأخر يجعلها كذبًا يُتجاهل.
    expect(isOverdue(order({ id: 4, dueDate: "2026-07-01", status: "received" }), TODAY)).toBe(false);
    expect(isOverdue(order({ id: 5, dueDate: "2026-07-01", status: "delivered" }), TODAY)).toBe(false);
    expect(isOverdue(order({ id: 6, dueDate: "2026-07-01", status: "cancelled" }), TODAY)).toBe(false);
    expect(isOverdue(order({ id: 7, dueDate: "2026-07-01" }), TODAY)).toBe(true);
  });

  it("يميّز ما يستحق اليوم — الاتصال اليوم يمنع تأخر الغد", () => {
    expect(isDueToday(order({ id: 8, dueDate: TODAY }), TODAY)).toBe(true);
    expect(isDueToday(order({ id: 9, dueDate: "2026-08-26" }), TODAY)).toBe(false);
  });
});

describe("ترتيب القائمة وتصفيتها", () => {
  it("يضع الأكثر تأخّرًا أولًا لا الأحدث إرسالًا", () => {
    const orders = [
      order({ id: 1, sentDate: "2026-08-26", dueDate: "2026-09-26" }), // أُرسل أمس، مهلته شهر
      order({ id: 2, dueDate: "2026-08-20" }),                          // متأخر 7
      order({ id: 3, dueDate: "2026-08-25" }),                          // متأخر 2
    ];
    expect(sortByUrgency(orders, TODAY).map((o) => o.id)).toEqual([2, 3, 1]);
  });

  it("يصفّي حسب ما تحتاجه الاستقبال الآن", () => {
    const orders = [
      order({ id: 1, dueDate: "2026-08-20" }),
      order({ id: 2, status: "received" }),
      order({ id: 3, dueDate: "2026-09-10" }),
      order({ id: 4, status: "delivered" }),
    ];
    expect(filterOrders(orders, "late", TODAY).map((o) => o.id)).toEqual([1]);
    expect(filterOrders(orders, "outstanding", TODAY).map((o) => o.id)).toEqual([1, 3]);
    expect(filterOrders(orders, "received", TODAY).map((o) => o.id)).toEqual([2]);
    expect(filterOrders(orders, "all", TODAY)).toHaveLength(4);
  });

  it("فلتر «لم تُرسل بعد» يُظهر أعمال توقيع الزيارة قبل إرسالها للمختبر (§١٩)", () => {
    // طلبٌ ولّده توقيع الزيارة (needed) لا يُخلط مع ما عند المختبر ولا يُعد متأخرًا:
    // هو لم يغادر العيادة بعد — مكانه في تبويبه حتى يُرسل أو يُلغى.
    const orders = [
      order({ id: 1, status: "needed" as LabOrder["status"], dueDate: "2026-08-20" }),
      order({ id: 2, dueDate: "2026-08-20" }),
      order({ id: 3, status: "received" }),
    ];
    expect(filterOrders(orders, "pending", TODAY).map((o) => o.id)).toEqual([1]);
    // needed ليس «عند المختبر» ولا «متأخرًا»: مهلة العدّ تبدأ يوم إرساله فعلًا.
    expect(filterOrders(orders, "outstanding", TODAY).map((o) => o.id)).toEqual([2]);
    expect(filterOrders(orders, "late", TODAY).map((o) => o.id)).toEqual([2]);
  });

  it("يجمع أرقام اللوحة", () => {
    const summary = labSummary([
      order({ id: 1, dueDate: "2026-08-20" }),
      order({ id: 2, dueDate: TODAY }),
      order({ id: 3, dueDate: "2026-09-10" }),
      order({ id: 4, status: "received" }),
      order({ id: 5, status: "delivered" }),
    ], TODAY);
    expect(summary).toEqual({ outstanding: 3, late: 1, dueToday: 1, waitingFitting: 1 });
  });
});

describe("المهلة والرسائل", () => {
  it("يعطي مهلة افتراضية أسبوعًا من الإرسال", () => {
    expect(defaultDueDate("2026-08-27")).toBe("2026-09-03");
  });

  it("رسالة المتابعة تحمل التفاصيل التي تمنع مكالمة ثانية", () => {
    const text = labFollowUpText(
      order({ id: 1, patientName: "عبدالله سالم", dueDate: "2026-08-20", details: "6 علوي يمين" }),
      TODAY,
      "مركز الدكتور عقلان الكامل",
    );
    expect(text).toContain("عبدالله سالم");
    expect(text).toContain("تاج — 6 علوي يمين");
    expect(text).toContain("2026-08-20");
    expect(text).toContain("7 أيام");
  });

  it("رسالة عملٍ في موعده لا تتكلم عن تأخير", () => {
    const text = labFollowUpText(order({ id: 2, dueDate: "2026-09-05" }), TODAY, "المركز");
    expect(text).toContain("تأكيد الجاهزية");
    expect(text).not.toContain("مضى على الموعد");
  });

  it("يولد وصفة العمل المخبري السريرية (Prescription) خالية تماماً من المبالغ المالية", () => {
    const doc = formatLabPrescriptionText(
      {
        id: 101,
        patientId: 5,
        patientName: "سامي عبدالكريم",
        patientNumber: "P-1002",
        patientPhone: "777000111",
        labName: "مختبر الجزيرة لطب الأسنان",
        labPhone: "777123456",
        partyId: 12,
        labServiceId: 1,
        workType: "تاج زيركون كامل",
        details: "حواف زيركون مشطوبة بدقة عالية",
        toothNumbers: "11, 21",
        shade: "A2",
        stumpShade: "ND2",
        priority: "urgent",
        impressionType: "digital_scan",
        sentDate: "2026-08-27",
        dueDate: "2026-09-01",
        status: "sent",
        receivedAt: null,
        deliveredAt: null,
        doctorId: 3,
        doctorName: "د. فؤاد عقلان",
        visitId: 44,
        qualityCheck: "pending",
        qualityNotes: null,
        remakeOriginalId: null,
        remakeReason: null,
        technicianName: null,
        note: "يرجى مراعاة الإطباق الخلفي",
        createdAt: "2026-08-27T08:00:00Z",
      },
      "مركز عقلان لطب الأسنان",
      "777000000",
    );

    expect(doc).toContain("طلب عمل مخبري سني (LAB PRESCRIPTION)");
    expect(doc).toContain("سامي عبدالكريم");
    expect(doc).toContain("تاج زيركون كامل");
    expect(doc).toContain("11, 21");
    expect(doc).toContain("A2");
    expect(doc).toContain("ND2");
    expect(doc).toContain("د. فؤاد عقلان");
    expect(doc).toContain("مسح ضوئي رقمي");
    expect(doc).toContain("عاجل");
    // التحقق الصارم من عدم وجود أي مؤشرات أسعار أو عملات
    expect(doc).not.toContain("YER");
    expect(doc).not.toContain("SAR");
    expect(doc).not.toContain("USD");
    expect(doc).not.toContain("تكلفة");
    expect(doc).not.toContain("سعر");
  });
});

describe("كمية تسعير الإرسالية — سعر الوحدة × الأسنان", () => {
  it("خدمة السن المفرد: كل سن محدد وحدة كاملة (٣ أسنان × ٢٠ = ٦٠ لا ٢٠)", () => {
    // حكاية المالك: ثلاثة أسنان بسعر ٢٠ للسن — الجلب القديم كان يعبّي ٢٠ فقط.
    expect(labPricingQuantity("14, 15, 16", "single_tooth")).toBe(3);
    expect(labPricingQuantity("14(Abutment), 15(Pontic), 16(Abutment)", "single_tooth")).toBe(3);
    expect(labPricingQuantity("21", "single_tooth")).toBe(1);
  });

  it("الجسر يُسعَّر بالوحدة كالسن المفرد — الدعامات والدمى كلها وحدات", () => {
    expect(labPricingQuantity("14(Abutment), 15(Pontic), 16(Abutment)", "multi_teeth_bridge")).toBe(3);
    expect(labPricingQuantity("36, 37", "multi_teeth_bridge")).toBe(2);
  });

  it("القوس الكامل والعمل العام وحدة واحدة مهما عُدَّت الأسنان", () => {
    expect(labPricingQuantity("11, 12, 13, 14, 15, 16", "full_arch")).toBe(1);
    expect(labPricingQuantity("كل الفك العلوي", "full_arch")).toBe(1);
    expect(labPricingQuantity("14, 15", "general")).toBe(1);
    expect(labPricingQuantity("14, 15", null)).toBe(1);
  });

  it("لا أسنان محددة → وحدة واحدة (سعر العمل كما هو)", () => {
    expect(labPricingQuantity(null, "single_tooth")).toBe(1);
    expect(labPricingQuantity("", "multi_teeth_bridge")).toBe(1);
    expect(labPricingQuantity("   ", "single_tooth")).toBe(1);
  });

  it("نص غير قابل للتحليل لا يُفجّر التسعير — وحدة واحدة", () => {
    expect(labPricingQuantity("طقم كامل", "single_tooth")).toBe(1);
  });
});
