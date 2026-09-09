import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { hashPassword, createSessionToken, sessionCredentialVersion } from "../../lib/auth";

/**
 * إعداد عالمي لاختبارات الأمن HTTP (P2/S14) — يشغّل مرة واحدة لكل جولة
 * vitest في العملية الرئيسية، لا مرة لكل ملف:
 *
 *  1. يتحقق أن البناء قائم (.next/standalone/server.js).
 *  2. ينشئ قاعدة معزولة (aqlan_sec_http) ويهيئ مخططها ويبذر مستخدمي
 *     الأدوار الثمانية ومريضين (أ/ب) — البذر بملح عشوائي، لذا الخادم نفسه
 *     يظل حيًّا طوال الجولة وإلا بطلت التوكنات بإعادة البذر.
 *  3. يشغّل الخادم المستقل بNODE_ENV=production وسرّ اختبار.
 *  4. يكتب حالة البذر (معرفات المرضى) في ملف مؤقت يقرؤه المستعبِر داخل fork
 *     الاختبارات (globalSetup والاختبارات في عمليتين مختلفتين).
 *
 * (P2-FIX-1) دخول المتصفح لا يعيد توكناً في JSON — التوكنات المستخدمة في
 * اختبارات Bearer الصريحة (تدفق التطبيقات الخارجية) تُوقَّع هنا بـ
 * createSessionToken نفسها وبنفس سرّ الخادم: نفس مسار التوقيع الإنتاجي
 * بلا أي باب جديد في التطبيق.
 *
 * تُعاد دالة التفكيك (إيقاف الخادم + إسقاط القاعدة) — تنفذها vitest في النهاية.
 */

const PORT = Number(process.env.SECURITY_HTTP_PORT ?? 3217);
const BASE = `http://127.0.0.1:${PORT}`;
const SESSION_SECRET = "security-http-test-secret-0123456789abcdef";
const DB_NAME = "aqlan_sec_http";
const STATE_FILE = join(process.cwd(), ".sec-http-state.json");

export const TEST_USERS = {
  admin: { username: "secadmin", password: "SecAdmin#Pass1", displayName: "مدير الأمن" },
  doctorA: { username: "secdoctora", password: "SecDocA#Pass1", displayName: "طبيب أ" },
  doctorB: { username: "secdoctorb", password: "SecDocB#Pass1", displayName: "طبيب ب" },
  reception: { username: "secreception", password: "SecRec#Pass11", displayName: "استقبال" },
  accountant: { username: "secaccountant", password: "SecAcc#Pass1", displayName: "محاسب" },
} as const;

export const TEST_PATIENTS = {
  patientA: { patientNumber: "SECA-001", phone: "777100001", fullName: "مريض الأمن أ" },
  patientB: { patientNumber: "SECB-002", phone: "777100002", fullName: "مريض الأمن ب" },
} as const;

function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL?.trim() || process.env.DATABASE_URL?.trim() || "";
  if (!url) {
    throw new Error(
      "TEST_DATABASE_URL أو DATABASE_URL غير مضبوط — اختبارات HTTP الأمنية تحتاج "
      + "خادم PostgreSQL حقيقي.",
    );
  }
  return url;
}

