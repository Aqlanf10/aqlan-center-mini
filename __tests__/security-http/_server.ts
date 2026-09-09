import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * أدوات اختبارات الأمن HTTP (P2/S14) — جهة fork الاختبارات.
 *
 * الخادم نفسه يُدار من الإعداد العالمي (_global-setup.ts): يبدأ مرة واحدة
 * ويبقى حيًّا طوال الجولة — فالتوكنات تبقى صالحة بين ملفات الاختبار كلها.
 * هذا الملف: قراءة حالة البذر (معرفات المرضى)، تسجيل الدخول مرة واحدة لكل
 * دور (مفرد عبر الملفات بفضل isolate:false)، وسمات الطلب الجاهزة.
 */

const PORT = Number(process.env.SECURITY_HTTP_PORT ?? 3217);
export const baseUrl = `http://127.0.0.1:${PORT}`;

const STATE_FILE = join(process.cwd(), ".sec-http-state.json");

interface SeededState {
  dbUrl: string;
  patientAId: number;
  patientBId: number;
  visitId: number;
  /** (P2-FIX-1) توكنات Bearer الصريحة للتطبيقات الخارجية — موقعة في الإعداد
   *  العالمي بcreateSessionToken نفسها، لا من جسم دخول المتصفح (صار كوكي-فقط). */
  staffTokens: Record<string, string>;
  port: number;
  baseUrl: string;
}

function seededState(): SeededState {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8")) as SeededState;
  } catch {
    throw new Error(
      "ملف حالة الإعداد العالمي مفقود — يجب أن تشغّل vitest عبر "
      + "npm run test:security-http (الإعداد العالمي يكتبه قبل الاختبارات).",
    );
  }
}

export const TEST_USERS = {
  admin: { username: "secadmin", password: "SecAdmin#Pass1" },
  doctorA: { username: "secdoctora", password: "SecDocA#Pass1" },
  doctorB: { username: "secdoctorb", password: "SecDocB#Pass1" },
  reception: { username: "secreception", password: "SecRec#Pass11" },
  accountant: { username: "secaccountant", password: "SecAcc#Pass1" },
} as const;

export const TEST_PATIENTS = {
  patientA: { patientNumber: "SECA-001", phone: "777100001", fullName: "مريض الأمن أ" },
  patientB: { patientNumber: "SECB-002", phone: "777100002", fullName: "مريض الأمن ب" },
} as const;

export interface Session {
  cookie: string;
  token: string;
}

export interface RoleSessions {
  admin: Session;
  doctorA: Session;
  doctorB: Session;
  reception: Session;
  accountant: Session;
  portalA: Session;
  portalB: Session;
}

export interface Harness {
  sessions: RoleSessions;
  seeded: { patientAId: number; patientBId: number; visitId: number };
}

let roleSessions: RoleSessions | null = null;
let seededCache: SeededState | null = null;

/** دخول الطاقم عبر HTTP الحقيقي — يعيد كوكي الجلسة (P2-FIX-1: بلا توكن في الجسم). */
export async function loginStaff(username: string, password: string): Promise<Omit<Session, "token">> {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: baseUrl },
    body: JSON.stringify({ username, password }),
  });
  if (response.status !== 200) {
    throw new Error(`فشل دخول ${username}: HTTP ${response.status} — ${await response.text()}`);
  }
  const setCookies = response.headers.getSetCookie?.() ?? [];
  const sessionCookie = setCookies
    .map((entry) => entry.split(";")[0])
    .find((pair) => pair.startsWith("aqlan_flow_session="));
  const payload = (await response.json()) as { token?: string; username?: string; displayName?: string; role?: string; permissions?: unknown };
  if (!sessionCookie) throw new Error("لم تصل كوكي جلسة من تسجيل الدخول.");
  /* (P2-FIX-1) إثبات المانع: جسم دخول المتصفح لا يحمل توكناً إطلاقاً. */
  if ("token" in payload) {
    throw new Error("(P2-FIX-1) جسم تسجيل الدخول أعاد توكناً — يجب أن يكون كوكي-فقط.");
  }
  return { cookie: sessionCookie };
}

