import { describe, expect, it, vi } from "vitest";
import { MoneyAttemptStore, moneyAcknowledgment, type MoneyRequest } from "../lib/money-attempt";

const payment: MoneyRequest = { url: "/api/payments", body: JSON.stringify({ patientId: 101, amount: "500", currency: "YER", kind: "payment" }), operation: "payment" };
const ok = () => Response.json({ id: 701 }, { status: 201 });

describe("DOT-PF-01: money request identity until acknowledged", () => {
  it.each(["malformed", "missing-id", "null", "string-id", "zero-id", "network", "server"])("retains exact request after %s and retries once", async (failure) => {
    const transport = vi.fn<typeof fetch>().mockImplementationOnce(async () => {
      if (failure === "network") throw new Error("lost response");
      if (failure === "malformed") return new Response("{", { status: 201 });
      if (failure === "server") return Response.json({ message: "unknown" }, { status: 500 });
      return Response.json(failure === "null" ? null : failure === "string-id" ? { id: "701" } : failure === "zero-id" ? { id: 0 } : {}, { status: 200 });
    }).mockResolvedValueOnce(ok());
    const store = new MoneyAttemptStore(transport, () => "synthetic-key-001");
    expect((await store.run("patient-a", payment)).kind).toBe("uncertain");
    expect(store.get("patient-a")?.phase).toBe("uncertain");
    const result = await store.run("patient-a");
    expect(result.kind).toBe("confirmed");
    expect(transport.mock.calls[1]).toEqual(transport.mock.calls[0]);
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("locks synchronously against a double click, and retains detached confirmations until consumed", async () => {
    let resolve!: (response: Response) => void;
    const transport = vi.fn<typeof fetch>(() => new Promise<Response>((done) => { resolve = done; }));
    const store = new MoneyAttemptStore(transport);
    const first = store.run("a", payment);
    expect(await store.run("a", payment)).toEqual({ kind: "busy" });
    resolve(ok());
    const result = await first;
    expect(result.kind).toBe("confirmed");
    expect(await store.run("a")).toEqual(result); // reopen after old form was unmounted
    expect(transport).toHaveBeenCalledTimes(1);
    if (result.kind === "confirmed") store.consume("a", result.attempt);
    expect(store.get("a")).toBeNull();
  });

  it("does not let amount, target, endpoint or operation edits replace an uncertain attempt", async () => {
    const transport = vi.fn<typeof fetch>().mockRejectedValue(new Error("lost"));
    const store = new MoneyAttemptStore(transport);
    await store.run("a", payment);
    for (const request of [
      { ...payment, body: JSON.stringify({ patientId: 101, amount: "600" }) },
      { ...payment, body: JSON.stringify({ patientId: 101, amount: "500", invoiceId: 201 }) },
      { ...payment, url: "/api/plans/301", operation: "installment" as const },
      { ...payment, operation: "void" as const },
    ]) expect((await store.run("a", request)).kind).toBe("blocked");
    expect(transport).toHaveBeenCalledTimes(1);
    expect(store.get("a")?.request).toEqual(payment);
  });

  it("keeps patient A through A-B-A while B gets a different key", async () => {
    let key = 0;
    const store = new MoneyAttemptStore(vi.fn<typeof fetch>().mockRejectedValue(new Error("lost")), () => `synthetic-key-${++key}`);
    await store.run("a", payment);
    const original = store.get("a");
    await store.run("b", { ...payment, body: '{"patientId":102,"amount":"500"}' });
    expect(store.get("a")).toBe(original);
    expect(store.get("b")?.key).not.toBe(original?.key);
    await store.run("a");
    expect(store.get("a")?.key).toBe(original?.key);
  });

  it("a later explicit refusal cannot erase a possibly committed write", async () => {
    const transport = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error("lost"))
      .mockResolvedValueOnce(Response.json({ message: "shift closed" }, { status: 409 })).mockResolvedValueOnce(ok());
    const store = new MoneyAttemptStore(transport);
    await store.run("a", payment);
    const key = store.get("a")?.key;
    expect((await store.run("a")).kind).toBe("uncertain");
    expect(store.get("a")?.key).toBe(key);
    expect((await store.run("a")).kind).toBe("confirmed");
    expect(transport.mock.calls[2]).toEqual(transport.mock.calls[0]);
  });

  it("a first explicit validation refusal permits a corrected request with a new key", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ message: "invalid amount" }, { status: 400 })).mockResolvedValueOnce(ok());
    const store = new MoneyAttemptStore(transport);
    expect((await store.run("a", payment)).kind).toBe("refused");
    expect(store.get("a")).toBeNull();
    await store.run("a", { ...payment, body: '{"patientId":101,"amount":"600"}' });
    expect(transport.mock.calls[1][1]?.headers).not.toEqual(transport.mock.calls[0][1]?.headers);
  });

  it("installment and correction acknowledgments require the right receipt identities", () => {
    const reversal = { id: 801, receiptNumber: "SYN-R" }, replacement = { id: 802, receiptNumber: "SYN-P" };
    expect(moneyAcknowledgment("installment", { id: 701 })).toBeNull();
    expect(moneyAcknowledgment("installment", { paymentId: 701 })).toEqual({ paymentId: 701 });
    for (const invalid of [null, {}, { reversal }, { reversal, replacement: null }, { reversal, replacement: { id: "802", receiptNumber: "SYN-P" } }]) {
      expect(moneyAcknowledgment("correct", invalid)).toBeNull();
    }
    expect(moneyAcknowledgment("correct", { reversal, replacement })).toMatchObject({ paymentId: 802 });
    expect(moneyAcknowledgment("void", { reversal, replacement: null })).toMatchObject({ paymentId: null });
    expect(moneyAcknowledgment("void", { reversal, replacement })).toBeNull();
  });
});
