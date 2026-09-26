import { describe, expect, it } from "vitest";
import { buildSmsRequest, DEFAULT_CONFIG, normalizeChannelConfig, smsRecipient, smsResponseOk } from "../lib/messaging-channels";

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
