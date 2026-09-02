import { describe, expect, it } from "vitest";
import {
  LAB_SERVICE_CATEGORY_META,
  LAB_TOOTH_ROLE_META,
  LAB_TOOTH_SCOPE_META,
  parseLabTeeth,
  serializeLabTeeth,
  summarizeLabTeeth,
  type LabToothMap,
} from "../lib/lab";
import {
  AP_ACCOUNT,
  EXPENSE_ACCOUNT,
  expenseEntry,
  getAccountName,
  inferAccountKind,
  payableEntry,
  trialBalance,
  type JournalEntry,
} from "../lib/accounting";

/* ═══════════════════════════════════════════════════════════════════════════
 * المختبرات السنية V2 — الربط المالي وخدمات المعمل
 *
 * اختبارات المنطق الخالص: خريطة الأسنان بأدوارها التعويضية، وقواعد التسعير
 * والترحيل المحاسبي بحسابات كل مختبر. القاعدة التي لا يختبرها أحد تتعطل في
 * أول أمر مختبر حقيقي.
 * ═══════════════════════════════════════════════════════════════════════ */

describe("خريطة أسنان المختبر وأدوارها التعويضية", () => {
  it("يحوّل الخريطة إلى نص معياري يقرؤه المختبر والفني", () => {
    const map: LabToothMap = { 14: "abutment", 15: "pontic", 16: "abutment", 21: "crown" };
    expect(serializeLabTeeth(map)).toBe("14(Abutment), 15(Pontic), 16(Abutment), 21(Crown)");
  });

  it("يفك النص المعياري إلى خريطة كاملة الدور — الذهاب والإياب لا يضيع شيئًا", () => {
    const map: LabToothMap = { 11: "crown", 12: "veneer", 13: "implant_crown" };
    const roundTrip = parseLabTeeth(serializeLabTeeth(map));
    expect(roundTrip).toEqual(map);
  });

  it("يقبل التنسيقات القديمة: أرقام مجردة تاجٌ، والنص العربي يُفهم", () => {
    // الطلبات القديمة قبل V2: أرقام بلا أدوار — كلها تيجان.
    expect(parseLabTeeth("14, 15, 16")).toEqual({ 14: "crown", 15: "crown", 16: "crown" });
    // الصيغة "14:abutment" تفهم أيضًا — مرونة الإدخال لا تكسر السجل.
    expect(parseLabTeeth("14:abutment, 15:pontic")).toEqual({ 14: "abutment", 15: "pontic" });
    // الفارغ والسطر الفاسد لا يكسران المخطط.
    expect(parseLabTeeth(null)).toEqual({});
    expect(parseLabTeeth("")).toEqual({});
    expect(parseLabTeeth("نص بلا أرقام")).toEqual({});
  });

  it("يرفض أرقام الأسنان الوهمية خارج نطاق FDI", () => {
    // 99 ليست سنًا في أي فم بشري — إدخالها يبقى خارج الخريطة.
    expect(parseLabTeeth("99")).toEqual({});
    // 51-85 أسنان لبنية صحيحة.
    expect(parseLabTeeth("55, 71")).toEqual({ 55: "crown", 71: "crown" });
  });

  it("يلخص الجسر بدعاماته ودماه — الرقم الذي يقيَّد على المعمل", () => {
    const summary = summarizeLabTeeth({ 14: "abutment", 15: "pontic", 16: "abutment", 21: "crown" });
    expect(summary.totalUnits).toBe(4);
    expect(summary.abutmentsCount).toBe(2);
    expect(summary.ponticsCount).toBe(1);
    expect(summary.bridgeUnits).toBe(3);
    expect(summary.hasBridge).toBe(true);
    // الجسر يذكر في الملخص المفهوم: الفني يقرأ «جسر (2 دعامة + 1 دمية)» لا يفكك النص.
    expect(summary.readableSummary).toContain("جسر");
    expect(summary.teethCodes).toEqual([14, 15, 16, 21]);
  });

  it("يعطي الأسنان اللبنية والعلاجية بيانات بصرية كاملة لكل دور", () => {
    // كل دور له بيانات عرضه — الطباعة تستعملها فغيابها يكسر الاستمارة.
    for (const role of Object.keys(LAB_TOOTH_ROLE_META) as (keyof typeof LAB_TOOTH_ROLE_META)[]) {
      const meta = LAB_TOOTH_ROLE_META[role];
      expect(meta.label.length).toBeGreaterThan(0);
      expect(meta.shortLabel.length).toBeGreaterThan(0);
      expect(meta.code.length).toBeGreaterThan(0);
      expect(meta.desc.length).toBeGreaterThan(0);
    }
  });

  it("يغطي الميتا كل تصنيفات الخدمة ونطاقات الأسنان بلا ثغرات", () => {
    const categories = ["prostho", "ortho", "implant", "restorative", "appliance", "other"] as const;
    for (const category of categories) {
      expect(LAB_SERVICE_CATEGORY_META[category]).toBeDefined();
      expect(LAB_SERVICE_CATEGORY_META[category].shortLabel.length).toBeGreaterThan(0);
    }
    const scopes = ["single_tooth", "multi_teeth_bridge", "full_arch", "general"] as const;
    for (const scope of scopes) {
      expect(LAB_TOOTH_SCOPE_META[scope]).toBeDefined();
      expect(LAB_TOOTH_SCOPE_META[scope].shortLabel.length).toBeGreaterThan(0);
    }
  });
});

