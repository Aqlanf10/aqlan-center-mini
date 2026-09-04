import { describe, expect, it } from "vitest";
import {
  invoiceWhatsAppSummaryText,
  receiptWhatsAppSummaryText,
  toWhatsAppNumber,
  whatsAppDirectLink,
} from "../lib/reminders";

describe("مشاركة الفواتير وسندات القبض عبر واتساب", () => {
  it("يولد نص ملخص الفاتورة ورابط الواتساب بالشكل المعتمد", () => {
    const text = invoiceWhatsAppSummaryText({
      patientName: "عبدالرحمن الشميري",
      invoiceNumber: "INV-00124",
      netAmountText: "50,000 ر.ي",
      clinicName: "مركز الدكتور عقلان الكامل لطب الأسنان",
      clinicPhone: "04-253028",
    });

    expect(text).toContain("عبدالرحمن الشميري");
    expect(text).toContain("INV-00124");
    expect(text).toContain("50,000 ر.ي");
    expect(text).toContain("مركز الدكتور عقلان الكامل لطب الأسنان");

    const waNum = toWhatsAppNumber("770245745");
    expect(waNum).toBe("967770245745");

    const link = whatsAppDirectLink(waNum!, text);
    expect(link).toContain("https://wa.me/967770245745?text=");
    expect(link).toContain(encodeURIComponent("INV-00124"));
  });

  it("يولد نص سند القبض بدقة", () => {
    const text = receiptWhatsAppSummaryText({
      patientName: "فاطمة أحمد",
      receiptNumber: "REC-00892",
      amountText: "100 $",
    });

    expect(text).toContain("فاطمة أحمد");
    expect(text).toContain("REC-00892");
    expect(text).toContain("100 $");
  });
});
