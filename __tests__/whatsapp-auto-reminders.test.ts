import { describe, expect, it, vi } from "vitest";
import { sendWhatsAppTemplate, templatePayload, whatsAppCloudConfig, type SendResult } from "../lib/whatsapp-cloud";
import { reminderTemplateParams, runAutoReminders } from "../lib/auto-reminders";
import type { Appointment } from "../lib/schedule";
import { SETTING_DEFAULTS, validateSetting } from "../lib/settings";

/**
 * (P2-12) التذكير الآلي بواتساب للأعمال: يُرسل أو يُقال إنه لم يُرسَل — لا فشلٌ صامت،
 * ولا تذكيران، ولا رمزٌ يتسرّب في رسالة خطأ.
 */

const config = { token: "EAAG-secret-token", phoneNumberId: "1234567890", graphVersion: "v21.0" };
const clinic = { name: "مركز الاختبار", phone: "04-000000" };

function appt(id: number, extra: Partial<Appointment> = {}): Appointment {
  return {
    id, patientId: id, patientName: `مريض ${id}`, patientPhone: "771000001", scheduledDate: "2026-09-27",
    scheduledTime: "10:30", durationMinutes: 30, note: null, status: "booked", reminderSentAt: null, ...extra,
  };
}

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("WhatsApp Cloud client", () => {
  it("is off until token and phone number id are in the environment", () => {
    expect(whatsAppCloudConfig({})).toBeNull();
    expect(whatsAppCloudConfig({ WHATSAPP_CLOUD_TOKEN: "t" })).toBeNull();
    expect(whatsAppCloudConfig({ WHATSAPP_CLOUD_TOKEN: "t", WHATSAPP_PHONE_NUMBER_ID: "abc" })).toBeNull();
    expect(whatsAppCloudConfig({ WHATSAPP_CLOUD_TOKEN: "t", WHATSAPP_PHONE_NUMBER_ID: "1234567890" }))
      .toEqual({ token: "t", phoneNumberId: "1234567890", graphVersion: "v21.0" });
  });

  it("builds Meta's template payload with numbered body parameters", () => {
    expect(templatePayload({ to: "967771000001", templateName: "appointment_reminder", languageCode: "ar", bodyParams: ["أ", "ب"] }))
      .toEqual({
        messaging_product: "whatsapp", to: "967771000001", type: "template",
        template: { name: "appointment_reminder", language: { code: "ar" },
          components: [{ type: "body", parameters: [{ type: "text", text: "أ" }, { type: "text", text: "ب" }] }] },
      });
  });

  it("sends with the bearer token to the phone number's messages endpoint", async () => {
    const fetchImpl = vi.fn(async () => reply(200, { messages: [{ id: "wamid.1" }] }));
    const result = await sendWhatsAppTemplate(config, { to: "967771000001", templateName: "t", languageCode: "ar", bodyParams: [] }, fetchImpl as never);
    expect(result).toEqual({ ok: true, messageId: "wamid.1" });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://graph.facebook.com/v21.0/1234567890/messages");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer EAAG-secret-token");
  });

  it("maps failures to Arabic, retriable or not, and never echoes the token or Meta's raw body", async () => {
    const cases: [Response | Error, Partial<SendResult>][] = [
      [reply(401, { error: { code: 190, message: "Invalid OAuth EAAG-secret-token" } }), { retriable: false, recipientOnly: false }],
      [reply(400, { error: { code: 132001 } }), { retriable: false, recipientOnly: false }],
      [reply(400, { error: { code: 131026 } }), { retriable: false, recipientOnly: true }],
      [reply(429, { error: { code: 130429 } }), { retriable: true }],
      [reply(503, {}), { retriable: true }],
      [new Error("ECONNRESET EAAG-secret-token"), { retriable: true }],
    ];
    for (const [response, expected] of cases) {
      const fetchImpl = vi.fn(async () => { if (response instanceof Error) throw response; return response; });
      const result = await sendWhatsAppTemplate(config, { to: "967771000001", templateName: "t", languageCode: "ar", bodyParams: [] }, fetchImpl as never);
      expect(result.ok).toBe(false);
      expect(result).toMatchObject(expected);
      if (!result.ok) {
        expect(result.message).toMatch(/[؀-ۿ]/);
        expect(result.message).not.toContain("EAAG");
        expect(result.message).not.toContain("OAuth");
      }
    }
  });
});

