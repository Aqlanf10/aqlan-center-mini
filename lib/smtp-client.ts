/**
 * (MSG-1) عميل SMTP صغير بلا مكتبة — لإرسال بريد المركز من خادمه (Gmail، بريد النطاق، أي مزوّد).
 *
 * يدعم: TLS مباشر (منفذ 465) أو STARTTLS (منفذ 587)، والمصادقة PLAIN ثم LOGIN، ونصًّا
 * عربيًّا (UTF-8 بترميز base64 للعنوان والجسم). ولا يرسل كلمة المرور أبدًا على اتصالٍ غير مشفّر:
 * خادمٌ لا يعرض STARTTLS على منفذ 587 يُرفض قبل المصادقة.
 *
 * النقل قابلٌ للحقن (اتصالٌ وترقية TLS) — فيُختبر الحوار كله مع خادمٍ وهميّ في الذاكرة.
 * ورسائل الخطأ عربية معقّمة: لا كلمة مرور ولا ردّ خادمٍ خام.
 */
import net from "node:net";
import tls from "node:tls";
import type { Duplex } from "node:stream";
import { randomUUID } from "node:crypto";

export interface SmtpOptions {
  host: string;
  port: number;
  security: "tls" | "starttls";
  username: string;
  password: string;
}

export interface MailMessage {
  fromAddress: string;
  fromName: string;
  to: string;
  subject: string;
  text: string;
}

export interface SmtpTransport {
  connect(options: SmtpOptions): Duplex;
  upgrade(socket: Duplex, host: string): Duplex;
}

export const nodeSmtpTransport: SmtpTransport = {
  connect: (options) => options.security === "tls"
    ? tls.connect({ host: options.host, port: options.port, servername: options.host })
    : net.connect({ host: options.host, port: options.port }),
  upgrade: (socket, host) => tls.connect({ socket: socket as net.Socket, servername: host }),
};

export type SmtpResult = { ok: true; messageId: string } | { ok: false; message: string };

class SmtpError extends Error {
  constructor(readonly arabic: string) { super(arabic); }
}

/** يقرأ ردود الخادم سطرًا سطرًا — الرد متعدد الأسطر ينتهي بسطرٍ «رمز + مسافة». */
class ReplyReader {
  private buffer = "";
  private waiting: ((reply: { code: number; lines: string[] }) => void) | null = null;
  private failed: ((error: Error) => void) | null = null;
  private pending: string[] = [];

  constructor(private socket: Duplex) {
    this.attach(socket);
  }

  attach(socket: Duplex): void {
    this.socket = socket;
    socket.on("data", (chunk: Buffer) => this.feed(chunk.toString("utf8")));
    socket.on("error", () => this.fail(new SmtpError("انقطع الاتصال بخادم البريد.")));
    socket.on("close", () => this.fail(new SmtpError("أغلق خادم البريد الاتصال.")));
  }

  private fail(error: Error): void {
    const reject = this.failed;
    this.waiting = null;
    this.failed = null;
    reject?.(error);
  }

  private feed(data: string): void {
    this.buffer += data;
    let index: number;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/, "");
      this.buffer = this.buffer.slice(index + 1);
      this.pending.push(line);
      if (/^\d{3} /.test(line) || /^\d{3}$/.test(line)) {
        const lines = this.pending;
        this.pending = [];
        const resolve = this.waiting;
        this.waiting = null;
        this.failed = null;
        resolve?.({ code: Number(line.slice(0, 3)), lines });
      }
    }
  }

  next(timeoutMs: number): Promise<{ code: number; lines: string[] }> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting = null;
        this.failed = null;
        reject(new SmtpError("لم يستجب خادم البريد في الوقت المحدد."));
      }, timeoutMs);
      this.waiting = (reply) => { clearTimeout(timer); resolve(reply); };
      this.failed = (error) => { clearTimeout(timer); reject(error); };
    });
  }
}

