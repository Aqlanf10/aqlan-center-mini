import { describe, expect, it } from "vitest";
import { backupSelectColumns, insertStatement, insertionOrder, sequenceResets, sqlValue, sqlValueForColumn } from "../lib/backup";

describe("النسخة الاحتياطية", () => {
  it("projects only scalar timestamps as PostgreSQL ISO text before driver decoding", () => {
    expect(backupSelectColumns([
      { column_name: "recorded_at", data_type: "timestamp with time zone" },
      { column_name: 'local"time', data_type: "timestamp without time zone" },
      { column_name: "id", data_type: "integer" },
      { column_name: "depth", data_type: "numeric" },
      { column_name: "details", data_type: "jsonb" },
      { column_name: "tags", data_type: "ARRAY" },
      { column_name: "day", data_type: "date" },
    ])).toBe('(pg_catalog.to_json("recorded_at") #>> \'{}\') AS "recorded_at", '
      + '(pg_catalog.to_json("local""time") #>> \'{}\') AS "local""time", '
      + '"id", "depth", "details", "tags", "day"');
  });

  it("serializes exact timestamp text and SQL NULL without Date conversion", () => {
    const value = "2001-02-03T04:05:06.123456+05:45";
    expect(sqlValueForColumn(value, "timestamp with time zone")).toBe(`'${value}'`);
    expect(sqlValueForColumn(null, "timestamp with time zone")).toBe("NULL");
    expect(sqlValueForColumn("infinity", "timestamp without time zone")).toBe("'infinity'");
  });

  it("leaves the existing selection unchanged for tables without scalar timestamps", () => {
    expect(backupSelectColumns([
      { column_name: "id", data_type: "integer" },
      { column_name: "details", data_type: "jsonb" },
      { column_name: "tags", data_type: "ARRAY" },
      { column_name: "day", data_type: "date" },
    ])).toBe("*");
  });

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
