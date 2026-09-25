import { beforeAll, describe, expect, it } from "vitest";
import { authedMutation, baseUrl, harness } from "./_server";

/**
 * (Reports R3) Power Reporting على التطبيق المبني — محاولات تجاوز مباشرة للخادم.
 *
 * العرض المحفوظ أو القالب المشترك رابطُ فلاتر لا صلاحية: الاستقبال لا يحفظ تقريرًا
 * ماليًّا، ولا يرى قالبًا مشتركًا لتقرير لا يملكه، ولا يعدّل/يحذف ما ليس له، ولا
 * يفتح الرابط المحفوظ نفسه عبر API التقارير أو المستند الرسمي.
 */

let h: Awaited<ReturnType<typeof harness>>;
let sharedDebtId = 0;
let sharedVisitsId = 0;

const get = (path: string, cookie: string) =>
  fetch(`${baseUrl}${path}`, { headers: { cookie }, redirect: "manual" });

async function json(response: Response): Promise<Record<string, unknown>> {
  return response.json() as Promise<Record<string, unknown>>;
}

beforeAll(async () => {
  h = await harness();
  const stamp = Date.now();
  const debt = await authedMutation("/api/reports/saved", h.sessions.admin, "POST", JSON.stringify({
    name: `مديونية مشتركة ${stamp}`, reportId: "debt", sectionId: "receivables",
    queryString: "report=debt&preset=this_month&debtMode=outstanding", isShared: true,
  }));
  expect(debt.status).toBe(201);
  sharedDebtId = Number(((await json(debt)).saved as { id: number }).id);
  const visits = await authedMutation("/api/reports/saved", h.sessions.admin, "POST", JSON.stringify({
    name: `زيارات مشتركة ${stamp}`, reportId: "visits", sectionId: "operational",
    queryString: "report=visits&preset=today&group=doctorName", isShared: true,
  }));
  expect(visits.status).toBe(201);
  sharedVisitsId = Number(((await json(visits)).saved as { id: number }).id);
}, 120_000);

describe("Saved reports — server-side permissions", () => {
  it("reception cannot save an admin-only report", async () => {
    const response = await authedMutation("/api/reports/saved", h.sessions.reception, "POST", JSON.stringify({
      name: "محاولة", reportId: "debt", sectionId: "receivables", queryString: "report=debt&preset=today",
    }));
    expect(response.status).toBe(403);
    expect(typeof (await json(response)).message).toBe("string");
  });

  it("reception cannot publish a shared template", async () => {
    const response = await authedMutation("/api/reports/saved", h.sessions.reception, "POST", JSON.stringify({
      name: "قالب استقبال", reportId: "visits", sectionId: "operational",
      queryString: "report=visits&preset=today", isShared: true,
    }));
    expect(response.status).toBe(403);
  });

  it("a shared template is listed only for roles allowed to open its report", async () => {
    const response = await get("/api/reports/saved", h.sessions.reception.cookie);
    expect(response.status).toBe(200);
    const body = await json(response);
    const ids = (body.saved as { id: number }[]).map((item) => item.id);
    expect(ids).toContain(sharedVisitsId);
    expect(ids).not.toContain(sharedDebtId);
    expect(body.canShare).toBe(false);
    const templateReports = (body.templates as { reportId: string }[]).map((item) => item.reportId);
    expect(templateReports.every((id) => ["visits", "appointments", "recall", "inventory", "patient-statement"].includes(id))).toBe(true);
  });

  it("reception cannot duplicate, rename or delete the admin's templates", async () => {
    const duplicate = await authedMutation("/api/reports/saved", h.sessions.reception, "POST", JSON.stringify({ duplicateOf: sharedDebtId }));
    expect(duplicate.status).toBe(404);
    const rename = await authedMutation("/api/reports/saved", h.sessions.reception, "PATCH", JSON.stringify({ id: sharedVisitsId, name: "اختطاف" }));
    expect(rename.status).toBe(404);
    const unshare = await authedMutation("/api/reports/saved", h.sessions.reception, "PATCH", JSON.stringify({ id: sharedVisitsId, isShared: false }));
    expect(unshare.status).toBe(403);
    const remove = await authedMutation(`/api/reports/saved?id=${sharedVisitsId}`, h.sessions.reception, "DELETE");
    expect(remove.status).toBe(404);
  });

  it("reception can duplicate a visible shared template into a private copy", async () => {
    const response = await authedMutation("/api/reports/saved", h.sessions.reception, "POST", JSON.stringify({ duplicateOf: sharedVisitsId }));
    expect(response.status).toBe(201);
    const saved = (await json(response)).saved as { id: number; owned: boolean; isShared: boolean; name: string; queryString: string };
    expect(saved.owned).toBe(true);
    expect(saved.isShared).toBe(false);
    expect(saved.name.startsWith("نسخة من ")).toBe(true);
    expect(saved.queryString).toContain("group=doctorName");
    const cleanup = await authedMutation(`/api/reports/saved?id=${saved.id}`, h.sessions.reception, "DELETE");
    expect(cleanup.status).toBe(200);
  });

  it("reception cannot overwrite its own saved view with an admin-only report", async () => {
    const created = await authedMutation("/api/reports/saved", h.sessions.reception, "POST", JSON.stringify({
      name: `مواعيدي ${Date.now()}`, reportId: "appointments", sectionId: "operational", queryString: "report=appointments&preset=today",
    }));
    const id = Number(((await json(created)).saved as { id: number }).id);
    const swap = await authedMutation("/api/reports/saved", h.sessions.reception, "PATCH", JSON.stringify({
      id, reportId: "collections", sectionId: "financial", queryString: "report=collections&preset=today",
    }));
    expect(swap.status).toBe(403);
    await authedMutation(`/api/reports/saved?id=${id}`, h.sessions.reception, "DELETE");
  });

  it("a doctor has no Reports Center: nothing listed, nothing savable", async () => {
    const list = await json(await get("/api/reports/saved", h.sessions.doctorA.cookie));
    expect(list.saved).toEqual([]);
    expect(list.templates).toEqual([]);
    const save = await authedMutation("/api/reports/saved", h.sessions.doctorA, "POST", JSON.stringify({
      name: "طبيب", reportId: "visits", sectionId: "operational", queryString: "report=visits&preset=today",
    }));
    expect(save.status).toBe(403);
  });

  it("opening the saved link directly is still gated by the report API and the official print route", async () => {
    const api = await get("/api/reports?report=debt&preset=this_month&debtMode=outstanding", h.sessions.reception.cookie);
    expect(api.status).toBe(403);
    const print = await get("/print/report?report=debt&preset=this_month&debtMode=outstanding", h.sessions.reception.cookie);
    expect(print.status).toBe(404);
    const unknown = await get("/api/reports?report=made-up", h.sessions.admin.cookie);
    expect(unknown.status).toBe(400);
    expect((await json(unknown)).message).toBe("نوع تقرير غير معروف.");
  });

  it("the official print honours the saved view (columns order and grouping)", async () => {
    const response = await get(
      "/print/report?report=visits&preset=today&columns=doctorName,patientName&group=doctorName",
      h.sessions.admin.cookie,
    );
    expect(response.status).toBe(200);
    const html = await response.text();
    const headerRow = html.slice(html.indexOf("<thead>"), html.indexOf("</thead>"));
    expect(headerRow.indexOf("الطبيب")).toBeGreaterThan(-1);
    expect(headerRow.indexOf("الطبيب")).toBeLessThan(headerRow.indexOf("المريض"));
    expect(headerRow).not.toContain("الهاتف");
  });
});
