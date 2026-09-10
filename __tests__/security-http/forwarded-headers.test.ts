import { request as httpRequest } from "node:http";
import { describe, expect, it } from "vitest";
import { baseUrl, TEST_USERS } from "./_server";

/**
 * (P2-FINAL-1) انحدار ترويسات الوسيط المزيّفة — على HTTP حقيقي عبر التطبيق
 * المبني بخادم إنتاجي (NODE_ENV=production) وبلا TRUST_PROXY:
 *
 *  1. `x-forwarded-proto:http` مزيّفة ⇒ كوكي جلسة الطاقم `aqlan_flow_session`
 *     ما زالت تحمل `Secure` — الترويسة لا تُقرأ أصلًا في قرار Secure، والقرار
 *     بيئي (NODE_ENV) لا من محتوى الطلب.
 *  2. `Host: localhost` مزيّف (عبر طلب HTTP خام — fetch يمنع ترويسة Host)
 *     مع `x-forwarded-proto:http` ⇒ لا استثناء محلي في الإنتاج: Secure تبقى.
 *  3. `x-forwarded-host` و`x-forwarded-proto` مزيّفتان ⇒ لا redirect إلى
 *     الأصل المُعاد توجيهه ولا خفضٌ نحوه — الرابط من الأصل الكانوني
 *     (APP_ORIGIN للخادم) لا من ترويسات العميل.
 *  4. حالة الوسيط الموثوق المشروعة (TRUST_PROXY=true) مُثبتة في اختبارات
 *     الوحدة المباشرة للمسار (`__tests__/redirect-hardening.test.ts`) —
 *     بيئة خادم security-http ثابتة الإعداد ولا يمكن تبديل TRUST_PROXY
 *     لكل حالة، أما منطق المسار فيُختبر مباشرة بحالتها هناك.
 */

const CANONICAL = baseUrl; // APP_ORIGIN للخادم الإنتاجي الاختباري (انظر _global-setup)

interface RawResponse {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: string;
}

/** طلب HTTP خام بمضيف/ترويسات مزيّفة — fetch يفرض Host من الـURL فلا يصلح هنا. */
function rawRequest(options: {
  method: string;
  path: string;
  host?: string;
  extraHeaders?: Record<string, string>;
  body?: string;
}): Promise<RawResponse> {
  const port = Number(new URL(baseUrl).port);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method: options.method,
        path: options.path,
        headers: {
          ...(options.host ? { Host: options.host } : {}),
          ...options.extraHeaders,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => {
          resolve({
            statusCode: response.statusCode ?? 0,
            headers: response.headers as Record<string, string | string[]>,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    request.on("error", reject);
    if (options.body) request.write(options.body);
    request.end();
  });
}

function setCookieList(headers: Record<string, string | string[]>): string[] {
  const raw = headers["set-cookie"];
  if (!raw) return [];
  return Array.isArray(raw) ? raw : [raw];
}

describe("(P2-FINAL-1) ترويسات وسيط مزيّفة على خادم إنتاجي بلا TRUST_PROXY", () => {
  it("x-forwarded-proto:http مزيّفة ⇒ كوكي دخول الطاقم ما زالت تحمل Secure", async () => {
    const response = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: baseUrl,
        "x-forwarded-proto": "http",
      },
      body: JSON.stringify({
        username: TEST_USERS.admin.username,
        password: TEST_USERS.admin.password,
      }),
    });
    expect(response.status).toBe(200);
    const sessionCookie = response.headers
      .getSetCookie()
      .find((entry) => entry.startsWith("aqlan_flow_session="));
    expect(sessionCookie).toBeTruthy();
    expect(sessionCookie).toMatch(/;\s*secure/i);
    expect(sessionCookie).toMatch(/httponly/i);
  });

  it("Host محلي مزيّف (localhost) + x-forwarded-proto:http ⇒ Secure ما زالت true (لا استثناء محلي في الإنتاج)", async () => {
    const response = await rawRequest({
      method: "POST",
      path: "/api/auth/login",
      host: "localhost",
      extraHeaders: {
        "Content-Type": "application/json",
        "x-forwarded-proto": "http",
      },
      body: JSON.stringify({
        username: TEST_USERS.doctorB.username,
        password: TEST_USERS.doctorB.password,
      }),
    });
    expect(response.statusCode).toBe(200);
    const sessionCookie = setCookieList(response.headers).find((entry) =>
      entry.startsWith("aqlan_flow_session="),
    );
    expect(sessionCookie).toBeTruthy();
    expect(sessionCookie).toMatch(/;\s*secure/i);
  });

  it("x-forwarded-host + x-forwarded-proto:http مزيّفتان ⇒ لا redirect إلى الأصل المزيّف ولا خفض نحوه، والكوكي Secure", async () => {
    /* نموذج HTML كما يرسله متصفحٌ ضُلّل أو أداةٌ خارجية: ترويسات forwarded
       يكتبها العميل بالكامل. الرد يجب أن يعود للأصل الكانوني دائمًا. */
    const response = await rawRequest({
      method: "POST",
      path: "/api/auth/login",
      host: "spoofed-connection.test",
      extraHeaders: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "text/html",
        "x-forwarded-host": "evil-forward.test",
        "x-forwarded-proto": "http",
      },
      body: new URLSearchParams({
        username: TEST_USERS.reception.username,
        password: TEST_USERS.reception.password,
      }).toString(),
    });
    expect(response.statusCode).toBe(303);
    const location = String(response.headers.location ?? "");
    expect(location).not.toContain("evil-forward.test");
    expect(location).not.toContain("spoofed-connection.test");
    expect(location.startsWith(`${CANONICAL}/`)).toBe(true);
    // وكوكي الدخول في الرد نفسه ما زالت Secure رغم الترويسات المزيّفة:
    const sessionCookie = setCookieList(response.headers).find((entry) =>
      entry.startsWith("aqlan_flow_session="),
    );
    expect(sessionCookie).toBeTruthy();
    expect(sessionCookie).toMatch(/;\s*secure/i);
  });

  it("أوراق اعتماد فاسدة مع ترويسات مزيّفة ⇒ redirect الخطأ على الأصل الكانوني لا المزيّف", async () => {
    const response = await rawRequest({
      method: "POST",
      path: "/api/auth/login",
      extraHeaders: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "text/html",
        "x-forwarded-host": "evil-forward.test",
        "x-forwarded-proto": "http",
      },
      body: new URLSearchParams({
        username: "secfwd-nobody",
        password: "wrong-password",
      }).toString(),
    });
    expect(response.statusCode).toBe(303);
    const location = String(response.headers.location ?? "");
    expect(location.startsWith(`${CANONICAL}/login`)).toBe(true);
    expect(location).not.toContain("evil-forward.test");
  });
});
