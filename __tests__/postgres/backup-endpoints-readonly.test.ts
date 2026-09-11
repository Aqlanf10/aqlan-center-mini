import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "pg";

/**
 * الإثبات الحاسم لمسار النسخ — نقاط النسخ كلها **لا تصدر أي DML/DDL**:
 *
 * يدخل الاختبار فعليًّا في كل نقطة من نقاط النسخ (بوابة التفعيل، حالة النسخ،
 * «نسخ الآن» اليدوي، نقطة المجدول الداخلية مع دورة كاملة) على قاعدة PG 18
 * حقيقية، ويُسجِّل كل جملة SQL تصل القاعدة عبر المجمع نفسه (query ومتصلاته
 * كلها مغلَّفة) — ثم يُثبت أن كل ما وصل: SELECT/BEGIN/COMMIT/ROLLBACK/SET
 * حصرًا، بلا CREATE ولا ALTER ولا DROP ولا INSERT ولا UPDATE ولا DELETE.
 *
 * ويُثبت أيضًا الفشل المغلق: جدول settings مُسقط ⇒ نقطة «نسخ الآن» ونقطة
 * المجدول ترجان 503 لا إصلاحًا؛ جدول users مُسقط ⇒ المصادقة تفشل مغلقًا.
 *
 * جلسة المدير هنا كوكي موقّعة حقيقية (HMAC) مبنيّة على صف مستخدمٍ مُدرَج —
 * نفس مسار المصادقة القرائي (requireBackupAdminReadOnly).
 */

const state = vi.hoisted(() => ({
  cookieValue: null as string | null,
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (state.cookieValue ? { name, value: state.cookieValue } : undefined),
  }),
  headers: async () => new Headers(),
}));

const DATABASE_NAME = `aqlan_backup_endpoints_${process.pid}_${Date.now()}`.toLowerCase();
const SESSION_SECRET = "pr21-endpoints-readonly-test-secret-0123456789abcdef";

let client: Client;
let volume: string;
let documentsDir: string;
let adminCookieToken = "";

// الوحدات تُستورد ديناميكيًّا بعد ضبط البيئة (المجمع يُبنى عند أول getPool)
type RouteModule = Record<string, (...args: never[]) => unknown> & { POST?: (request?: unknown) => Promise<Response>; GET?: () => Promise<Response> };
let productionBackupRoute: RouteModule;
let backupStatusRoute: RouteModule;
let backupRunRoute: RouteModule;
let backupConfigRoute: RouteModule;
let internalRunRoute: RouteModule;

const recorded: string[] = [];

