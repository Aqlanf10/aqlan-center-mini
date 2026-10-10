import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { Page, Request, Response } from "playwright";
import { financialReadDetails, observeOwnedFinancialReads } from "./helpers/owned-financial-read-witness";

const owner = { kind: "walkout" as const, patientId: 31, visitId: 32 };
const body = () => ({
  patientId: 31, visitId: 32, patientName: "do-not-log-name", signedAt: "2026-10-10T20:55:00Z",
  arrivedAt: "2026-10-10T20:54:00Z", invoice: { id: 33, currency: "USD", netMinor: 150000 },
  balances: [{ currency: "YER", balanceMinor: 25000 }],
  checkout: { previous: { YER: 25000, SAR: 0, USD: 50000 }, current: { YER: 25000, SAR: 0, USD: 0 }, invoicePaidMinor: 200000 },
  message: "do-not-log-secret", headers: { cookie: "do-not-log-cookie" },
});

describe("bounded owned financial read witnesses", () => {
  it("preserves financial validator evidence without names, messages or headers", () => {
    const details = financialReadDetails(body(), owner);
    expect(details).toMatchObject({ ownerMatches: true, financialsAccepted: true, invoicePaidMinor: 200000 });
    expect(JSON.stringify(details)).not.toContain("do-not-log");
  });
  it("reports invalid money without coercion and does not retain another owner's facts", () => {
    const invalid = { ...body(), checkout: { ...body().checkout, current: { YER: "25000", SAR: 0, USD: 0 } } };
    expect(financialReadDetails(invalid, owner)).toMatchObject({ financialsAccepted: false, current: { YER: null } });
    expect(financialReadDetails({ ...body(), patientId: 99 }, owner)).toEqual({ object: true, ownerMatches: false });
    expect(financialReadDetails(null, owner)).toEqual({ object: false });
  });
  it("does not log arbitrary server error codes or messages", () => {
    const details = financialReadDetails({ code: "secret-value", message: "secret-message" }, { kind: "payment", patientId: 31 });
    expect(details).toMatchObject({ code: "unclassified" });
    expect(JSON.stringify(details)).not.toContain("secret");
  });
  it("requires a primitive currency string without array or object coercion", () => {
    for (const currency of [["USD"], [[["USD"]]], { toString: () => "USD", secret: "do-not-log" }]) {
      const details = financialReadDetails({ ...body(), invoice: { ...body().invoice, currency } }, owner);
      expect(details).toMatchObject({ invoiceCurrency: null, financialsAccepted: false });
      expect(JSON.stringify(details)).not.toContain("do-not-log");
    }
  });
  it("limits payment responses to receipt ID and allowlisted code without unowned money", () => {
    expect(financialReadDetails({ ...body(), id: 34, code: "conflict" }, { kind: "payment", patientId: 31 }))
      .toEqual({ object: true, receiptId: 34, code: "conflict" });
    expect(financialReadDetails({ ...body(), id: ["34"] }, { kind: "payment", patientId: 31 }))
      .toEqual({ object: true, receiptId: null, code: null });
  });
  it("contains classifier exceptions and bounds both failure text and failed classifications", () => {
    const events = new EventEmitter();
    const broken = observeOwnedFinancialReads(events as unknown as Page, () => { throw new Error("do-not-log-secret"); });
    expect(() => { for (let i = 0; i < 25; i++) events.emit("request", {} as Request); }).not.toThrow();
    expect(broken.snapshot()).toHaveLength(20);
    expect(broken.snapshot().at(-1)).toEqual({ epoch: 25, navigation: 0, kind: "diagnostic", failed: "classification_failed" });
    expect(JSON.stringify(broken.snapshot())).not.toContain("do-not-log");
    broken.stop();
    const observer = observeOwnedFinancialReads(events as unknown as Page, () => owner);
    for (const errorText of ["net::ERR_" + "A".repeat(100_000), "net::ERR_SECRET", "do-not-log-secret"]) {
      const request = { failure: () => ({ errorText }) } as Request;
      events.emit("request", request); events.emit("requestfailed", request);
      expect(observer.snapshot().at(-1)?.failed).toBe("request_failed");
    }
    expect(Buffer.byteLength(JSON.stringify(observer.snapshot()))).toBeLessThan(1024);
    observer.stop();
  });
  it("tracks request epochs, bounded history and aborts without changing responses", async () => {
    const events = new EventEmitter();
    const observer = observeOwnedFinancialReads(events as unknown as Page, () => owner);
    for (let i = 0; i < 25; i++) events.emit("request", {} as Request);
    const request = { failure: () => ({ errorText: "net::ERR_ABORTED" }) } as Request;
    events.emit("framenavigated");
    events.emit("request", request);
    events.emit("response", { request: () => request, status: () => 200, json: async () => body() } as unknown as Response);
    await Promise.resolve();
    events.emit("requestfailed", request);
    expect(observer.snapshot()).toHaveLength(20);
    expect(observer.snapshot().at(-1)).toMatchObject({ epoch: 26, navigation: 1, status: 200, failed: "net::ERR_ABORTED", json: "parsed" });
    expect(Buffer.byteLength(JSON.stringify(observer.snapshot()))).toBeLessThan(16_384);
    observer.stop();
    expect(events.eventNames()).toEqual([]);
  });
});
