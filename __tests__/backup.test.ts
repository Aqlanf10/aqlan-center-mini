import { describe, expect, it } from "vitest";
import { insertStatement, insertionOrder, sequenceResets, sqlValue } from "../lib/backup";

describe("النسخة الاحتياطية", () => {
  it("يرتّب الجداول: المرجوع إليه قبل من يشير إليه", () => {
    const order = insertionOrder([
      { table: "payments", dependsOn: ["patients", "invoices"] },
      { table: "invoices", dependsOn: ["patients"] },
      { table: "patients", dependsOn: [] },
    ]);
    expect(order.indexOf("patients")).toBeLessThan(order.indexOf("invoices"));
    expect(order.indexOf("invoices")).toBeLessThan(order.indexOf("payments"));
  });

  it("يتجاهل مرجعًا إلى جدول غير مُصدَّر بدل أن يعلّق الترتيب", () => {
    const order = insertionOrder([
      { table: "a", dependsOn: ["جدول_غير_موجود"] },
      { table: "b", dependsOn: ["a"] },
    ]);
    expect(order).toEqual(["a", "b"]);
  });

  it("يكسر الدورة بدل الدوران إلى الأبد", () => {
    const order = insertionOrder([
      { table: "a", dependsOn: ["b"] },
      { table: "b", dependsOn: ["a"] },
    ]);
    expect(order.sort()).toEqual(["a", "b"]);
  });

  it("لا يوقفه المرجع الذاتي", () => {
    const order = insertionOrder([{ table: "a", dependsOn: ["a"] }]);
    expect(order).toEqual(["a"]);
  });

  it("يضعّف الفاصلة العليا في الأسماء العربية", () => {
    // اسمٌ فيه فاصلة عليا كان يكسر ملف النسخة كله فيصير غير قابل للاستعادة.
    expect(sqlValue("عبدالله'")).toBe("'عبدالله'''");
    expect(sqlValue("د. عقلان")).toBe("'د. عقلان'");
  });

  it("يكتب القيم الفارغة والمنطقية والأرقام كما هي لا كنصوص", () => {
    expect(sqlValue(null)).toBe("NULL");
    expect(sqlValue(undefined)).toBe("NULL");
    expect(sqlValue(true)).toBe("TRUE");
    expect(sqlValue(12500)).toBe("12500");
    expect(sqlValue(Number.NaN)).toBe("NULL");
  });

  it("يكتب التاريخ بصيغة قابلة للقراءة في أي منطقة زمنية", () => {
    expect(sqlValue(new Date("2026-08-28T01:30:00.000Z"))).toBe("'2026-08-28T01:30:00.000Z'");
  });

  it("يبني جملة إدراج بأعمدة مقتبسة", () => {
    expect(insertStatement("patients", ["id", "full_name"], { id: 3, full_name: "سعيد" }))
      .toBe(`INSERT INTO patients ("id", "full_name") VALUES (3, 'سعيد');`);
  });

  it("يعيد ضبط العدّادات — وإلا اصطدمت أول فاتورة جديدة برقم موجود", () => {
    const [reset] = sequenceResets(["invoices"]);
    expect(reset).toContain("pg_get_serial_sequence('invoices', 'id')");
    expect(reset).toContain("MAX(id)");
  });
});
