import { describe, expect, it } from "vitest";
import {
  attributeByKey,
  attributeCollections,
  collectedParts,
  splitAcrossLines,
  type AttributionInput,
  type AttributionLine,
} from "../lib/report-attribution";

const line = (doctorId: number | null, category: string | null, netMinor: number): AttributionLine =>
  ({ doctorId, category, serviceId: null, netMinor });

const pay = (id: number, date: string, amount: number, currency: "YER" | "SAR" | "USD" = "YER", kind = "payment") =>
  ({ id, date, kind, settlementCurrency: currency, settlementMinor: amount });

describe("splitAcrossLines", () => {
  it("splits exactly (largest remainder) and keeps the sign", () => {
    const lines = [line(1, "ortho", 30000), line(2, "rct", 10000)];
    expect(splitAcrossLines(lines, 36000).map((part) => part.amount)).toEqual([27000, 9000]);
    const odd = splitAcrossLines([line(1, null, 1), line(2, null, 1), line(3, null, 1)], 100);
    expect(odd.reduce((sum, part) => sum + part.amount, 0)).toBe(100);
    expect(splitAcrossLines(lines, -4000).map((part) => part.amount)).toEqual([-3000, -1000]);
  });

  it("an invoice without positive lines gives one unattributed part", () => {
    expect(splitAcrossLines([], 500)).toEqual([{ line: null, amount: 500 }]);
  });
});

describe("attributeCollections — the commission engine's FIFO", () => {
  it("covers the opening balance first, then invoices oldest first, within each currency", () => {
    const input: AttributionInput = {
      openings: { YER: { date: "2025-01-01", minor: 5000 } },
      invoices: [
        { id: 2, date: "2025-03-10", currency: "YER", netMinor: 8000, lines: [] },
        { id: 1, date: "2025-02-10", currency: "YER", netMinor: 10000, lines: [] },
        { id: 3, date: "2025-02-11", currency: "USD", netMinor: 100, lines: [] },
      ],
      payments: [pay(1, "2025-03-15", 12000), pay(2, "2025-03-15", 40, "USD")],
    };
    const result = attributeCollections(input, "2025-12-31");
    expect(result.openingRemaining).toBe(0);
    expect(result.coveredByInvoice.get(1)).toBe(7000);
    expect(result.coveredByInvoice.get(2)).toBe(0);
    expect(result.coveredByInvoice.get(3)).toBe(40); // الدولار يغطّي فاتورة الدولار وحدها
  });

  it("overpayment stays as patient credit, never attributed", () => {
    const input: AttributionInput = {
      openings: {},
      invoices: [{ id: 1, date: "2025-03-01", currency: "YER", netMinor: 1000, lines: [] }],
      payments: [pay(1, "2025-03-02", 1500)],
    };
    const { chunks } = attributeCollections(input, "2025-12-31");
    expect(chunks).toEqual([
      { target: { kind: "invoice", invoiceId: 1 }, date: "2025-03-02", currency: "YER", amount: 1000 },
      { target: { kind: "credit" }, date: "2025-03-02", currency: "YER", amount: 500 },
    ]);
  });

  it("a refund reopens the latest covered amount first (credit before invoices)", () => {
    const input: AttributionInput = {
      openings: {},
      invoices: [
        { id: 1, date: "2025-03-01", currency: "YER", netMinor: 1000, lines: [] },
        { id: 2, date: "2025-03-05", currency: "YER", netMinor: 1000, lines: [] },
      ],
      payments: [pay(1, "2025-03-06", 2300), pay(2, "2025-03-20", 800, "YER", "refund")],
    };
    const result = attributeCollections(input, "2025-12-31");
    expect(result.coveredByInvoice.get(1)).toBe(1000);
    expect(result.coveredByInvoice.get(2)).toBe(500); // 300 من الرصيد الدائن ثم 500 من الفاتورة ٢
  });

  it("ignores everything after the as-of day", () => {
    const input: AttributionInput = {
      openings: {},
      invoices: [{ id: 1, date: "2025-03-01", currency: "YER", netMinor: 1000, lines: [] }],
      payments: [pay(1, "2025-04-01", 1000)],
    };
    expect(attributeCollections(input, "2025-03-31").coveredByInvoice.get(1)).toBe(0);
  });
});

