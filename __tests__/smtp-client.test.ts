import { afterEach, describe, expect, it } from "vitest";
import net from "node:net";
import { buildMimeMessage, sendMail, type SmtpTransport } from "../lib/smtp-client";

/**
 * (MSG-1) عميل SMTP مع خادمٍ وهميّ محلي: الحوار كله، وكلمة المرور لا تُرسل قبل التشفير،
 * والعنوان العربي مرمَّز. (ترقية TLS محقونة كهويةٍ في الاختبار.)
 */

let server: net.Server | null = null;
afterEach(() => { server?.close(); server = null; });

async function fakeServer(options: { starttls: boolean; authOk?: boolean }): Promise<{ port: number; log: string[] }> {
  const log: string[] = [];
  server = net.createServer((socket) => {
    let inData = false;
    let buffer = "";
    socket.write("220 fake ESMTP\r\n");
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let index: number;
      while ((index = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        log.push(line);
        if (inData) {
          if (line === ".") { inData = false; socket.write("250 queued\r\n"); }
          continue;
        }
        if (line.startsWith("EHLO")) socket.write(options.starttls ? "250-fake\r\n250-STARTTLS\r\n250 AUTH PLAIN LOGIN\r\n" : "250-fake\r\n250 AUTH PLAIN\r\n");
        else if (line === "STARTTLS") socket.write("220 go ahead\r\n");
        else if (line.startsWith("AUTH")) socket.write(options.authOk === false ? "535 bad credentials\r\n" : "235 ok\r\n");
        else if (line.startsWith("MAIL FROM") || line.startsWith("RCPT TO")) socket.write("250 ok\r\n");
        else if (line === "DATA") { inData = true; socket.write("354 go\r\n"); }
        else if (line === "QUIT") socket.end("221 bye\r\n");
      }
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return { port: (server!.address() as net.AddressInfo).port, log };
}

const transport: SmtpTransport = {
  connect: (options) => net.connect({ host: "127.0.0.1", port: options.port }),
  upgrade: (socket) => socket,
};

const message = { fromAddress: "clinic@example.com", fromName: "مركز عقلان", to: "patient@example.com", subject: "موعدكم", text: "السلام عليكم" };

describe("sendMail", () => {
  it("speaks STARTTLS before AUTH and delivers the message", async () => {
    const { port, log } = await fakeServer({ starttls: true });
    const result = await sendMail({ host: "fake", port, security: "starttls", username: "u", password: "secret-pass" }, message, transport, 5000);
    expect(result.ok).toBe(true);
    const starttls = log.indexOf("STARTTLS");
    const auth = log.findIndex((line) => line.startsWith("AUTH"));
    expect(starttls).toBeGreaterThanOrEqual(0);
    expect(auth).toBeGreaterThan(starttls);
    expect(log).toContain("MAIL FROM:<clinic@example.com>");
    expect(log).toContain("RCPT TO:<patient@example.com>");
    expect(log.some((line) => line.startsWith("Subject: =?UTF-8?B?"))).toBe(true);
  });

  it("refuses to send the password when the server offers no STARTTLS", async () => {
    const { port, log } = await fakeServer({ starttls: false });
    const result = await sendMail({ host: "fake", port, security: "starttls", username: "u", password: "secret-pass" }, message, transport, 5000);
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining("التشفير") });
    expect(log.some((line) => line.startsWith("AUTH"))).toBe(false);
  });

  it("reports rejected credentials in Arabic without echoing the password", async () => {
    const { port } = await fakeServer({ starttls: true, authOk: false });
    const result = await sendMail({ host: "fake", port, security: "starttls", username: "u", password: "secret-pass" }, message, transport, 5000);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("كلمة المرور");
      expect(result.message).not.toContain("secret-pass");
    }
  });

  it("builds a UTF-8 base64 MIME message", () => {
    const mime = buildMimeMessage(message, "id@x", new Date("2026-09-26T00:00:00Z"));
    expect(mime).toContain("Content-Type: text/plain; charset=UTF-8");
    expect(mime).toContain(`From: =?UTF-8?B?${Buffer.from("مركز عقلان").toString("base64")}?= <clinic@example.com>`);
    expect(Buffer.from(mime.split("\r\n\r\n")[1].replace(/\r\n/g, ""), "base64").toString("utf8")).toBe("السلام عليكم");
  });
});
