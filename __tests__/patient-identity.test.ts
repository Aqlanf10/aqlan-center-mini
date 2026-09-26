import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../lib/messaging-channels";
import { sendOutbound, type OutboundDeps } from "../lib/messaging-send";
import { smsReceive, type WebhookDeps } from "../lib/messaging-webhooks";
import {
  RETIRED_FLAG_CLASS, consentAllows, consentStates, flagClass, isStopRequest, normalizePatientEmail,
  normalizePatientFlags, parseConsentMode, parseFlagList,
} from "../lib/patient-identity";

/** (PAT-3) الأعلام والبريد وموافقات التواصل — ومنع الإرسال بلا موافقة. */

describe("consent", () => {
  it("opt_out sends unless withdrawn; opt_in only with a recorded grant", () => {
    expect(consentAllows("unknown", "opt_out")).toBe(true);
    expect(consentAllows("granted", "opt_out")).toBe(true);
    expect(consentAllows("withdrawn", "opt_out")).toBe(false);
    expect(consentAllows("unknown", "opt_in")).toBe(false);
    expect(consentAllows("granted", "opt_in")).toBe(true);
    expect(consentAllows("withdrawn", "opt_in")).toBe(false);
    expect(parseConsentMode("opt_in")).toBe("opt_in");
    expect(parseConsentMode("garbage")).toBe("opt_out");
  });

  it("the latest event per channel wins, whatever order they arrive in", () => {
    expect(consentStates([
      { id: 3, channel: "whatsapp", granted: false },
      { id: 1, channel: "whatsapp", granted: true },
      { id: 2, channel: "sms", granted: true },
    ])).toEqual({ whatsapp: "withdrawn", sms: "granted", email: "unknown" });
  });

  it("recognizes a whole-message stop request, not a sentence that merely contains the word", () => {
    for (const text of ["توقف", " STOP ", "إيقاف", "إلغاء الاشتراك", "لا ترسل", "stop."]) expect(isStopRequest(text), text).toBe(true);
    for (const text of ["", "لا توقف العلاج", "متى الموعد؟ stop", "شكرًا"]) expect(isStopRequest(text), text).toBe(false);
  });
});

describe("flags", () => {
  it("parses the settings list with Latin or Arabic commas, trimmed and without duplicates", () => {
    expect(parseFlagList("VIP، متأخر السداد ,VIP,, يحتاج مرافقًا")).toEqual(["VIP", "متأخر السداد", "يحتاج مرافقًا"]);
    expect(parseFlagList("")).toEqual([]);
  });

  it("accepts only listed flags, but keeps an old flag the patient already carries", () => {
    const allowed = ["VIP", "قلق من العلاج"];
    expect(normalizePatientFlags(["VIP", " VIP "], allowed)).toEqual({ ok: true, flags: ["VIP"] });
    expect(normalizePatientFlags(["مجهول"], allowed)).toMatchObject({ ok: false, message: expect.stringContaining("ليس في قائمة الأعلام") });
    expect(normalizePatientFlags(["علم قديم", "VIP"], allowed, ["علم قديم"])).toEqual({ ok: true, flags: ["علم قديم", "VIP"] });
    expect(normalizePatientFlags("VIP", allowed)).toMatchObject({ ok: false });
    expect(normalizePatientFlags(null, allowed)).toEqual({ ok: true, flags: [] });
  });

  it("caps new flags at eight, without rejecting a merged file that already has more", () => {
    const list = Array.from({ length: 10 }, (_, index) => `علم${index}`);
    expect(normalizePatientFlags(list.slice(0, 9), list)).toMatchObject({ ok: false });
    expect(normalizePatientFlags(list.slice(0, 9), list, list.slice(0, 9))).toMatchObject({ ok: true });
  });

  it("colors follow the list position; retired flags turn grey", () => {
    expect(flagClass("B", ["A", "B"])).not.toBe(flagClass("A", ["A", "B"]));
    expect(flagClass("Z", ["A"])).toBe(RETIRED_FLAG_CLASS);
  });
});