describe("attributeByKey — RPT-09/10/11/13/14", () => {
  // مريضٌ عالجه طبيب تقويم (مايو، سُدّد) ثم طبيب عصب (سبتمبر، دفع ٤٠٬٠٠٠ من ٦٠٬٠٠٠).
  const patient: AttributionInput = {
    openings: {},
    invoices: [
      { id: 1, date: "2025-05-10", currency: "YER", netMinor: 100000, lines: [line(10, "ortho", 100000)] },
      { id: 2, date: "2025-09-10", currency: "YER", netMinor: 60000, lines: [line(20, "rct", 60000)] },
    ],
    payments: [pay(1, "2025-05-10", 100000), pay(2, "2025-09-12", 40000)],
  };

  it("September collections go to the endodontist only; debt stays on his line only", () => {
    const byDoctor = attributeByKey(patient, "2025-09-01", "2025-09-30", (item) => item.doctorId);
    expect(byDoctor.collected.get(10)?.YER ?? 0).toBe(0);
    expect(byDoctor.collected.get(20)?.YER).toBe(40000);
    expect(byDoctor.remaining.get(10)?.YER ?? 0).toBe(0);
    expect(byDoctor.remaining.get(20)?.YER).toBe(20000);
  });

  it("by specialty the same money never appears twice", () => {
    const bySpecialty = attributeByKey(patient, "2025-01-01", "2025-12-31", (item) => item.category);
    const total = [...bySpecialty.collected.values()].reduce((sum, record) => sum + record.YER, 0)
      + bySpecialty.unattributedCollected.YER;
    expect(total).toBe(140000);
    expect(bySpecialty.collected.get("ortho")?.YER).toBe(100000);
    expect(bySpecialty.collected.get("rct")?.YER).toBe(40000);
  });

  it("a two-doctor invoice with a discount splits collection by each line's net", () => {
    const input: AttributionInput = {
      openings: {},
      invoices: [{ id: 1, date: "2025-09-15", currency: "YER", netMinor: 36000, lines: [line(10, "ortho", 27000), line(20, "rct", 9000)] }],
      payments: [pay(1, "2025-09-15", 36000)],
    };
    const byDoctor = attributeByKey(input, "2025-09-01", "2025-09-30", (item) => item.doctorId);
    expect(byDoctor.collected.get(10)?.YER).toBe(27000);
    expect(byDoctor.collected.get(20)?.YER).toBe(9000);
  });

  it("opening balance and prepayments are reported as unattributed, not given to a doctor", () => {
    const input: AttributionInput = {
      openings: { YER: { date: "2024-12-31", minor: 3000 } },
      invoices: [],
      payments: [pay(1, "2025-09-02", 5000)],
    };
    const byDoctor = attributeByKey(input, "2025-09-01", "2025-09-30", (item) => item.doctorId);
    expect(byDoctor.collected.size).toBe(0);
    expect(byDoctor.unattributedCollected.YER).toBe(5000);
    expect(byDoctor.openingRemaining).toBe(0);
  });
});

describe("collectedParts — each collected part with its line key and payment moment", () => {
  it("sums to attributeByKey().collected and carries the payment timestamp to every part", () => {
    const input: AttributionInput = {
      openings: { YER: { date: "2025-01-01", minor: 1000 } },
      invoices: [{ id: 1, date: "2025-09-10", currency: "YER", netMinor: 40000, lines: [line(1, "ortho", 30000), line(2, "rct", 10000)] }],
      payments: [
        { ...pay(1, "2025-09-12", 21000), at: "2025-09-12T08:00:00.000Z" },
        { ...pay(2, "2025-09-20", 20000), at: "2025-09-20T08:00:00.000Z" },
      ],
    };
    const parts = collectedParts(input, "2025-09-01", "2025-09-30", (item) => item.category);
    // ١٬٠٠٠ للافتتاحي (بلا بند) ثم الفاتورة ٣:١ — والأجزاء تحمل لحظة دفعتها.
    expect(parts.filter((part) => part.unattributed)).toEqual([
      { key: null, currency: "YER", amount: 1000, date: "2025-09-12", at: "2025-09-12T08:00:00.000Z", unattributed: true },
    ]);
    expect(parts.filter((part) => !part.unattributed).map((part) => [part.key, part.amount, part.at])).toEqual([
      ["ortho", 15000, "2025-09-12T08:00:00.000Z"], ["rct", 5000, "2025-09-12T08:00:00.000Z"],
      ["ortho", 15000, "2025-09-20T08:00:00.000Z"], ["rct", 5000, "2025-09-20T08:00:00.000Z"],
    ]);
    const totals = attributeByKey(input, "2025-09-01", "2025-09-30", (item) => item.category);
    expect(totals.collected.get("ortho")?.YER).toBe(30000);
    expect(totals.collected.get("rct")?.YER).toBe(10000);
    expect(totals.unattributedCollected.YER).toBe(1000);
    // خارج المدى لا شيء.
    expect(collectedParts(input, "2025-10-01", "2025-10-31", (item) => item.category)).toEqual([]);
  });
});