/** دخول بوابة المريض عبر HTTP الحقيقي. */
export async function loginPortal(phone: string, patientNumber: string): Promise<Session> {
  const response = await fetch(`${baseUrl}/api/portal/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: baseUrl },
    body: JSON.stringify({ phone, patientNumber }),
  });
  if (response.status !== 200) {
    throw new Error(`فشل دخول البوابة ${patientNumber}: HTTP ${response.status} — ${await response.text()}`);
  }
  const setCookies = response.headers.getSetCookie?.() ?? [];
  const portalCookie = setCookies
    .map((entry) => entry.split(";")[0])
    .find((pair) => pair.startsWith("aqlan_portal_session="));
  if (!portalCookie) throw new Error("لم تصل كوكي بوابة من تسجيل الدخول.");
  return { cookie: portalCookie, token: "" };
}

/**
 * المستعبِر — يتحقق أن الخادم العالمي حي، ويسجل الدخول لكل الأدوار مرة
 * واحدة فقط (المفرد يبقى عبر الملفات كلها بفضل isolate: false).
 */
export async function harness(): Promise<Harness> {
  if (!seededCache) seededCache = seededState();
  if (!roleSessions) {
    // تحقق حيوية الخادم أولًا — رسالة فشل واضحة إن غاب
    const ping = await fetch(`${baseUrl}/api/ping`, { signal: AbortSignal.timeout(5000) });
    if (!ping.ok) throw new Error(`الخادم العالمي لا يستجيب (${ping.status}).`);

    roleSessions = {
      admin: {
        cookie: (await loginStaff(TEST_USERS.admin.username, TEST_USERS.admin.password)).cookie,
        token: staffTokenOf(TEST_USERS.admin.username),
      },
      doctorA: {
        cookie: (await loginStaff(TEST_USERS.doctorA.username, TEST_USERS.doctorA.password)).cookie,
        token: staffTokenOf(TEST_USERS.doctorA.username),
      },
      doctorB: {
        cookie: (await loginStaff(TEST_USERS.doctorB.username, TEST_USERS.doctorB.password)).cookie,
        token: staffTokenOf(TEST_USERS.doctorB.username),
      },
      reception: {
        cookie: (await loginStaff(TEST_USERS.reception.username, TEST_USERS.reception.password)).cookie,
        token: staffTokenOf(TEST_USERS.reception.username),
      },
      accountant: {
        cookie: (await loginStaff(TEST_USERS.accountant.username, TEST_USERS.accountant.password)).cookie,
        token: staffTokenOf(TEST_USERS.accountant.username),
      },
      portalA: await loginPortal(TEST_PATIENTS.patientA.phone, TEST_PATIENTS.patientA.patientNumber),
      portalB: await loginPortal(TEST_PATIENTS.patientB.phone, TEST_PATIENTS.patientB.patientNumber),
    };
  }
  return {
    sessions: roleSessions,
    seeded: {
      patientAId: seededCache.patientAId,
      patientBId: seededCache.patientBId,
      visitId: seededCache.visitId,
    },
  };
}

/** توكن Bearer الصريح لتطبيقٍ خارجي (موقّع في الإعداد العالمي لا من دخول المتصفح). */
function staffTokenOf(username: string): string {
  const state = seededCache;
  if (!state) throw new Error("حالة الإعداد غير مقروءة بعد.");
  const token = state.staffTokens?.[username];
  if (!token) throw new Error(`توكن Bearer الصريح لـ ${username} مفقود من حالة الإعداد.`);
  return token;
}

/** طلب GET بكوكي جلسة. */
export function authedGet(path: string, session: Session, extra: Record<string, string> = {}): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    headers: { Cookie: session.cookie, ...extra },
    redirect: "manual",
  });
}

/** طلب تغيير حالة بكوكي جلسة + أصل نفس الموقع (كما يرسله متصفح التطبيق). */
export function authedMutation(
  path: string,
  session: Session,
  method: "POST" | "PUT" | "PATCH" | "DELETE" = "POST",
  body?: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Cookie: session.cookie,
      Origin: baseUrl,
      "Sec-Fetch-Site": "same-origin",
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body,
    redirect: "manual",
  });
}