describe("email", () => {
  it("lower-cases a valid email, clears an empty one, rejects nonsense in Arabic", () => {
    expect(normalizePatientEmail(" Ali@Example.COM ")).toEqual({ ok: true, email: "ali@example.com" });
    expect(normalizePatientEmail("")).toEqual({ ok: true, email: null });
    expect(normalizePatientEmail("ali@")).toMatchObject({ ok: false, message: "صيغة البريد غير صحيحة." });
  });
});

describe("sendOutbound honours consent", () => {
  const deps = (state: "granted" | "withdrawn" | "unknown", mode: "opt_in" | "opt_out") => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ messages: [{ id: "wamid.1" }] }), { status: 200 }));
    const records: unknown[] = [];
    const value: OutboundDeps = {
      channel: async () => ({ view: { enabled: true, config: { ...DEFAULT_CONFIG.whatsapp, phoneNumberId: "123" } as never }, secret: "S" }),
      record: async (entry) => { records.push(entry); return 1; },
      fetchImpl: fetchImpl as never,
      consent: async () => ({ state, mode }),
    };
    return { value, fetchImpl, records };
  };
  const message = { channel: "whatsapp" as const, to: "771000001", subject: null, body: "مرحبا", patientId: 9, actor: "reception" };

  it("refuses a manual message or reminder to a patient who withdrew, before any network call and without a log row", async () => {
    for (const purpose of ["manual", "reminder"] as const) {
      const d = deps("withdrawn", "opt_out");
      const result = await sendOutbound({ ...message, purpose }, d.value);
      expect(result).toMatchObject({ ok: false, status: 409, message: expect.stringContaining("سحب موافقته") });
      expect(d.fetchImpl).not.toHaveBeenCalled();
      expect(d.records).toEqual([]);
    }
  });

  it("opt_in: no recorded consent means no message", async () => {
    const d = deps("unknown", "opt_in");
    expect(await sendOutbound({ ...message, purpose: "manual" }, d.value)).toMatchObject({ ok: false, status: 409, message: expect.stringContaining("لا موافقة مسجّلة") });
  });

  it("replying to the patient's own message is never blocked; opt_out with no record sends", async () => {
    expect((await sendOutbound({ ...message, purpose: "reply" }, deps("withdrawn", "opt_in").value)).ok).toBe(true);
    expect((await sendOutbound({ ...message, purpose: "manual" }, deps("unknown", "opt_out").value)).ok).toBe(true);
  });
});

describe("inbound stop request", () => {
  const webhookDeps = (patientId: number | null) => {
    const optedOut: [string, number][] = [];
    const value: WebhookDeps = {
      channel: vi.fn(async () => ({ enabled: true, config: { inboundKey: "k" }, secrets: {} })),
      patientFor: vi.fn(async () => patientId),
      recordInbound: vi.fn(async () => undefined),
      recordEcho: vi.fn(async () => undefined),
      markFailed: vi.fn(async () => undefined),
      optOut: vi.fn(async (channel, id) => { optedOut.push([channel, id]); }),
    };
    return { value, optedOut };
  };

  it("a known patient's «توقف» withdraws consent on that channel; other text or unknown senders do not", async () => {
    const known = webhookDeps(7);
    expect(await smsReceive("k", { from: "777123456", text: "توقف" }, known.value)).toMatchObject({ status: 200, received: 1 });
    expect(known.optedOut).toEqual([["sms", 7]]);
    await smsReceive("k", { from: "777123456", text: "متى موعدي؟" }, known.value);
    expect(known.optedOut).toHaveLength(1);
    const unknown = webhookDeps(null);
    await smsReceive("k", { from: "777999999", text: "STOP" }, unknown.value);
    expect(unknown.optedOut).toEqual([]);
  });

  it("a failed opt-out write does not fail the webhook (the message itself is stored)", async () => {
    const d = webhookDeps(7);
    d.value.optOut = vi.fn(async () => { throw new Error("db down"); });
    expect((await smsReceive("k", { from: "777123456", text: "توقف" }, d.value)).status).toBe(200);
    expect(d.value.recordInbound).toHaveBeenCalled();
  });
});
