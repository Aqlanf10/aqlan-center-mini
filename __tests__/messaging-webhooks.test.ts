import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { constantTimeEqual, parseSmsInbound, parseWhatsAppWebhook, validMetaSignature } from "@/lib/messaging-inbound";
import { smsReceive, whatsAppReceive, whatsAppVerify, type WebhookChannel, type WebhookDeps } from "@/lib/messaging-webhooks";

const APP_SECRET = "app-secret-123";
const sign = (body: string, secret = APP_SECRET) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

function deps(channel: Partial<WebhookChannel> = {}, patientId: number | null = 7) {
  const recorded: Parameters<WebhookDeps["recordInbound"]>[0][] = [];
  const failed: string[] = [];
  const echoed: Parameters<WebhookDeps["recordEcho"]>[0][] = [];
  const value: WebhookDeps = {
    channel: vi.fn(async () => ({
      enabled: true,
      config: { verifyToken: "verify-abc", inboundKey: "inbound-xyz" },
      secrets: { appSecret: APP_SECRET },
      ...channel,
    })),
    patientFor: vi.fn(async () => patientId),
    recordInbound: vi.fn(async (entry) => { recorded.push(entry); }),
    recordEcho: vi.fn(async (entry) => { echoed.push(entry); }),
    markFailed: vi.fn(async (_channel, id) => { failed.push(id); }),
  };
  return { value, recorded, failed, echoed };
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
    expect(parseWhatsAppWebhook(null)).toEqual({ messages: [], statuses: [], echoes: [] });
    expect(parseWhatsAppWebhook({ entry: [{ changes: "x" }] })).toEqual({ messages: [], statuses: [], echoes: [] });
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

const echoPayload = JSON.stringify({
  entry: [{
    changes: [{
      field: "smb_message_echoes",
      value: {
        message_echoes: [
          { from: "967730000000", to: "967777123456", id: "wamid.APP1", timestamp: "1780000100", type: "text", text: { body: "موعدك غدًا الساعة ٤" } },
          { from: "967730000000", to: "967777123456", id: "wamid.APP2", type: "revoke", revoke: {} },
          { from: "967730000000", to: "967777123456", id: "wamid.APP3", type: "document", document: {} },
        ],
      },
    }],
  }],
});

describe("MSG-3 coexistence (number stays in the WhatsApp Business app)", () => {
  const bsp = { config: { provider: "bsp", inboundKey: "bsp-key-1", verifyToken: "verify-abc" }, secrets: {} };

  it("parses app echoes and skips revokes and edits", () => {
    const { echoes } = parseWhatsAppWebhook(JSON.parse(echoPayload));
    expect(echoes.map((echo) => [echo.to, echo.providerMessageId, echo.body])).toEqual([
      ["967777123456", "wamid.APP1", "موعدك غدًا الساعة ٤"],
      ["967777123456", "wamid.APP3", "[مستند]"],
    ]);
  });

  it("records messages sent from the phone app as outbound, linked to the patient", async () => {
    const { value, echoed, recorded } = deps();
    expect((await whatsAppReceive(echoPayload, sign(echoPayload), value)).status).toBe(200);
    expect(echoed.map((entry) => [entry.patientId, entry.message.providerMessageId])).toEqual([[7, "wamid.APP1"], [7, "wamid.APP3"]]);
    expect(recorded).toHaveLength(0);
  });

  it("a partner (BSP) channel is guarded by the generated key, not by a Meta signature", async () => {
    const { value, recorded } = deps(bsp);
    expect((await whatsAppReceive(inboundPayload, null, value)).status).toBe(403);
    expect((await whatsAppReceive(inboundPayload, null, value, "wrong")).status).toBe(403);
    // توقيع Meta صحيح لا يغني عن المفتاح على قناة المزوّد الشريك.
    expect((await whatsAppReceive(inboundPayload, sign(inboundPayload), value)).status).toBe(403);
    expect(recorded).toHaveLength(0);
    expect(await whatsAppReceive(inboundPayload, null, value, "bsp-key-1")).toMatchObject({ status: 200, received: 2 });
    const unset = deps({ config: { provider: "bsp", inboundKey: "" }, secrets: {} });
    expect((await whatsAppReceive(inboundPayload, null, unset.value, "")).status).toBe(403);
  });

  it("a Meta channel ignores the key and still requires the signature", async () => {
    const { value } = deps({ config: { provider: "meta", inboundKey: "k" } });
    expect((await whatsAppReceive(inboundPayload, null, value, "k")).status).toBe(403);
  });

  it("the Meta subscription challenge is refused on a partner channel", async () => {
    const { value } = deps(bsp);
    const params = new URLSearchParams({ "hub.mode": "subscribe", "hub.verify_token": "verify-abc", "hub.challenge": "1" });
    expect((await whatsAppVerify(params, value)).status).toBe(403);
  });
});
