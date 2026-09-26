import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, type Channel } from "../lib/messaging-channels";
import { sendOutbound, type OutboundDeps } from "../lib/messaging-send";

/** (MSG-1) الإرسال عبر القنوات: يُرسل أو يُقال إنه لم يُرسل — وكلٌّ يُسجَّل. */

function deps(channel: Channel, options: { enabled?: boolean; secret?: string | null; config?: object; fetchImpl?: typeof fetch } = {}) {
  const records: Parameters<OutboundDeps["record"]>[0][] = [];
  const value: OutboundDeps = {
    channel: async () => ({
      view: { enabled: options.enabled ?? true, config: { ...DEFAULT_CONFIG[channel], ...(options.config ?? {}) } as never },
      secret: options.secret === undefined ? "SECRET" : options.secret,
    }),
    record: async (entry) => { records.push(entry); return records.length; },
    fetchImpl: options.fetchImpl,
  };
  return { value, records };
}

const base = { subject: null, patientId: 5, purpose: "manual" as const, actor: "reception" };

describe("sendOutbound", () => {
  it("a disabled or secret-less channel is refused in Arabic, and nothing is recorded", async () => {
    for (const setup of [{ enabled: false }, { secret: null }]) {
      const d = deps("whatsapp", setup);
      const result = await sendOutbound({ ...base, channel: "whatsapp", to: "771000001", body: "مرحبا" }, d.value);
      expect(result).toMatchObject({ ok: false, status: 409, message: expect.stringContaining("غير مفعّلة") });
      expect(d.records).toEqual([]);
    }
  });

  it("WhatsApp: normalizes the number, sends the text, records it as sent", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ messages: [{ id: "wamid.9" }] }), { status: 200 }));
    const d = deps("whatsapp", { config: { phoneNumberId: "12345678" }, fetchImpl: fetchImpl as never });
    const result = await sendOutbound({ ...base, channel: "whatsapp", to: "0771000001", body: "موعدكم غدًا" }, d.value);
    expect(result.ok).toBe(true);
    const sent = JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(sent).toMatchObject({ to: "967771000001", type: "text", text: { body: "موعدكم غدًا" } });
    expect(d.records[0]).toMatchObject({ channel: "whatsapp", counterpart: "967771000001", status: "sent", providerMessageId: "wamid.9", patientId: 5 });
  });

  it("SMS: a gateway refusal is recorded as failed with an Arabic reason", async () => {
    const fetchImpl = vi.fn(async () => new Response("ERROR: no balance", { status: 200 }));
    const d = deps("sms", { config: { url: "https://gw.example/send", successPattern: "OK" }, fetchImpl: fetchImpl as never });
    const result = await sendOutbound({ ...base, channel: "sms", to: "771000001", body: "نص" }, d.value);
    expect(result).toMatchObject({ ok: false, status: 502 });
    expect(d.records[0]).toMatchObject({ channel: "sms", status: "failed", error: expect.stringContaining("رصيد") });
  });

  it("rejects an invalid recipient before any network call", async () => {
    const fetchImpl = vi.fn();
    const d = deps("email", { fetchImpl: fetchImpl as never });
    expect(await sendOutbound({ ...base, channel: "email", to: "not-an-email", body: "نص" }, d.value)).toMatchObject({ ok: false, status: 400 });
    const w = deps("whatsapp", { fetchImpl: fetchImpl as never });
    expect(await sendOutbound({ ...base, channel: "whatsapp", to: "04-253028", body: "نص" }, w.value)).toMatchObject({ ok: false, status: 400 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("a test message may go through a channel that is not enabled yet", async () => {
    const fetchImpl = vi.fn(async () => new Response("OK", { status: 200 }));
    const d = deps("sms", { enabled: false, config: { url: "https://gw.example/send" }, fetchImpl: fetchImpl as never });
    expect((await sendOutbound({ ...base, purpose: "test", channel: "sms", to: "771000001", body: "اختبار" }, d.value)).ok).toBe(true);
  });

  it("(review) a sent message whose log write fails is still reported as sent — never a retry-inviting failure", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ messages: [{ id: "wamid.L" }] }), { status: 200 }));
    const d = deps("whatsapp", { config: { phoneNumberId: "12345678" }, fetchImpl: fetchImpl as never });
    d.value.record = async () => { throw new Error("db down"); };
    const result = await sendOutbound({ ...base, channel: "whatsapp", to: "0771000001", body: "مرحبا" }, d.value);
    expect(result).toMatchObject({ ok: true, deliveryId: null, logged: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

