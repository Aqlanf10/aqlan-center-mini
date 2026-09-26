import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { constantTimeEqual, parseSmsInbound, parseWhatsAppWebhook, validMetaSignature } from "@/lib/messaging-inbound";
import { smsReceive, whatsAppReceive, whatsAppVerify, type WebhookChannel, type WebhookDeps } from "@/lib/messaging-webhooks";

const APP_SECRET = "app-secret-123";
const sign = (body: string, secret = APP_SECRET) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

function deps(channel: Partial<WebhookChannel> = {}, patientId: number | null = 7) {
  const recorded: Parameters<WebhookDeps["recordInbound"]>[0][] = [];
  const failed: string[] = [];
  const value: WebhookDeps = {
    channel: vi.fn(async () => ({
      enabled: true,
      config: { verifyToken: "verify-abc", inboundKey: "inbound-xyz" },
      secrets: { appSecret: APP_SECRET },
      ...channel,
    })),
    patientFor: vi.fn(async () => patientId),
    recordInbound: vi.fn(async (entry) => { recorded.push(entry); }),
    markFailed: vi.fn(async (_channel, id) => { failed.push(id); }),
  };
  return { value, recorded, failed };
}

const inboundPayload = JSON.stringify({
  entry: [{
    changes: [{
      value: {
        messages: [
          { from: "967777123456", id: "wamid.A", timestamp: "1780000000", type: "text", text: { body: "هل موعدي غدًا؟" } },
          { from: "967777123456", id: "wamid.B", type: "image", image: {} },
        ],
        statuses: [
          { id: "wamid.OUT1", status: "failed", errors: [{ code: 131026 }] },
          { id: "wamid.OUT2", status: "delivered" },
        ],
      },
    }],
  }],
});

describe("MSG-2 inbound parsing", () => {
  it("verifies Meta signatures in constant time and rejects tampering", () => {
    expect(validMetaSignature("{}", sign("{}"), APP_SECRET)).toBe(true);
    expect(validMetaSignature("{ }", sign("{}"), APP_SECRET)).toBe(false);
    expect(validMetaSignature("{}", sign("{}", "other"), APP_SECRET)).toBe(false);
    expect(validMetaSignature("{}", null, APP_SECRET)).toBe(false);
    expect(validMetaSignature("{}", sign("{}", ""), "")).toBe(false);
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
  });

  it("extracts text, media placeholders and failed statuses", () => {
    const parsed = parseWhatsAppWebhook(JSON.parse(inboundPayload));
    expect(parsed.messages.map((message) => message.body)).toEqual(["هل موعدي غدًا؟", "[صورة]"]);
    expect(parsed.messages[0].at?.toISOString()).toBe(new Date(1780000000 * 1000).toISOString());
    expect(parsed.statuses).toEqual([
      { providerMessageId: "wamid.OUT1", status: "failed", error: "لم تُسلَّم الرسالة لدى واتساب (رمز 131026)." },
      { providerMessageId: "wamid.OUT2", status: "delivered", error: null },
    ]);
    expect(parseWhatsAppWebhook(null)).toEqual({ messages: [], statuses: [] });
    expect(parseWhatsAppWebhook({ entry: [{ changes: "x" }] })).toEqual({ messages: [], statuses: [] });
  });

  it("accepts common SMS gateway field names", () => {
    expect(parseSmsInbound({ msisdn: "+967 777-123-456", message: "نعم", msgid: 55 }))
      .toEqual({ from: "967777123456", body: "نعم", providerMessageId: "55", at: null });
    expect(parseSmsInbound({ from: "777", text: "  " })).toBeNull();
    expect(parseSmsInbound({ text: "بلا رقم" })).toBeNull();
  });
});

describe("MSG-2 WhatsApp webhook", () => {
  it("answers the subscription challenge only for the generated verify token", async () => {
    const { value } = deps();
    const ok = new URLSearchParams({ "hub.mode": "subscribe", "hub.verify_token": "verify-abc", "hub.challenge": "12345" });
    expect(await whatsAppVerify(ok, value)).toEqual({ status: 200, text: "12345" });
    ok.set("hub.verify_token", "wrong");
    expect((await whatsAppVerify(ok, value)).status).toBe(403);
    const empty = deps({ config: { verifyToken: "" } });
    const params = new URLSearchParams({ "hub.mode": "subscribe", "hub.verify_token": "", "hub.challenge": "1" });
    expect((await whatsAppVerify(params, empty.value)).status).toBe(403);
  });

  it("rejects unsigned, forged, or secretless deliveries without touching the log", async () => {
    const { value, recorded } = deps();
    expect((await whatsAppReceive(inboundPayload, null, value)).status).toBe(403);
    expect((await whatsAppReceive(inboundPayload, sign(inboundPayload, "forged"), value)).status).toBe(403);
    const noSecret = deps({ secrets: {} });
    expect((await whatsAppReceive(inboundPayload, sign(inboundPayload), noSecret.value)).status).toBe(403);
    expect(recorded).toHaveLength(0);
    expect(noSecret.recorded).toHaveLength(0);
  });

  it("stores signed inbound replies linked to the patient and flips failed deliveries", async () => {
    const { value, recorded, failed } = deps();
    const outcome = await whatsAppReceive(inboundPayload, sign(inboundPayload), value);
    expect(outcome).toMatchObject({ status: 200, received: 2 });
    expect(recorded.map((entry) => [entry.channel, entry.patientId, entry.message.providerMessageId]))
      .toEqual([["whatsapp", 7, "wamid.A"], ["whatsapp", 7, "wamid.B"]]);
    expect(failed).toEqual(["wamid.OUT1"]);
  });

  it("ignores (200) deliveries on a disabled channel so Meta stops retrying", async () => {
    const { value, recorded } = deps({ enabled: false });
    expect(await whatsAppReceive(inboundPayload, sign(inboundPayload), value)).toMatchObject({ status: 200, received: 0 });
    expect(recorded).toHaveLength(0);
  });

  it("rejects a signed but malformed body", async () => {
    const { value } = deps();
    expect((await whatsAppReceive("not-json", sign("not-json"), value)).status).toBe(400);
  });
});

describe("MSG-2 SMS webhook", () => {
  it("requires the generated inbound key", async () => {
    const { value, recorded } = deps();
    expect((await smsReceive("", { from: "777123456", text: "x" }, value)).status).toBe(403);
    expect((await smsReceive("wrong", { from: "777123456", text: "x" }, value)).status).toBe(403);
    const unset = deps({ config: { inboundKey: "" } });
    expect((await smsReceive("", { from: "777123456", text: "x" }, unset.value)).status).toBe(403);
    expect(recorded).toHaveLength(0);
  });

  it("stores a keyed inbound SMS and rejects incomplete ones", async () => {
    const { value, recorded } = deps({}, null);
    expect(await smsReceive("inbound-xyz", { sender: "777123456", body: "شكرًا" }, value)).toMatchObject({ status: 200, received: 1 });
    expect(recorded[0]).toMatchObject({ channel: "sms", patientId: null, message: { from: "777123456", body: "شكرًا" } });
    expect((await smsReceive("inbound-xyz", { sender: "777123456" }, value)).status).toBe(400);
  });
});
