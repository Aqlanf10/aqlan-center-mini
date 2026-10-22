import { describe, expect, it, vi } from "vitest";
import { MoneyAttemptStore, type MoneyRequest } from "../lib/money-attempt";

const payment: MoneyRequest = { url: "/api/payments", body: JSON.stringify({ patientId: 7, amount: "500", currency: "YER", kind: "payment" }), operation: "payment" };
const refused = (message = "الفاتورة لا تخص هذا المريض") => Response.json({ message }, { status: 409 });
const retired = () => Response.json({ state: "retired" });
const committed = () => Response.json({ state: "committed" });
const ok = (id = 702) => Response.json({ id }, { status: 201 });
const urls = (transport: ReturnType<typeof vi.fn>) => transport.mock.calls.map((call) => call[0]);

describe("an ordinary 409 is correctable only on server proof (0068)", () => {
  it("first-send 409 + proven retirement: refused, attempt gone, a corrected request gets a NEW key", async () => {
    const keys = ["key-first-00001", "key-second-0002"];
    const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(refused()).mockResolvedValueOnce(retired()).mockResolvedValueOnce(ok());
    const store = new MoneyAttemptStore(transport, () => keys.shift()!);
    expect(await store.run("a", payment)).toEqual({ kind: "refused", message: "الفاتورة لا تخص هذا المريض" });
    expect(store.get("a")).toBeNull();
    expect(JSON.parse((transport.mock.calls[1][1] as RequestInit).body as string)).toEqual({ idempotencyKey: "key-first-00001", patientId: 7 });
    const corrected = { ...payment, body: payment.body.replace("500", "400") };
    expect((await store.run("a", corrected)).kind).toBe("confirmed");
    expect(((transport.mock.calls[2][1] as RequestInit).headers as Record<string, string>)["Idempotency-Key"]).toBe("key-second-0002");
  });
  it("first-send 409 without proof (retire unavailable) stays uncertain and blocks a changed request", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(refused()).mockRejectedValueOnce(new Error("offline"));
    const store = new MoneyAttemptStore(transport, () => "key-unproven-01");
    expect((await store.run("a", payment)).kind).toBe("uncertain");
    expect((await store.run("a", { ...payment, body: payment.body.replace("500", "400") })).kind).toBe("blocked");
  });
  it("a lost reply is never retired automatically; reconcile replays the same request when the key committed", async () => {
    const transport = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error("lost reply")).mockResolvedValueOnce(committed()).mockResolvedValueOnce(ok(55));
    const store = new MoneyAttemptStore(transport, () => "key-lost-000001");
    expect((await store.run("a", payment)).kind).toBe("uncertain");
    expect(urls(transport)).toEqual(["/api/payments"]);
    const result = await store.reconcile("a");
    expect(result).toMatchObject({ kind: "confirmed", acknowledgment: { paymentId: 55 } });
    expect(urls(transport)).toEqual(["/api/payments", "/api/payments/attempts/retire", "/api/payments"]);
    expect(((transport.mock.calls[2][1] as RequestInit).headers as Record<string, string>)["Idempotency-Key"]).toBe("key-lost-000001");
  });
  it("reconcile retires a lost-reply attempt only when the server proves it never committed", async () => {
    const transport = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error("lost reply")).mockResolvedValueOnce(retired());
    const store = new MoneyAttemptStore(transport, () => "key-lost-000002");
    await store.run("a", payment);
    expect(await store.reconcile("a")).toEqual({ kind: "retired" });
    expect(store.get("a")).toBeNull();
  });
  it("receipt corrections never use collection retirement", async () => {
    const correct: MoneyRequest = { url: "/api/payments/9/correct", body: "{}", operation: "correct" };
    const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(refused());
    const store = new MoneyAttemptStore(transport, () => "key-correct-001");
    expect((await store.run("a", correct)).kind).toBe("uncertain");
    expect(await store.reconcile("a")).toEqual({ kind: "busy" });
    expect(urls(transport)).toEqual(["/api/payments/9/correct"]);
  });
});
