import { describe, expect, it } from "vitest";
import { readOperationalCheckout, readOperationalCheckoutQueue, readOperationalRow, readVisitReceivable, sameVisitReceivable, type VisitReceivable } from "../lib/operational-checkout";

const owner = { username: "synthetic-desk", role: "reception" };
const row = { visitId: 51, patientId: 31, patientName: "مريض اصطناعي", patientNumber: "SYN-31",
  finishedAt: "2026-10-09T21:00:00.123Z", finishVersion: "finished:2026-10-09T21:00:00.123456Z",
  dateBasis: "finished", signedAt: null, status: "pending", handledReason: null, financialReviewRequired: false, visitInvoiceSettled: false };
const payload = () => ({ version: 1, owner, fromDate: "2026-10-09", toDate: "2026-10-10", clinicTimeZone: "Asia/Aden",
  items: [{ visitId: 50, patientId: 31, patientName: "مريض اصطناعي", patientNumber: "SYN-31",
    signedAt: "2026-10-10T09:00:00Z", signatureVersion: "2026-10-10T09:00:00.000000Z", status: "pending", handledReason: null, financialReviewRequired: false, visitInvoiceSettled: false }], operationalItems: [row] });
const invoice: VisitReceivable = { revision: "a".repeat(32), invoiceId: 80, currency: "SAR", status: "open", netMinor: 10000, paidMinor: 2000 };
describe("one operational/signed checkout queue with independent clinical state", () => {
  it("accepts an Aden-boundary finish and one signed row without manufacturing signature or invoice", () => {
    const accepted = readOperationalCheckoutQueue(payload(), owner, "2026-10-10")!;
    expect(accepted.items).toHaveLength(2);
    expect(accepted.items.map(item => [item.visitId, item.eligibility])).toEqual([[50, "signed"], [51, "finished_unsigned"]]);
    expect(accepted.items[1]).toMatchObject({ signedAt: null, patientId: 31, status: "pending" });
    expect(accepted.items[1]).not.toHaveProperty("invoiceId");
  });
  it("rejects missing operational reads, wrong owner, wrong role/date, duplicates, out-of-window finishes and fabricated signatures", () => {
    expect(readOperationalCheckoutQueue({ ...payload(), items: payload().items.map(row => ({ ...row, financialReviewRequired: undefined })) }, owner, null)).toBeNull();
    const absent = { ...payload(), operationalItems: undefined };
    expect(readOperationalCheckoutQueue(absent, owner, null)).toBeNull();
    expect(readOperationalCheckoutQueue(payload(), { ...owner, username: "other" }, null)).toBeNull();
    expect(readOperationalCheckoutQueue(payload(), { ...owner, role: "cashier" }, null)).toBeNull();
    expect(readOperationalCheckoutQueue(payload(), owner, "2026-10-08")).toBeNull();
    for (const changed of [{ ...row, visitId: 50 }, { ...row, signedAt: "2026-10-10T09:00:00Z" },
      { ...row, finishedAt: "2026-10-08T20:59:59.000Z" }, { ...row, status: ["pending"] }, { ...row, dateBasis: ["finished"] }]) {
      expect(readOperationalCheckoutQueue({ ...payload(), operationalItems: [changed] }, owner, null)).toBeNull();
    }
  });
  it("requires exact operational patient/visit/version and verified primitive financial values", () => {
    const expected = { visitId: 51, patientId: 31, finishVersion: row.finishVersion };
    const read = { version: 1, owner, item: row, receivable: invoice };
    expect(readOperationalCheckout(read, owner, expected)?.receivable).toEqual(invoice);
    for (const changed of [{ ...expected, visitId: 52 }, { ...expected, patientId: 32 }, { ...expected, finishVersion: "finished:2026-10-09T21:00:00.123457Z" }]) {
      expect(readOperationalCheckout(read, owner, changed)).toBeNull();
    }
    for (const changed of [{ ...invoice, currency: ["SAR"] }, { ...invoice, paidMinor: "2000" }, { ...invoice, netMinor: -1 },
      { ...invoice, status: ["open"] }, { ...invoice, invoiceId: Infinity }]) expect(readVisitReceivable(changed)).toBeUndefined();
    expect(readOperationalCheckout({ ...read, receivable: undefined }, owner, expected)).toBeNull();
    expect(readOperationalRow({ ...row, patientId: null, patientNumber: null })).toMatchObject({ patientId: null });
  });
});
describe("late signing carries only the same explicitly reviewed receivable", () => {
  it("carries verified none→none and the same principal after payment, never an unrelated invoice", () => {
    expect(sameVisitReceivable(null, null)).toBe(true);
    expect(sameVisitReceivable(invoice, { ...invoice, paidMinor: 9000 })).toBe(false);
    expect(sameVisitReceivable(invoice, { ...invoice, status: "paid", paidMinor: 10000 })).toBe(false);
    expect(sameVisitReceivable(invoice, { ...invoice, invoiceId: 81 })).toBe(false);
    expect(sameVisitReceivable(invoice, { ...invoice, currency: "USD" })).toBe(false);
    expect(sameVisitReceivable(null, { ...invoice, netMinor: 0, paidMinor: 0 })).toBe(false);
    expect(sameVisitReceivable(invoice, null)).toBe(false);
  });
  it("reopens increased principal even when another payment offsets the balance, and reopens refunds/cancellation", () => {
    expect(sameVisitReceivable(invoice, { ...invoice, netMinor: 20000, paidMinor: 12000 })).toBe(false);
    expect(sameVisitReceivable(invoice, { ...invoice, paidMinor: 1000 })).toBe(false);
    expect(sameVisitReceivable(invoice, { ...invoice, status: "cancelled" })).toBe(false);
    expect(sameVisitReceivable(invoice, { ...invoice, invoiceId: 81, netMinor: 0, paidMinor: 0 })).toBe(false);
  });
});

