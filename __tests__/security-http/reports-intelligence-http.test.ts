import { beforeAll, describe, expect, it } from "vitest";
import { baseUrl, harness } from "./_server";

/**
 * (Reports R4) صلاحيات ذكاء العيادة على التطبيق المبني — طلبات مباشرة لا الواجهة.
 *
 * الاستقبال يرى التشغيلي بلا دخل المركز (أداء المواعيد، الكراسي، المتابعة، العلاج غير
 * المجدول)، ولا يرى الملخّص المالي ولا استغلال الأطباء (إنتاج وتحصيل) ولا ذكاء المختبر
 * (تكاليف) ولا الخطط (قيم) ولا الاتجاهات. والطبيب لا مركز تقارير له.
 */

let h: Awaited<ReturnType<typeof harness>>;
const get = (path: string, cookie: string) => fetch(`${baseUrl}${path}`, { headers: { cookie }, redirect: "manual" });
const period = "preset=this_month";

beforeAll(async () => {
  h = await harness();
}, 120_000);

const RECEPTION_ALLOWED = ["appointment-performance", "chair-utilization", "recall-intelligence", "unscheduled-treatment"];
const ADMIN_ONLY = ["practice-overview", "provider-utilization", "plan-intelligence", "lab-intelligence", "new-patient-intelligence", "practice-trends"];

describe("Practice Intelligence — server-side access", () => {
  it("admin builds every intelligence report", async () => {
    for (const report of [...RECEPTION_ALLOWED, ...ADMIN_ONLY]) {
      const response = await get(`/api/reports?report=${report}&${period}`, h.sessions.admin.cookie);
      expect(response.status, report).toBe(200);
      const body = await response.json() as { result: { report: string; title: string } };
      expect(body.result.report).toBe(report);
      expect(body.result.title.length).toBeGreaterThan(0);
    }
  });

  it("reception gets the operational ones and 403 on the financial ones", async () => {
    for (const report of RECEPTION_ALLOWED) {
      expect((await get(`/api/reports?report=${report}&${period}`, h.sessions.reception.cookie)).status, report).toBe(200);
    }
    for (const report of ADMIN_ONLY) {
      const response = await get(`/api/reports?report=${report}&${period}`, h.sessions.reception.cookie);
      expect(response.status, report).toBe(403);
      expect(typeof ((await response.json()) as { message?: string }).message).toBe("string");
    }
  });

  it("a doctor is refused every intelligence report", async () => {
    for (const report of [...RECEPTION_ALLOWED, ...ADMIN_ONLY]) {
      expect((await get(`/api/reports?report=${report}&${period}`, h.sessions.doctorA.cookie)).status, report).toBe(403);
    }
  });

  it("the official document enforces the same policy", async () => {
    expect((await get(`/print/report?report=practice-overview&${period}`, h.sessions.reception.cookie)).status).toBe(404);
    const allowed = await get(`/print/report?report=appointment-performance&${period}`, h.sessions.reception.cookie);
    expect(allowed.status).toBe(200);
    expect(await allowed.text()).toContain("أداء المواعيد");
  });
});
