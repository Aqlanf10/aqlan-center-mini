import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authedGet, authedMutation, harness } from "./_server";
import { makeInvoiceDiagnosticEmitter } from "./invoice-number-diagnostic";
import { parseSyntheticInvoiceNumber } from "./synthetic-invoice-number";

/**
 * (P3-1) بادئة رقم الفاتورة من شاشة الإعدادات — على التطبيق المبني.
 *
 * المدير يكتب «FAC» في الإعدادات بسببٍ مكتوب، فتخرج الفاتورة التالية «FAC-000NN».
 * والقيمة الفاسدة أو المكرّرة تُرفض برسالة عربية ولا تُحفظ.
 */

let h: Awaited<ReturnType<typeof harness>>;
const emitInvoiceDiagnostic = makeInvoiceDiagnosticEmitter((line) => process.stdout.write(line));

async function patchSettings(values: Record<string, string>, session: "admin" | "reception" = "admin") {
  const current = await (await authedGet("/api/settings", h.sessions.admin)).json() as { __versions?: Record<string, unknown> };
  const versions = Object.fromEntries(Object.keys(values).map((key) => [key, current.__versions?.[key] ?? null]));
  return authedMutation("/api/settings", h.sessions[session], "PATCH", JSON.stringify({
    ...values, __versions: versions, __reason: "اختبار بادئات المستندات",
  }));
}

async function newInvoiceNumber(stage: "initial" | "before" | "after"): Promise<string> {
  const response = await authedMutation("/api/invoices", h.sessions.admin, "POST", JSON.stringify({
    patientId: h.seeded.patientAId, items: [{ description: "كشف بادئة", quantity: 1, price: "500" }],
  }));
  emitInvoiceDiagnostic(stage, "status", response.status);
  expect(response.status).toBe(201);
  const body = await response.json() as { invoiceNumber: string };
  emitInvoiceDiagnostic(stage, "number", body.invoiceNumber);
  return body.invoiceNumber;
}

beforeAll(async () => {
  h = await harness();
}, 120_000);

afterAll(async () => {
  if (h) await patchSettings({ "documents.invoice_prefix": "INV" });
});

describe("P3-1 — بادئة الفاتورة من الإعدادات", () => {
  it("بادئة فيها رقم تُرفض برسالة عربية ولا تُحفظ", async () => {
    const response = await patchSettings({ "documents.invoice_prefix": "IN2026" });
    expect(response.status).toBe(400);
    const body = await response.json() as { message: string };
    expect(body.message).toContain("حروف لاتينية كبيرة");
    expect(parseSyntheticInvoiceNumber(await newInvoiceNumber("initial"), "INV") !== null).toBe(true);
  });

  it("بادئة الفاتورة لا تساوي بادئة سند القبض", async () => {
    const response = await patchSettings({ "documents.invoice_prefix": "R" });
    expect(response.status).toBe(400);
    expect((await response.json() as { message: string }).message).toContain("يجب أن تختلف");
  });

  it("غير المدير المالي لا يغيّرها", async () => {
    const response = await patchSettings({ "documents.invoice_prefix": "FAC" }, "reception");
    expect(response.status).toBe(403);
  });

  it("المدير يضبط FAC فتخرج الفاتورة التالية بها — والعدّاد يتابع", async () => {
    const before = await newInvoiceNumber("before");
    expect((await patchSettings({ "documents.invoice_prefix": "FAC" })).status).toBe(200);
    const after = await newInvoiceNumber("after");
    const beforeSequence = parseSyntheticInvoiceNumber(before, "INV");
    const afterSequence = parseSyntheticInvoiceNumber(after, "FAC");
    expect(beforeSequence !== null).toBe(true);
    expect(afterSequence !== null).toBe(true);
    if (beforeSequence === null || afterSequence === null) return;
    expect(afterSequence === beforeSequence + 1n).toBe(true);
  });

  it("مراجعة: بادئة الفاتورة القديمة لا تُعطى لسند القبض — 400 برسالة عربية", async () => {
    // الاختبار السابق نقل الفاتورة إلى FAC، وفواتير INV-… مطبوعة قبله.
    const response = await patchSettings({ "documents.receipt_prefix": "INV" });
    expect(response.status).toBe(400);
    expect((await response.json() as { message: string }).message).toContain("مستخدمة سابقًا");
  });
});