it("preserves a fresh explicit cancelled-reference review only while that exact cancelled proof is unchanged", () => {
  const cancelled = { ...invoice, status: "cancelled" as const };
  expect(sameVisitReceivable(cancelled, cancelled)).toBe(true);
  expect(sameVisitReceivable(cancelled, { ...cancelled, paidMinor: 1000 })).toBe(false);
  expect(sameVisitReceivable(cancelled, { ...cancelled, netMinor: 9000 })).toBe(false);
  expect(sameVisitReceivable(cancelled, { ...cancelled, invoiceId: 81 })).toBe(false);
  expect(sameVisitReceivable(cancelled, invoice)).toBe(false);
});

it("alerts once per visit event and microsecond revision, including a later signature after unsigned handling, never initial/history polls", async () => {
  const { checkoutEventKey, discoverCheckoutEvents } = await import("../lib/operational-checkout");
  const unsigned = readOperationalCheckoutQueue({ ...payload(), items: [] }, owner, null)!.items[0];
  const signed = readOperationalCheckoutQueue({ ...payload(), operationalItems: [], items: [{ ...payload().items[0], visitId: unsigned.visitId, status: "handled" }] }, owner, null)!.items[0];
  const initial = discoverCheckoutEvents([unsigned], null, false);
  expect(initial.discovered).toEqual([]);
  expect(checkoutEventKey(signed)).not.toBe(checkoutEventKey(unsigned));
  const later = discoverCheckoutEvents([signed], initial.seen, false);
  expect(later.discovered).toEqual([signed]);
  expect(discoverCheckoutEvents([signed], later.seen, false).discovered).toEqual([]);
  const absent = discoverCheckoutEvents([], later.seen, false);
  expect(discoverCheckoutEvents([signed], absent.seen, false).discovered).toEqual([]);
  const revision = { ...signed, signatureVersion: "2026-10-10T09:00:00.000001Z" };
  expect(discoverCheckoutEvents([revision], later.seen, false).discovered).toEqual([revision]);
  expect(discoverCheckoutEvents([revision], later.seen, true).discovered).toEqual([]);
  expect(discoverCheckoutEvents([signed], null, false).discovered).toEqual([]);
});
it("rejects a receipt revision change even if the balance is exactly unchanged", () => {
  expect(sameVisitReceivable(invoice, { ...invoice, revision: "b".repeat(32) })).toBe(false);
  expect(sameVisitReceivable(invoice, { paidMinor: invoice.paidMinor, netMinor: invoice.netMinor, status: invoice.status,
    currency: invoice.currency, invoiceId: invoice.invoiceId, revision: invoice.revision })).toBe(true);
});
