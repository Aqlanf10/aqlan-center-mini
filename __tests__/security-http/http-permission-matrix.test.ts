import { beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { hashPassword } from "../../lib/auth";
import { ADMIN_PERMISSIONS } from "../../lib/doctor-permissions";
import {
  HTTP_PERMISSIONS,
  API_METHOD_NOT_ALLOWED_MESSAGE,
  API_ROUTE_UNKNOWN_MESSAGE,
  isAccessClass,
  rolesAlwaysDenied,
  type HttpAccess,
  type HttpMethod,
} from "../../lib/http-permissions";
import { ROLES, type Role } from "../../lib/roles";
import { baseUrl, harness, loginStaff } from "./_server";

/**
 * (TD-04 / TD-REG-006) مصفوفة الصلاحيات على التطبيق المبني — لكل مسار وفعل ودور.
 *
 * الدور الغائب عن مدخل المصفوفة يجب أن يُرفض (401/403) برسالة عربية — بأقصى
 * صلاحياته الفردية: طبيبٌ بكل صلاحيات المدير، وكاشير ومحاسب بكل مفاتيح المالية.
 * فإن رُفض هؤلاء رُفض كل من دونهم. والمجهول مرفوضٌ على كل مسار غير عام، وجلسة
 * البوابة لا تفتح مسار طاقم. الطلبات المرفوضة لا تبلغ منطق المسار، فلا أثر لها.
 */

const ARABIC = /[؀-ۿ]/;

let sessions: Record<Role, string> = {} as Record<Role, string>;
let portalCookie = "";

beforeAll(async () => {
  const h = await harness();
  const pool = new pg.Pool({ connectionString: h.seeded.dbUrl });
  const password = "Td04Matrix#Pass1";
  const hash = await hashPassword(password);
  try {
    const { rows: [party] } = await pool.query(
      `INSERT INTO parties (name, kind) VALUES ('طبيب مصفوفة الصلاحيات', 'doctor') RETURNING id`,
    );
    const allFinance = {
      operateShift: true, collectPayments: true, createExpenses: true, viewPatientLedger: true,
      viewReports: true, viewSuppliers: true, viewCommissions: true, viewReconciliation: true,
    };
    const users: [string, Role, number | null, unknown][] = [
      ["td04maxdoctor", "doctor", party.id as number, { ...ADMIN_PERMISSIONS }],
      ["td04assistant", "assistant", null, null],
      ["td04maxcashier", "cashier", null, { financeAccess: allFinance, canUseAiChat: true }],
      ["td04maxaccountant", "accountant", null, { financeAccess: allFinance, canUseAiChat: true }],
    ];
    for (const [username, role, partyId, permissions] of users) {
      await pool.query(
        `INSERT INTO users (username, display_name, password_hash, role, party_id, permissions)
         VALUES ($1, $1, $2, $3, $4, $5)`,
        [username, hash, role, partyId, permissions === null ? null : JSON.stringify(permissions)],
      );
    }
  } finally {
    await pool.end();
  }
  sessions = {
    admin: h.sessions.admin.cookie,
    reception: h.sessions.reception.cookie,
    doctor: (await loginStaff("td04maxdoctor", password)).cookie,
    assistant: (await loginStaff("td04assistant", password)).cookie,
    cashier: (await loginStaff("td04maxcashier", password)).cookie,
    accountant: (await loginStaff("td04maxaccountant", password)).cookie,
  };
  portalCookie = h.sessions.portalA.cookie;
}, 240_000);

/** عنوانٌ فعلي من النمط: معرّفٌ لا وجود له — الرفض بالدور يسبق قراءة السجل. */
function concretePath(pattern: string): string {
  return pattern.replace(/\[backupId\]/g, "no-such-backup").replace(/\[[^\]]+\]/g, "987654321");
}

async function send(pattern: string, method: HttpMethod, cookie: string): Promise<{ status: number; message: unknown }> {
  const headers: Record<string, string> = { Origin: baseUrl };
  if (cookie) headers.Cookie = cookie;
  let body: string | undefined;
  if (method !== "GET") {
    headers["Content-Type"] = "application/json";
    body = "{}";
  }
  const response = await fetch(`${baseUrl}${concretePath(pattern)}`, { method, headers, body, redirect: "manual" });
  const text = await response.text();
  let message: unknown = null;
  try { message = (JSON.parse(text) as { message?: unknown }).message ?? null; } catch { message = null; }
  return { status: response.status, message };
}