async function recreateIsolatedDatabase(): Promise<string> {
  const url = new URL(testDatabaseUrl());
  const admin = new Client({ connectionString: url.toString(), ssl: false });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${DB_NAME}`);
  } finally {
    await admin.end();
  }
  url.pathname = `/${DB_NAME}`;
  return url.toString();
}

async function runSchemaInit(dbUrl: string): Promise<void> {
  // DATABASE_URL للعملية (getPool يقرأها) — TEST_DATABASE_URL لا يُمسّ:
  // اتصال الإدارة يظل على القاعدة الأصل.
  process.env.DATABASE_URL = dbUrl;
  delete process.env.USE_LOCAL_DB;
  delete process.env.RAILWAY_PROJECT_ID;
  const db = await import("../../lib/db");
  await db.ensureSchema();
  await db.resetPoolForTesting();
}

async function seed(dbUrl: string): Promise<{ patientAId: number; patientBId: number; visitId: number; staffTokens: Record<string, string> }> {
  const client = new Client({ connectionString: dbUrl, ssl: false });
  await client.connect();
  try {
    const [adminHash, docAHash, docBHash, recHash, accHash] = await Promise.all([
      hashPassword(TEST_USERS.admin.password),
      hashPassword(TEST_USERS.doctorA.password),
      hashPassword(TEST_USERS.doctorB.password),
      hashPassword(TEST_USERS.reception.password),
      hashPassword(TEST_USERS.accountant.password),
    ]);

    const { rows: [partyA] } = await client.query(
      `INSERT INTO parties (name, kind) VALUES ('طبيب الأمن أ', 'doctor') RETURNING id`,
    );
    const { rows: [partyB] } = await client.query(
      `INSERT INTO parties (name, kind) VALUES ('طبيب الأمن ب', 'doctor') RETURNING id`,
    );

    const insertUser = async (
      username: string, displayName: string, hash: string,
      role: string, partyId: number | null, permissions: unknown,
    ) => {
      const { rows: [row] } = await client.query(
        `INSERT INTO users (username, display_name, password_hash, role, party_id, permissions)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [username, displayName, hash, role, partyId,
          permissions === null || permissions === undefined ? null : JSON.stringify(permissions)],
      );
      return row.id as number;
    };
    const adminId = await insertUser(TEST_USERS.admin.username, TEST_USERS.admin.displayName, adminHash, "admin", null, null);
    const doctorAId = await insertUser(TEST_USERS.doctorA.username, TEST_USERS.doctorA.displayName, docAHash, "doctor", partyA.id, {
      canViewAllPatients: false, canAddPatient: true, canEditPatient: true, canDeletePatient: false,
      canViewPlans: true, canEditPlans: true, canViewXrays: true, canUploadXrays: true,
      canViewAllAppointments: false, canUseAiChat: true,
    });
    const doctorBId = await insertUser(TEST_USERS.doctorB.username, TEST_USERS.doctorB.displayName, docBHash, "doctor", partyB.id, {
      canViewAllPatients: false, canAddPatient: true, canEditPatient: true, canDeletePatient: false,
      canViewPlans: true, canEditPlans: true, canViewXrays: true, canUploadXrays: true,
      canViewAllAppointments: false, canUseAiChat: true,
    });
    const receptionId = await insertUser(TEST_USERS.reception.username, TEST_USERS.reception.displayName, recHash, "reception", null, null);
    const accountantId = await insertUser(TEST_USERS.accountant.username, TEST_USERS.accountant.displayName, accHash, "accountant", null, {
    // دور المحاسب ليس ضمن أدوار النظام الثلاثة (admin/doctor/reception)،
    // فيرث افتراضيات الطبيب ما لم تُضبط صراحة — نطفئ AI هنا حصرية الاختبار.
    canUseAiChat: false,
  });

    /* (P2-FIX-1) توكنات Bearer الصريحة للتطبيقات الخارجية — توقيعها هنا
       بنفس createSessionToken وسرّ الخادم ونسخة الاعتماد من التجزئة نفسها.
       اختبار «فشل دخول ⇒ لا توكن» يبقى مغطى بأن الاستجابة نفسها لا تحمله. */
    const staffExpiry = Date.now() + 6 * 60 * 60 * 1000;
    const staffTokens: Record<string, string> = {
      [TEST_USERS.admin.username]: createSessionToken({
        userId: adminId, username: TEST_USERS.admin.username, role: "admin",
        expiresAt: staffExpiry, partyId: null,
        credentialVersion: sessionCredentialVersion(adminHash),
      }),
      [TEST_USERS.doctorA.username]: createSessionToken({
        userId: doctorAId, username: TEST_USERS.doctorA.username, role: "doctor",
        expiresAt: staffExpiry, partyId: partyA.id,
        credentialVersion: sessionCredentialVersion(docAHash),
      }),
      [TEST_USERS.doctorB.username]: createSessionToken({
        userId: doctorBId, username: TEST_USERS.doctorB.username, role: "doctor",
        expiresAt: staffExpiry, partyId: partyB.id,
        credentialVersion: sessionCredentialVersion(docBHash),
      }),
      [TEST_USERS.reception.username]: createSessionToken({
        userId: receptionId, username: TEST_USERS.reception.username, role: "reception",
        expiresAt: staffExpiry, partyId: null,
        credentialVersion: sessionCredentialVersion(recHash),
      }),
      [TEST_USERS.accountant.username]: createSessionToken({
        userId: accountantId, username: TEST_USERS.accountant.username, role: "accountant",
        expiresAt: staffExpiry, partyId: null,
        credentialVersion: sessionCredentialVersion(accHash),
      }),
    };

    const { rows: [patientA] } = await client.query(
      `INSERT INTO patients (patient_number, full_name, phone, primary_doctor_id)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [TEST_PATIENTS.patientA.patientNumber, TEST_PATIENTS.patientA.fullName, TEST_PATIENTS.patientA.phone, partyA.id],
    );
    const { rows: [patientB] } = await client.query(
      `INSERT INTO patients (patient_number, full_name, phone, primary_doctor_id)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [TEST_PATIENTS.patientB.patientNumber, TEST_PATIENTS.patientB.fullName, TEST_PATIENTS.patientB.phone, partyB.id],
    );

    // زيارة لمريض أ لدى طبيبه أ — بها تُختبر حدود CDS السريري على زيارة موجودة
    const { rows: [visit] } = await client.query(
      `INSERT INTO visits (patient_name, patient_id, doctor_id, status)
       VALUES ($1, $2, $3, 'seated') RETURNING id`,
      [TEST_PATIENTS.patientA.fullName, patientA.id, partyA.id],
    );

    return {
      patientAId: patientA.id as number,
      patientBId: patientB.id as number,
      visitId: visit.id as number,
      staffTokens,
    };
  } finally {
    await client.end();
  }
}