describe("auto reminder run", () => {
  const ok: SendResult = { ok: true, messageId: "m" };
  const input = { date: "2026-09-27", clinic, templateName: "appointment_reminder", languageCode: "ar", limit: 300 };

  function deps(overrides: Partial<Parameters<typeof runAutoReminders>[1]> & { log?: string[] } = {}) {
    const log = overrides.log ?? [];
    return {
      log,
      value: {
        appointmentsOn: async () => [appt(1)],
        claim: async (a: Appointment) => { log.push(`claim:${a.id}`); return `token-${a.id}`; },
        release: async (id: number) => { log.push(`release:${id}`); },
        send: async (m: { to: string }) => { log.push(`send:${m.to}`); return ok; },
        sleep: async () => {},
        ...overrides,
      },
    };
  }

  it("reminds only booked, unreminded appointments with a WhatsApp number — claiming each before it is sent", async () => {
    const d = deps({
      appointmentsOn: async () => [
        appt(1), appt(2, { reminderSentAt: "2026-09-26T15:00:00Z" }), appt(3, { status: "cancelled" }),
        appt(4, { patientPhone: "04-253028" }), appt(5, { patientPhone: "0772000002" }),
      ],
    });
    const run = await runAutoReminders(input, d.value);
    expect(d.log).toEqual(["claim:1", "send:967771000001", "claim:5", "send:967772000002"]);
    expect(run).toMatchObject({ candidates: 2, sent: 2, skipped: 0, failed: 0, retryLater: 0, stoppedBecause: null });
  });

  it("(review) a claim that fails — reminded by hand, moved or cancelled meanwhile — sends nothing", async () => {
    const d = deps({ claim: async () => null });
    const run = await runAutoReminders(input, d.value);
    expect(d.log).toEqual([]);
    expect(run).toMatchObject({ sent: 0, skipped: 1 });
  });

  it("(review) a transient failure is retried within the run before giving the appointment back", async () => {
    let calls = 0;
    const transient: SendResult = { ok: false, message: "حدّ", retriable: true, recipientOnly: false };
    const d = deps({ send: async () => (++calls < 3 ? transient : ok) });
    expect(await runAutoReminders(input, d.value)).toMatchObject({ sent: 1, retryLater: 0 });
    expect(calls).toBe(3);

    const always = deps({ send: async () => transient });
    const run = await runAutoReminders(input, always.value);
    expect(run).toMatchObject({ sent: 0, retryLater: 1 });
    expect(always.log).toContain("release:1");
  });

  it("passes the five template parameters in their registered order", () => {
    expect(reminderTemplateParams(appt(1), clinic)).toEqual(["مريض 1", expect.stringContaining("27/09"), expect.any(String), "مركز الاختبار", "04-000000"]);
  });

  it("a failed send gives the claim back; a recipient failure continues, a template rejection stops the round", async () => {
    const results: SendResult[] = [
      { ok: false, message: "تعذّر التسليم لهذا الرقم", retriable: false, recipientOnly: true },
      { ok: false, message: "قالب التذكير غير معتمد", retriable: false, recipientOnly: false },
      ok,
    ];
    let call = 0;
    const d = deps({ appointmentsOn: async () => [appt(1), appt(2), appt(3)], send: async () => results[call++] });
    const run = await runAutoReminders(input, d.value);
    expect(d.log.filter((entry) => entry.startsWith("release"))).toEqual(["release:1", "release:2"]);
    expect(call).toBe(2);
    expect(run).toMatchObject({ sent: 0, failed: 2, stoppedBecause: "قالب التذكير غير معتمد" });
  });

  it("the round is capped", async () => {
    const d = deps({ appointmentsOn: async () => [appt(1), appt(2), appt(3)] });
    expect(await runAutoReminders({ ...input, limit: 2 }, d.value)).toMatchObject({ candidates: 2, sent: 2 });
  });
});

describe("settings", () => {
  it("auto reminders are off by default; template name and language are validated", () => {
    expect(SETTING_DEFAULTS["reminders.auto_enabled"]).toBe("false");
    expect(validateSetting("reminders.auto_template", "appointment_reminder")).toBeNull();
    expect(validateSetting("reminders.auto_template", "تذكير")).toMatch(/Meta/);
    expect(validateSetting("reminders.auto_language", "ar")).toBeNull();
    expect(validateSetting("reminders.auto_language", "arabic")).not.toBeNull();
  });
});