function entries(): [string, HttpMethod, HttpAccess][] {
  const list: [string, HttpMethod, HttpAccess][] = [];
  for (const [pattern, entry] of Object.entries(HTTP_PERMISSIONS)) {
    for (const [method, access] of Object.entries(entry) as [HttpMethod, HttpAccess][]) list.push([pattern, method, access]);
  }
  return list;
}

describe("TD-04: كل دور غائب عن المصفوفة مرفوضٌ فعلًا", () => {
  it("الأدوار المرفوضة دائمًا ⇒ 401/403 برسالة عربية — على كل مسار وفعل", async () => {
    const leaks: string[] = [];
    let checked = 0;
    for (const [pattern, method, access] of entries()) {
      for (const role of rolesAlwaysDenied(access, ROLES)) {
        const { status, message } = await send(pattern, method, sessions[role]);
        checked += 1;
        if (status !== 401 && status !== 403) leaks.push(`${role} ${method} ${pattern} → ${status}`);
        else if (typeof message !== "string" || !ARABIC.test(message)) leaks.push(`${role} ${method} ${pattern} → ${status} بلا رسالة عربية`);
      }
    }
    expect(leaks).toEqual([]);
    expect(checked).toBeGreaterThan(500);
  }, 600_000);
});

describe("TD-04: المجهول وجلسة البوابة لا يفتحان مسار طاقم", () => {
  it("بلا جلسة ⇒ 401/403 على كل مسار غير عام (الطاقم والبوابة والوسائط والخطافات والداخلي)", async () => {
    const leaks: string[] = [];
    for (const [pattern, method, access] of entries()) {
      if (access === "public") continue;
      const { status } = await send(pattern, method, "");
      if (status !== 401 && status !== 403) leaks.push(`anonymous ${method} ${pattern} → ${status}`);
    }
    expect(leaks).toEqual([]);
  }, 600_000);

  it("جلسة البوابة على مسار طاقم ⇒ 401/403", async () => {
    const leaks: string[] = [];
    for (const [pattern, method, access] of entries()) {
      if (isAccessClass(access)) continue;
      const { status } = await send(pattern, method, portalCookie);
      if (status !== 401 && status !== 403) leaks.push(`portal ${method} ${pattern} → ${status}`);
    }
    expect(leaks).toEqual([]);
  }, 600_000);
});

describe("TD-04: الباب مغلقٌ على ما لم يُسجَّل", () => {
  it("مسار API غير مسجَّل ⇒ 404 برسالة عربية — قبل أي معالج", async () => {
    const response = await fetch(`${baseUrl}/api/no-such-route`, { headers: { Cookie: sessions.admin }, redirect: "manual" });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ message: API_ROUTE_UNKNOWN_MESSAGE });
  });

  it("فعلٌ غير مسجَّل على مسار مسجَّل ⇒ 405 مع Allow", async () => {
    const response = await fetch(`${baseUrl}/api/audit`, {
      method: "DELETE",
      headers: { Cookie: sessions.admin, Origin: baseUrl },
      redirect: "manual",
    });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD, OPTIONS");
    expect(await response.json()).toEqual({ message: API_METHOD_NOT_ALLOWED_MESSAGE });
  });

  it("المرور العام لا يتجاوز التسجيل: مسار غير مسجَّل تحت بادئة عامة ⇒ 404 بلا جلسة، وفعل غير مسجَّل على مسار عام ⇒ 405", async () => {
    for (const path of ["/api/webhooks/no-such-hook", "/api/messages/voice/1/extra"]) {
      const response = await fetch(`${baseUrl}${path}`, { method: "POST", headers: { Origin: baseUrl }, redirect: "manual" });
      expect({ path, status: response.status }).toEqual({ path, status: 404 });
      expect(await response.json()).toEqual({ message: API_ROUTE_UNKNOWN_MESSAGE });
    }
    const wrongVerb = await fetch(`${baseUrl}/api/health`, { method: "DELETE", headers: { Origin: baseUrl }, redirect: "manual" });
    expect(wrongVerb.status).toBe(405);
    expect(wrongVerb.headers.get("allow")).toBe("GET, HEAD, OPTIONS");
  });

  it("المسار المسجَّل يبقى يعمل لمن يحق له (لا كسر للسلوك المشروع)", async () => {
    const response = await fetch(`${baseUrl}/api/audit`, { headers: { Cookie: sessions.admin }, redirect: "manual" });
    expect(response.status).toBe(200);
  });
});
