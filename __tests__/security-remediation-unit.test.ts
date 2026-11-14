import { describe, expect, it, vi } from "vitest";
import { csvCell, csvFile, csvRow } from "../lib/csv";
import {
  assertSafeMessagingOutboundUrl,
  assertSafePublicSmtpTarget,
  validateMessagingOutboundUrl,
  validatePublicSmtpHostAndPort,
} from "../lib/safe-outbound-url";
import { sendOutbound } from "../lib/messaging-send";
import { sendWhatsAppText } from "../lib/whatsapp-cloud";
import { BOOK_RATE_LIMIT } from "../lib/security-limits";
import { voiceMatchesMagicBytes } from "../lib/messages";
import { readFirstSheet } from "../lib/xlsx-reader";
import { POST as postPublicBooking } from "../app/api/book/route";

describe("Security Remediation — Unit Regression Suite", () => {
  describe("CSV export formula injection neutralization with numeric & Arabic preservation", () => {
    it("prefixes formula-initiating strings with a single quote", () => {
      expect(csvCell("=A1+B1")).toBe("'=A1+B1");
      expect(csvCell("=SUM(1,2)")).toBe("\"'=SUM(1,2)\"");
      expect(csvCell("+cmd|' /C calc'!A0")).toBe("'+cmd|' /C calc'!A0");
      expect(csvCell("-1+1")).toBe("'-1+1");
      expect(csvCell("@IMPORTXML(\"https://evil.example\",\"//a\")")).toBe(
        "\"'@IMPORTXML(\"\"https://evil.example\"\",\"\"//a\"\")\"",
      );
      expect(csvCell("\t=1+1")).toBe("'\t=1+1");
      expect(csvCell("\r=1+1")).toBe("\"'\r=1+1\"");
      expect(csvCell("   =HYPERLINK(\"https://evil.example\")")).toBe(
        "\"'   =HYPERLINK(\"\"https://evil.example\"\")\"",
      );
    });

    it("preserves negative/positive numbers, Arabic names, and UTF-8 BOM without corruption", () => {
      expect(csvCell(-1500)).toBe("-1500");
      expect(csvCell("-1500")).toBe("-1500");
      expect(csvCell("-12.50")).toBe("-12.50");
      expect(csvCell(0)).toBe("0");
      expect(csvCell(25000)).toBe("25000");
      expect(csvCell("أحمد محمد عقلان")).toBe("أحمد محمد عقلان");

      const exported = csvFile(["المريض", "الرصيد", "ملاحظة"], [
        ["سارة علي", -2500, "=cmd()"],
      ]);
      expect(exported.startsWith("\uFEFF")).toBe(true);
      expect(csvRow(["سارة علي", -2500, "=cmd()"])).toBe("سارة علي,-2500,'=cmd()");
    });
  });

  describe("Messaging outbound SSRF guard (without copying AI host allowlist)", () => {
    it("allows legitimate regional/partner HTTPS messaging gateways not in AI allowlist", async () => {
      const yemenSms = await assertSafeMessagingOutboundUrl(
        "https://sms.yemen-gateway.example/v1/messages",
        { resolveDns: async () => ["198.51.100.25"] },
      );
      expect(yemenSms.ok).toBe(true);

      const dialog360 = await assertSafeMessagingOutboundUrl(
        "https://waba-v2.360dialog.io/messages",
        { resolveDns: async () => ["203.0.113.42"] },
      );
      expect(dialog360.ok).toBe(true);
    });

    it("blocks HTTP, localhost, cloud metadata, RFC1918, CGNAT, IPv6 loopback, userinfo, and DNS rebinding", async () => {
      expect(validateMessagingOutboundUrl("http://sms.example.com/send").ok).toBe(false);
      expect(validateMessagingOutboundUrl("https://127.0.0.1/send").ok).toBe(false);
      expect(validateMessagingOutboundUrl("https://169.254.169.254/latest/meta-data/").ok).toBe(false);
      expect(validateMessagingOutboundUrl("https://10.0.0.5/api").ok).toBe(false);
      expect(validateMessagingOutboundUrl("https://100.64.10.2/api").ok).toBe(false);
      expect(validateMessagingOutboundUrl("https://[::1]/api").ok).toBe(false);
      expect(validateMessagingOutboundUrl("https://service.railway.internal/api").ok).toBe(false);
      expect(validateMessagingOutboundUrl("https://user:pass@sms.example.com/api").ok).toBe(false);
      expect(validateMessagingOutboundUrl("https://sms.example.com:9200/api").ok).toBe(false);

      const rebinding = await assertSafeMessagingOutboundUrl(
        "https://attacker-rebind.example/send",
        { resolveDns: async () => ["203.0.113.10", "169.254.169.254"] },
      );
      expect(rebinding.ok).toBe(false);
    });

    it("enforces redirect: 'error' and rejects 3xx redirects in SMS and WhatsApp partner gateways", async () => {
      const redirectFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        expect(init?.redirect).toBe("error");
        return new Response("", {
          status: 302,
          headers: { location: "http://169.254.169.254/latest/meta-data" },
        });
      }) as unknown as typeof fetch;

      const waRes = await sendWhatsAppText(
        {
          token: "tok_test",
          phoneNumberId: "12345",
          graphVersion: "v21.0",
          provider: "bsp",
          apiBaseUrl: "https://waba.partner.example/v1",
          authHeader: "D360-API-KEY",
          resolveDns: async () => ["198.51.100.77"],
        },
        "967777123456",
        "اختبار",
        redirectFetch,
      );
      expect(waRes.ok).toBe(false);

      const smsRes = await sendOutbound(
        {
          channel: "sms",
          to: "777123456",
          body: "اختبار",
          patientId: null,
          purpose: "test",
          actor: "admin",
        },
        {
          channel: async () => ({
            view: {
              enabled: true,
              config: {
                url: "https://sms.partner.example/send",
                method: "POST",
                bodyFormat: "json",
                toParam: "to",
                textParam: "message",
                senderParam: "sender",
                userParam: "username",
                keyParam: "api_key",
                sender: "Aqlan",
                username: "",
                numberFormat: "international",
                successPattern: "",
                inboundKey: "",
              },
            },
            secret: "sec_test",
          }),
          record: async () => 1,
          fetchImpl: redirectFetch,
          resolveDns: async () => ["198.51.100.88"],
        },
      );
      expect(smsRes.ok).toBe(false);
    });

    it("validates public SMTP host & standard submission ports and blocks internal targets", async () => {
      expect(validatePublicSmtpHostAndPort("smtp.example.com", 587).ok).toBe(true);
      expect(validatePublicSmtpHostAndPort("smtp.example.com", 465).ok).toBe(true);
      expect(validatePublicSmtpHostAndPort("127.0.0.1", 587).ok).toBe(false);
      expect(validatePublicSmtpHostAndPort("smtp.example.com", 6379).ok).toBe(false);

      const privateDnsSmtp = await assertSafePublicSmtpTarget("mail.rebind.example", 587, {
        resolveDns: async () => ["10.10.0.8"],
      });
      expect(privateDnsSmtp.ok).toBe(false);
    });
  });

  describe("Public booking rate-limit design & pre-quota input filtering", () => {
    it("uses CGNAT-safe source cap and rejects honeypot / invalid phone before touching DB quota", async () => {
      expect(BOOK_RATE_LIMIT.maximum).toBeGreaterThanOrEqual(20);
      expect(BOOK_RATE_LIMIT.windowMinutes).toBe(15);

      const honeypotReq = new Request("http://localhost/api/book", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          patientName: "Bot User",
          patientPhone: "777123456",
          website: "https://spam.example",
        }),
      });
      const hpRes = await postPublicBooking(honeypotReq);
      expect(hpRes.status).toBe(200);

      const badPhoneReq = new Request("http://localhost/api/book", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          patientName: "مراجع",
          patientPhone: "123",
        }),
      });
      const badRes = await postPublicBooking(badPhoneReq);
      expect(badRes.status).toBe(400);
    });
  });

  describe("Chat voice magic-byte verification & XLSX parser hardening", () => {
    it("accepts genuine WebM/Ogg magic headers and rejects HTML/SVG disguised as audio", () => {
      const webmB64 = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]).toString("base64");
      const oggB64 = Buffer.from("OggS\x00\x02\x00\x00\x00\x00\x00\x00", "binary").toString("base64");
      const htmlSpoofB64 = Buffer.from("<script>alert(1)</script>", "utf8").toString("base64");

      expect(voiceMatchesMagicBytes("audio/webm;codecs=opus", webmB64)).toBe(true);
      expect(voiceMatchesMagicBytes("audio/ogg", oggB64)).toBe(true);
      expect(voiceMatchesMagicBytes("audio/ogg", htmlSpoofB64)).toBe(false);
      expect(voiceMatchesMagicBytes("audio/webm", htmlSpoofB64)).toBe(false);
    });

    it("rejects non-ZIP/corrupt payloads cleanly in readFirstSheet", async () => {
      await expect(
        readFirstSheet(new Uint8Array(Buffer.from("not-a-zip-archive", "utf8")), async (b) => b),
      ).rejects.toThrow();
    });
  });
});