async function waitForHttp(url: string, timeoutMs: number, logs: string[]): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(`${url}/api/ping`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return;
    } catch { /* لم يبدأ بعد */ }
    if (Date.now() > deadline) {
      throw new Error(`الخادم لم يستجب خلال ${timeoutMs}ms على ${url}/api/ping\nسجلات:\n${logs.join("").slice(-4000)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/**
 * رابط القاعدة كما يراه خادم الاختبار: كلمة المرور تُرمّز ترميز URL كاملًا —
 * فبعض كواشف بيئة CI في التطبيق تبحث عن الأنماط الحرفية (مثل ci:ci@) لتمييز
 * روابط placeholder، وقاعدتنا حقيقية معزولة لا placeholder.
 */
function dbUrlForServer(dbUrl: string): string {
  try {
    const url = new URL(dbUrl);
    if (url.password) {
      url.password = Array.from(url.password)
        .map((ch) => `%${ch.charCodeAt(0).toString(16).padStart(2, "0")}`)
        .join("");
    }
    return url.toString();
  } catch {
    return dbUrl;
  }
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  // (P2-FIX-1) توكيع التوكنات الصريحة في هذا العملية يحتاج السر في process.env —
  // sessionCredentialVersion/sign تقرؤه وقت النداء.
  process.env.SESSION_SECRET = SESSION_SECRET;

  const serverEntry = join(process.cwd(), ".next", "standalone", "server.js");
  if (!existsSync(serverEntry)) {
    throw new Error(
      "لا يوجد بناء: .next/standalone/server.js مفقود. شغّل `npm run build` قبل "
      + "`npm run test:security-http` — اختبارات الأمن HTTP تعمل على التطبيق المبني.",
    );
  }

  const standalone = join(process.cwd(), ".next", "standalone");
  cpSync(join(process.cwd(), "public"), join(standalone, "public"), { recursive: true });
  cpSync(join(process.cwd(), ".next", "static"), join(standalone, ".next", "static"), { recursive: true });

  const dbUrl = await recreateIsolatedDatabase();
  await runSchemaInit(dbUrl);
  const seeded = await seed(dbUrl);
  writeFileSync(STATE_FILE, JSON.stringify({
    dbUrl,
    patientAId: seeded.patientAId,
    patientBId: seeded.patientBId,
    visitId: seeded.visitId,
    staffTokens: seeded.staffTokens,
    port: PORT,
    baseUrl: BASE,
  }), "utf8");

  // جذر التخزين خارج tmpdir عمدًا: فاحص الدوام (P1) يرفض مناطق tmp في
  // الإنتاج — والاختبار يطابق سلوك الإنتاج لا يتجاوزه.
  const storageDir = join(process.cwd(), ".sec-http-storage");
  rmSync(storageDir, { recursive: true, force: true });
  const server = spawn(process.execPath, [serverEntry], {
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(PORT),
      HOSTNAME: "127.0.0.1",
      // الخادم يتصل بالمعزولة — لا باختبار PG ولا بإنتاج أبدًا
      DATABASE_URL: dbUrlForServer(dbUrl),
      TEST_DATABASE_URL: dbUrlForServer(dbUrl),
      SESSION_SECRET,
      DOCUMENTS_DIR: join(storageDir, "documents"),
      DURABLE_STORAGE_ROOT: storageDir,
      CLINIC_TIME_ZONE: "Asia/Aden",
      // هذا الخادم متصل بقاعدة حقيقية معزولة — كاشف «CI placeholder» في
      // مسارات AI (CI=true مع 127.0.0.1 أو ci:ci@) كان يجعله يعتبرها
      // offline فيتخطى فحوص الملكية؛ القاعدة هنا فعلية فنعلمها بذلك.
      CI: "false",
      // بلا TRUSTED_HOSTS: مطابقة الأصل تسقط على مطابقة Host نفسه — المختبر
      // (P2-FIX-4) الخادم إنتاجيّ (NODE_ENV=production) — سياسة الأصل الدقيق
      // fail-closed في الإنتاج بلا قائمة: فنضبط الأصل الكانوني الصريح،
      // فتُختبر المقارنة الدقيقة scheme://host:port على HTTP حقيقي.
      APP_ORIGIN: BASE,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs: string[] = [];
  server.stdout?.on("data", (chunk) => logs.push(String(chunk)));
  server.stderr?.on("data", (chunk) => logs.push(String(chunk)));

  try {
    await waitForHttp(BASE, 90_000, logs);
  } catch (error) {
    server.kill("SIGKILL");
    rmSync(storageDir, { recursive: true, force: true });
    throw error;
  }

  console.log(`[security-http] الخادم جاهز على ${BASE} — قاعدة ${DB_NAME} معزولة`);

  return async () => {
    server.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        server.kill("SIGKILL");
        resolve();
      }, 5000);
      server.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    rmSync(storageDir, { recursive: true, force: true });
    try { rmSync(STATE_FILE, { force: true }); } catch { /* أفضل جهد */ }
    try {
      const url = new URL(testDatabaseUrl());
      const admin = new Client({ connectionString: url.toString(), ssl: false });
      await admin.connect();
      try {
        await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
      } finally {
        await admin.end();
      }
    } catch { /* القاعدة معزولة أصلًا */ }
    console.log("[security-http] أُوقف الخادم وأُسقطت القاعدة المعزولة");
  };
}