beforeAll(async () => {
  console.log("STEP-0: start");
  // ١) بيئة الاتصال: قاعدة معزولة عبر DATABASE_URL (نطاق محلي: بلا RAILWAY_PROJECT_ID)
  const { createIsolatedDatabase } = await import("./_setup");
  const url = await createIsolatedDatabase(DATABASE_NAME);
  console.log("STEP-1: isolated db ready");
  process.env.DATABASE_URL = url;
  process.env.SESSION_SECRET = SESSION_SECRET;
  delete process.env.RAILWAY_PROJECT_ID;
  delete process.env.USE_LOCAL_DB;

  // ٢) إشارات التشغيل الإنتاجي لنقطة المجدول (SERVICE_ID وحدها تكفي كإشارة
  //    Railway مع DATABASE_ENVIRONMENT=production — ولا تعيد كتابة رابط القاعدة)
  process.env.DATABASE_ENVIRONMENT = "production";
  process.env.RAILWAY_SERVICE_ID = "srv-pr21-endpoints-test";
  process.env.INTERNAL_BACKUP_RUN_TOKEN = "internal-run-secret-token-pr21";
  delete process.env.PRODUCTION_BACKUP_ONCE_TOKEN;
  delete process.env.BACKUP_ENCRYPTION_KEY;

  // ٣) القرص الدائم المزيف ودليل المستندات داخله
  volume = await mkdtemp(path.join(tmpdir(), "aqlan-endpoints-volume-"));
  documentsDir = path.join(volume, "documents");
  await mkdir(documentsDir, { recursive: true });
  process.env.RAILWAY_VOLUME_MOUNT_PATH = volume;
  process.env.DOCUMENTS_DIR = documentsDir;

  // ٤) المخطط الأساسي + مستخدم مدير حقيقي
  client = new Client({ connectionString: url, ssl: false });
  await client.connect();
  const baselineSql = await readFile(path.resolve("migrations/0001_baseline_schema.sql"), "utf8");
  await client.query(baselineSql);
  const { rows } = await client.query<{ id: number }>(
    `INSERT INTO users (username, display_name, password_hash, role, is_active)
     VALUES ('backupadmin', 'مدير النسخ', 'test-password-hash', 'admin', true)
     RETURNING id`,
  );
  const { createSessionToken, sessionCredentialVersion } = await import("../../lib/auth");
  adminCookieToken = createSessionToken({
    userId: rows[0].id,
    username: "backupadmin",
    role: "admin",
    expiresAt: Date.now() + 3_600_000,
    credentialVersion: sessionCredentialVersion("test-password-hash"),
  });
  // الكوكي الموقّعة (اسم الجلسة في التطبيق هو SESSION_COOKIE، والقيمة هي التوكن حصرًا)
  state.cookieValue = adminCookieToken;

  // ٥) مغلّف التسجيل على المجمع نفسه: كل query وكل عميل متصل يُسجَّل ما يرسله.
  //    مهم: صفقة pg الداخلية تنادي connect بصيغة callback — المجلّف يحافظ
  //    على الصيغتين (callback + promise) وإلا علق pool.query إلى الأبد.
  const { getPool } = await import("../../lib/db");
  const pool = getPool() as unknown as {
    query: (...args: unknown[]) => unknown;
    connect: (...args: unknown[]) => unknown;
  };
  const sqlText = (sql: unknown): string =>
    typeof sql === "string" ? sql : String((sql as { text?: string })?.text ?? sql);

  const origPoolQuery = pool.query.bind(pool);
  pool.query = (...args: unknown[]) => {
    recorded.push(sqlText(args[0]));
    return (origPoolQuery as (...a: unknown[]) => unknown)(...args);
  };

  const wrapClient = (connected: unknown): unknown => {
    if (!connected || typeof (connected as { query?: unknown }).query !== "function") return connected;
    const client = connected as { query: (...args: unknown[]) => unknown };
    const origClientQuery = client.query.bind(client);
    client.query = (...args: unknown[]) => {
      recorded.push(sqlText(args[0]));
      return origClientQuery(...args);
    };
    return connected;
  };

  const origPoolConnect = (pool.connect as (...args: unknown[]) => unknown).bind(pool);
  pool.connect = (...args: unknown[]) => {
    if (args.length > 0 && typeof args[0] === "function") {
      // صيغة callback (التي تستعملها صفقة pg داخليًّا) — تمرير حرفي
      const callback = args[0] as (error: unknown, client?: unknown, release?: unknown) => void;
      return origPoolConnect((error: unknown, client?: unknown, release?: unknown) => {
        callback(error, error ? undefined : wrapClient(client), release);
      });
    }
    // صيغة promise — الطريقة التي يستعملها التطبيق
    return (origPoolConnect as () => Promise<unknown>)().then(wrapClient);
  };

  console.log("STEP-6: importing routes");
  // ٦) نقاط النسخ — بعد البيئة والتسجيل
  productionBackupRoute = await import("../../app/api/settings/production-backup/route") as unknown as RouteModule;
  backupStatusRoute = await import("../../app/api/settings/backup/route") as unknown as RouteModule;
  backupRunRoute = await import("../../app/api/settings/backup/run/route") as unknown as RouteModule;
  backupConfigRoute = await import("../../app/api/settings/backup/config/route") as unknown as RouteModule;
  internalRunRoute = await import("../../app/api/internal/backup/run/route") as unknown as RouteModule;
  console.log("STEP-7: routes imported, beforeAll done");
}, 240_000);

