import { describe, expect, it } from "vitest";
import { buildSmsRequest, DEFAULT_CONFIG, normalizeChannelConfig, smsRecipient, smsResponseOk } from "../lib/messaging-channels";
import { whatsAppSendConfig } from "../lib/messaging-send";
import { whatsAppEndpoint } from "../lib/whatsapp-cloud";

/** (MSG-1) إعدادات القنوات وموصل بوابة الرسائل النصية. */

describe("channel config validation (Arabic, per channel)", () => {
  it("an enabled channel must be complete; a disabled one may be saved as a draft", () => {
    expect(normalizeChannelConfig("whatsapp", {}, true)).toMatchObject({ ok: false, message: expect.stringContaining("معرّف رقم الهاتف") });
    expect(normalizeChannelConfig("whatsapp", {}, false)).toMatchObject({ ok: true });
    expect(normalizeChannelConfig("sms", {}, true)).toMatchObject({ ok: false, message: expect.stringContaining("عنوان بوابة") });
    expect(normalizeChannelConfig("email", { host: "smtp.gmail.com" }, true)).toMatchObject({ ok: false });
    expect(normalizeChannelConfig("email", { host: "smtp.gmail.com", fromAddress: "clinic@example.com", port: 465, security: "tls" }, true))
      .toMatchObject({ ok: true, config: { port: 465, security: "tls" } });
  });

  it("refuses an http gateway (the key would travel unencrypted) and unsafe field names", () => {
    expect(normalizeChannelConfig("sms", { url: "http://gw.example/send" }, false)).toMatchObject({ ok: false, message: expect.stringContaining("https") });
    expect(normalizeChannelConfig("sms", { url: "https://gw.example/send", toParam: "to&x=1" }, false)).toMatchObject({ ok: false });
    expect(normalizeChannelConfig("whatsapp", { phoneNumberId: "12ab" }, false)).toMatchObject({ ok: false });
  });
});

describe("SMS gateway connector", () => {
  const config = { ...DEFAULT_CONFIG.sms, url: "https://gw.example/api/send", sender: "AqlanClinic", username: "aqlan" };

  it("formats the recipient as the gateway expects", () => {
    expect(smsRecipient("0771000001", "international")).toBe("967771000001");
    expect(smsRecipient("+967 771 000 001", "local")).toBe("771000001");
    expect(smsRecipient("04-253028", "international")).toBeNull();
  });

  it("builds form POST, JSON POST and GET requests with the configured field names", () => {
    const form = buildSmsRequest(config, "KEY", "967771000001", "موعدكم غدًا");
    expect(form).toMatchObject({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" } });
    expect(Object.fromEntries(new URLSearchParams(form.body!))).toEqual({
      to: "967771000001", message: "موعدكم غدًا", sender: "AqlanClinic", username: "aqlan", api_key: "KEY",
    });
    const json = buildSmsRequest({ ...config, bodyFormat: "json", toParam: "mobile", textParam: "text" }, "KEY", "967771000001", "نص");
    expect(JSON.parse(json.body!)).toMatchObject({ mobile: "967771000001", text: "نص" });
    const get = buildSmsRequest({ ...config, method: "GET" }, "KEY", "967771000001", "نص");
    expect(get.body).toBeNull();
    expect(new URL(get.url).searchParams.get("to")).toBe("967771000001");
  });

  it("success = 2xx, and the success text when configured", () => {
    expect(smsResponseOk(200, "OK:123", "")).toBe(true);
    expect(smsResponseOk(200, "ERROR: balance", "OK")).toBe(false);
    expect(smsResponseOk(500, "OK", "")).toBe(false);
  });
});

describe("MSG-3 WhatsApp through a Meta partner (coexistence with the phone app)", () => {
  it("a partner channel needs its https API address instead of the Meta phone number id", () => {
    expect(normalizeChannelConfig("whatsapp", { provider: "bsp" }, true)).toMatchObject({ ok: false, message: expect.stringContaining("المزوّد الشريك") });
    expect(normalizeChannelConfig("whatsapp", { provider: "bsp", apiBaseUrl: "http://waba.example" }, false))
      .toMatchObject({ ok: false, message: expect.stringContaining("https") });
    expect(normalizeChannelConfig("whatsapp", { provider: "bsp", apiBaseUrl: "https://waba-v2.360dialog.io/" }, true))
      .toMatchObject({ ok: true, config: { provider: "bsp", apiBaseUrl: "https://waba-v2.360dialog.io", authHeader: "D360-API-KEY" } });
    expect(normalizeChannelConfig("whatsapp", { provider: "bsp", apiBaseUrl: "https://x.example", authHeader: "Bad Header" }, false)).toMatchObject({ ok: false });
    expect(normalizeChannelConfig("whatsapp", { provider: "bsp", apiBaseUrl: "https://x.example", authHeader: "Cookie" }, false)).toMatchObject({ ok: false });
    expect(normalizeChannelConfig("whatsapp", { provider: "anything" }, false)).toMatchObject({ ok: true, config: { provider: "meta" } });
  });

  it("sends to the partner's /messages with its key header, or to Meta's Graph with a bearer token", () => {
    const partner = whatsAppSendConfig({ ...DEFAULT_CONFIG.whatsapp, provider: "bsp", apiBaseUrl: "https://waba-v2.360dialog.io" }, "k-123");
    expect(whatsAppEndpoint(partner)).toEqual({
      url: "https://waba-v2.360dialog.io/messages",
      headers: { "D360-API-KEY": "k-123", "content-type": "application/json" },
    });
    const meta = whatsAppSendConfig({ ...DEFAULT_CONFIG.whatsapp, phoneNumberId: "123456789" }, "t-1");
    expect(whatsAppEndpoint(meta)).toEqual({
      url: "https://graph.facebook.com/v21.0/123456789/messages",
      headers: { authorization: "Bearer t-1", "content-type": "application/json" },
    });
  });
});