function encodeWord(value: string): string {
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function base64Lines(value: string): string {
  return (Buffer.from(value, "utf8").toString("base64").match(/.{1,76}/g) ?? []).join("\r\n");
}

/** نص الرسالة كما يُرسل بعد DATA — دالة خالصة. */
export function buildMimeMessage(message: MailMessage, messageId: string, date = new Date()): string {
  const clean = (value: string) => value.replace(/[\r\n]+/g, " ").trim();
  const from = message.fromName ? `${encodeWord(clean(message.fromName))} <${clean(message.fromAddress)}>` : `<${clean(message.fromAddress)}>`;
  return [
    `From: ${from}`,
    `To: <${clean(message.to)}>`,
    `Subject: ${encodeWord(clean(message.subject))}`,
    `Date: ${date.toUTCString()}`,
    `Message-ID: <${messageId}>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(message.text),
  ].join("\r\n");
}

export async function sendMail(
  options: SmtpOptions,
  message: MailMessage,
  transport: SmtpTransport = nodeSmtpTransport,
  timeoutMs = 20_000,
): Promise<SmtpResult> {
  let socket: Duplex | null = null;
  try {
    socket = transport.connect(options);
    const reader = new ReplyReader(socket);
    const expect = async (codes: number[], arabic: string) => {
      const reply = await reader.next(timeoutMs);
      if (!codes.includes(reply.code)) throw new SmtpError(arabic);
      return reply;
    };
    const send = (line: string) => { socket!.write(`${line}\r\n`); };

    await expect([220], "خادم البريد لم يرحّب بالاتصال.");
    send("EHLO aqlan-clinic");
    let ehlo = await expect([250], "رفض خادم البريد التعريف (EHLO).");
    if (options.security === "starttls") {
      if (!ehlo.lines.some((line) => /STARTTLS/i.test(line))) {
        throw new SmtpError("خادم البريد لا يدعم التشفير (STARTTLS) — لن تُرسل كلمة المرور بلا تشفير.");
      }
      send("STARTTLS");
      await expect([220], "رفض خادم البريد بدء التشفير.");
      socket.removeAllListeners("data");
      socket.removeAllListeners("error");
      socket.removeAllListeners("close");
      socket = transport.upgrade(socket, options.host);
      reader.attach(socket);
      send("EHLO aqlan-clinic");
      ehlo = await expect([250], "رفض خادم البريد التعريف بعد التشفير.");
    }

    const authLine = ehlo.lines.find((line) => /AUTH/i.test(line)) ?? "";
    if (options.username) {
      if (/PLAIN/i.test(authLine) || !/LOGIN/i.test(authLine)) {
        send(`AUTH PLAIN ${Buffer.from(`\u0000${options.username}\u0000${options.password}`, "utf8").toString("base64")}`);
      } else {
        send("AUTH LOGIN");
        await expect([334], "رفض خادم البريد طريقة الدخول.");
        send(Buffer.from(options.username, "utf8").toString("base64"));
        await expect([334], "رفض خادم البريد اسم المستخدم.");
        send(Buffer.from(options.password, "utf8").toString("base64"));
      }
      await expect([235], "رفض خادم البريد اسم المستخدم أو كلمة المرور (في Gmail استعمل «كلمة مرور التطبيق»).");
    }

    send(`MAIL FROM:<${message.fromAddress}>`);
    await expect([250], "رفض خادم البريد عنوان المرسل.");
    send(`RCPT TO:<${message.to}>`);
    await expect([250, 251], "رفض خادم البريد عنوان المستلم.");
    send("DATA");
    await expect([354], "رفض خادم البريد استقبال الرسالة.");
    const messageId = `${randomUUID()}@aqlan-clinic`;
    const body = buildMimeMessage(message, messageId).replace(/\r\n\./g, "\r\n..");
    socket.write(`${body}\r\n.\r\n`);
    await expect([250], "لم يقبل خادم البريد الرسالة.");
    send("QUIT");
    return { ok: true, messageId };
  } catch (error) {
    return { ok: false, message: error instanceof SmtpError ? error.arabic : "تعذّر الاتصال بخادم البريد." };
  } finally {
    socket?.end();
    socket?.destroy();
  }
}