afterAll(async () => {
  await client?.end().catch(() => {});
  const { adminClient } = await import("./_setup");
  const admin = adminClient("postgres");
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${DATABASE_NAME} WITH (FORCE)`);
  } finally {
    await admin.end();
  }
  await rm(volume, { recursive: true, force: true }).catch(() => {});
});

/** كل جملة في الشريحة قراءة حصرًا — وبلا أي كلمة DML/DDL في أيٍّ منها. */
function expectSliceReadOnly(mark: number): void {
  const slice = recorded.slice(mark);
  expect(slice.length).toBeGreaterThan(0);
  for (const statement of slice) {
    expect(statement.trim()).toMatch(/^(SELECT|BEGIN|COMMIT|ROLLBACK|SET)\b/i);
  }
  expect(slice.join("\n")).not.toMatch(
    /\b(?:INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE|GRANT|REVOKE|COMMENT|CALL|DO)\b/i,
  );
}

function mark(): number {
  return recorded.length;
}

function adminPost(url: string, body: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: `session=${adminCookieToken}` },
    body: JSON.stringify(body),
  });
}

describe("دخول نقاط النسخ لا يصدر إلا SELECT — إثبات تسجيل SQL على PG 18", () => {
  it("بوابة التفعيل (مدير بكوكي موقّعة) ⇒ 503 fail-closed والمسار SELECT حصرًا", async () => {
    const before = mark();
    console.log("STEP-T1: calling POST");
    const response = await productionBackupRoute.POST!(
      adminPost("http://localhost/api/settings/production-backup", { token: "any-token" }) as never,
    ) as Response;
    console.log("STEP-T1: response", response.status);
    expect(response.status).toBe(503); // بلا PRODUCTION_BACKUP_ONCE_TOKEN — فشل مغلق بعد مصادقة قرائية سليمة
    expectSliceReadOnly(before);
  });

  it("حالة النسخ (مدير) ⇒ 200 معقّم والمسار SELECT حصرًا (users + settings)", async () => {
    const before = mark();
    const response = await backupStatusRoute.GET!() as Response;
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect((body.configSource as Record<string, unknown>).settingsReadable).toBe(true);
    expectSliceReadOnly(before);
  });

  it("(I) «نسخ الآن» اليدوي (مدير) ⇒ 200 دورة كاملة verified والمسار SELECT حصرًا", async () => {
    // التفعيل عبر التجاوز الدائم (J): صفر كتابة في قاعدة الإنتاج
    const configBefore = mark();
    const configResponse = await backupConfigRoute.POST!(
      adminPost("http://localhost/api/settings/backup/config", {
        backupEnabled: true,
      }) as never,
    ) as Response;
    expect(configResponse.status).toBe(200);
    expectSliceReadOnly(configBefore);

    const before = mark();
    const response = await backupRunRoute.POST!() as Response;
    expect(response.status).toBe(200);
    const body = await response.json() as {
      ok: boolean;
      backup: { status: string; triggerType: string; archiveSha256: string; documentCount: number };
      replicationStatus: string;
    };
    expect(body.ok).toBe(true);
    expect(body.backup.status).toBe("verified");
    expect(body.backup.triggerType).toBe("manual");
    expect(body.backup.archiveSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(body.replicationStatus).toBe("complete");
    expectSliceReadOnly(before);
  });

  it("(J+E) نقطة المجدول الداخلية: تفعيل بلا كتابة DB + ادعاء اليوم داخل القفل + SELECT حصرًا", async () => {
    // التجاوز الدائم يفعّل الجدولة ويضبط الوقت 00:00 (مستحق دائمًا)
    const configBefore = mark();
    const configResponse = await backupConfigRoute.POST!(
      adminPost("http://localhost/api/settings/backup/config", {
        scheduleEnabled: true,
        scheduleTime: "00:00",
      }) as never,
    ) as Response;
    expect(configResponse.status).toBe(200);
    expectSliceReadOnly(configBefore);

    const before = mark();
    const response = await internalRunRoute.POST!(
      new Request("http://localhost/api/internal/backup/run", {
        method: "POST",
        headers: { authorization: "Bearer internal-run-secret-token-pr21" },
      }) as never,
    ) as Response;
    expect(response.status).toBe(200);
    const body = await response.json() as {
      ok: boolean; ran: boolean; scheduleDayClaim?: string;
      backup?: { status: string; triggerType: string };
    };
    expect(body.ok).toBe(true);
    expect(body.ran).toBe(true);
    expect(body.backup?.status).toBe("verified");
    expect(body.backup?.triggerType).toBe("scheduled");
    expect(body.scheduleDayClaim).toBe("claimed");
    expectSliceReadOnly(before);

    // ضربة ثانية في نفس اليوم ⇒ already-ran بلا نسخة ثانية
    const secondBefore = mark();
    const second = await internalRunRoute.POST!(
      new Request("http://localhost/api/internal/backup/run", {
        method: "POST",
        headers: { authorization: "Bearer internal-run-secret-token-pr21" },
      }) as never,
    ) as Response;
    const secondBody = await second.json() as { ran: boolean; reason: string };
    expect(secondBody.ran).toBe(false);
    expect(secondBody.reason).toBe("already-ran");
    expectSliceReadOnly(secondBefore);
  });

  it("ملف التجاوز الدائم على القرص — لا أثر لتكوين التفعيل في قاعدة الإنتاج", async () => {
    const overridePath = path.join(volume, "backups", ".backup-state", "backup-config.json");
    const raw = JSON.parse(await readFile(overridePath, "utf8")) as Record<string, unknown>;
    expect(raw.backupEnabled).toBe(true);
    expect(raw.scheduleEnabled).toBe(true);
    expect(raw.scheduleTime).toBe("00:00");
  });
});

describe("الفشل المغلق عند نقص الجداول — لا إصلاح مخططٍ من مسار النسخ (الأخير: يُسقط الجداول)", () => {
  it("settings مُسقط ⇒ «نسخ الآن» ونقطة المجدول 503 بلا أي DDL", async () => {
    await client.query("DROP TABLE settings");
    const recordedBefore = recorded.length;

    const manualResponse = await backupRunRoute.POST!() as Response;
    expect(manualResponse.status).toBe(503);

    const cronResponse = await internalRunRoute.POST!(
      new Request("http://localhost/api/internal/backup/run", {
        method: "POST",
        headers: { authorization: "Bearer internal-run-secret-token-pr21" },
      }) as never,
    ) as Response;
    expect(cronResponse.status).toBe(503);

    // لا شيء وصل القاعدة بعد الإسقاط سوى محاولات قراءة فاشلة — لا DDL إصلاح
    const slice = recorded.slice(recordedBefore).join("\n");
    expect(slice).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE|GRANT|REVOKE|COMMENT|CALL|DO)\b/i);
  });

  it("users مُسقط ⇒ المصادقة القرائية تفشل مغلقًا (503) بلا جلسة مزوّرة ولا إصلاح", async () => {
    await client.query("DROP TABLE users CASCADE");
    const response = await productionBackupRoute.POST!(
      adminPost("http://localhost/api/settings/production-backup", { token: "any-token" }) as never,
    ) as Response;
    expect(response.status).toBe(503);
    const status = await backupStatusRoute.GET!() as Response;
    expect(status.status).toBe(503);

    const slice = recorded.slice(recorded.length - 20).join("\n");
    expect(slice).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE|GRANT|REVOKE|COMMENT|CALL|DO)\b/i);
  });
});