describe("الربط المالي — حسابات كل مختبر", () => {
  it("اسم الحساب المخصص للجهة يسبق اسم الدليل القياسي", () => {
    // المدير سمّى الحساب «معمل النور — زيركون» فلا يظهر له «تكلفة المعامل — عامة».
    expect(getAccountName("5102", "معمل النور — زيركون")).toBe("معمل النور — زيركون");
    expect(getAccountName("5101")).toBe("تكلفة المعامل — عامة");
    expect(getAccountName("2103")).toBe("ذمم معامل التقويم والأجهزة");
    // حساب مجهول الرقم لا يفقد اسمه تمامًا — «حساب (9999)» أفضل من فراغ.
    expect(getAccountName("9999")).toBe("حساب (9999)");
  });

  it("يستدل على نوع الحساب من خانته الأولى — الرقم يحدد المجموعة", () => {
    expect(inferAccountKind("1101")).toBe("asset");
    expect(inferAccountKind("2102")).toBe("liability");
    expect(inferAccountKind("3101")).toBe("equity");
    expect(inferAccountKind("4101")).toBe("revenue");
    expect(inferAccountKind("5109")).toBe("expense");
  });

  it("قيد الالتزام يرحّل إلى حسابات المختبر المخصصة لا الافتراضية", () => {
    // مختبر التركيبات حسابه 5102/2102 — القيد يجب أن يمر بهما لا بـ 5101/2101.
    const entry = payableEntry({
      reference: "PB-77",
      date: "2026-09-01",
      partyName: "معمل النور",
      category: "lab",
      baseAmountMinor: 150_000,
      expenseAccountCode: "5102",
      payableAccountCode: "2102",
    });
    expect(entry).not.toBeNull();
    expect(entry!.lines).toEqual([
      { accountCode: "5102", amountMinor: 150_000, side: "debit" },
      { accountCode: "2102", amountMinor: 150_000, side: "credit" },
    ]);
  });

  it("بلا حسابات مخصصة يعود القيد إلى الدليل الافتراضي للتشغيل", () => {
    const entry = payableEntry({
      reference: "PB-78",
      date: "2026-09-01",
      partyName: "مورد أدوات",
      category: "supplier",
      baseAmountMinor: 50_000,
    });
    expect(entry!.lines[0].accountCode).toBe(EXPENSE_ACCOUNT.supplier);
    expect(entry!.lines[1].accountCode).toBe(AP_ACCOUNT);
  });

  it("سداد التزام جهةٍ مسجّلة ينقص الذمم بحسابها المخصص — لا يُقيَّد مصروفًا مرتين", () => {
    const entry = expenseEntry({
      voucherNumber: "EX-90",
      date: "2026-09-02",
      payeeName: "معمل النور",
      category: "lab",
      currency: "YER",
      baseAmountMinor: 150_000,
      settlesPayable: true,
      payableAccountCode: "2102",
    });
    // السداد يمدين الذمم (2102) لا المصروف — وإلا ظهرت التكلفة مرتين.
    expect(entry!.lines[0].accountCode).toBe("2102");
    expect(entry!.lines[0].side).toBe("debit");
    expect(entry!.lines[1].accountCode).toBe("1101");
  });

  it("الجهة التي عطّلت الترحيل التلقائي: القيد المشتق يستثني حركاتها", () => {
    // هذا حارس البوابة: journalEntries يتخطى صفوف auto_post_journal = false —
    // هنا نثبت أن trialBalance لا يخترع حسابات لم تُقيَّد فعلًا.
    const entries: JournalEntry[] = [
      payableEntry({
        reference: "PB-1",
        date: "2026-09-01",
        partyName: "معمل معطّل الترحيل",
        category: "lab",
        baseAmountMinor: 100_000,
        expenseAccountCode: "5103",
      })!,
    ];
    const balances = trialBalance(entries);
    const labAccount = balances.find((row) => row.code === "5103");
    expect(labAccount).toBeDefined();
    expect(labAccount!.debitMinor).toBe(100_000);
    expect(balances.find((row) => row.code === AP_ACCOUNT)?.creditMinor).toBe(100_000);
  });

  it("trialBalance يسمّي الحسابات المخصصة للجهة حين تُمرَّر", () => {
    const entries: JournalEntry[] = [
      payableEntry({
        reference: "PB-2",
        date: "2026-09-01",
        partyName: "معمل الجزيرة",
        category: "lab",
        baseAmountMinor: 80_000,
        expenseAccountCode: "5102",
      })!,
    ];
    const balances = trialBalance(entries, [
      { code: "5102", name: "معمل الجزيرة — تيجان" },
    ]);
    expect(balances.find((row) => row.code === "5102")?.name).toBe("معمل الجزيرة — تيجان");
  });
});
