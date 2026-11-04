import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { Client } from "pg";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authedMutation, baseUrl, harness, TEST_USERS } from "./_server";

let db: Client, browser: Browser, h: Awaited<ReturnType<typeof harness>>;
beforeAll(async () => {
  h = await harness();
  expect(new URL(h.seeded.dbUrl).hostname).toBe("127.0.0.1");
  expect(new URL(h.seeded.dbUrl).pathname).toBe("/aqlan_sec_http");
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false }); await db.connect();
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
  await mkdir(".settings-ui-artifacts", { recursive: true });
});
afterAll(async () => { await browser?.close(); await db?.end(); });

describe("ceph diagnosis remains clinician-authored", () => {
  it.each([390, 1280])("preserves draft, saved and historical diagnosis through denied generation at %ipx", async width => {
    const doctor = (await db.query("SELECT party_id,permissions FROM users WHERE username=$1", [TEST_USERS.doctorA.username])).rows[0];
    const patientId = (await db.query("INSERT INTO patients(patient_number,full_name,primary_doctor_id,birth_year) VALUES($1,$2,$3,NULL) RETURNING id",
      [`SYN-REVIEW-${randomUUID()}`, `مراجعة سيفالو اصطناعية ${width}`, doctor.party_id])).rows[0].id;
    const context = await browser.newContext({ viewport: { width, height: 900 }, locale: "ar-YE", timezoneId: "Asia/Aden" });
    const [name, ...value] = h.sessions.doctorA.cookie.split("=");
    await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
    const page = await context.newPage(), errors: string[] = [];
    page.setDefaultTimeout(15_000); page.on("pageerror", error => errors.push(error.message));
    try {
      const png = await page.evaluate(() => {
        const canvas = document.createElement("canvas"); canvas.width = 500; canvas.height = 300;
        const g = canvas.getContext("2d")!; g.fillStyle = "#edf2f7"; g.fillRect(0, 0, 500, 300);
        g.fillStyle = "#334155"; g.font = "20px sans-serif"; g.fillText("SYNTHETIC — NOT AN X-RAY", 30, 160);
        return canvas.toDataURL("image/png").split(",")[1];
      });
      const form = new FormData();
      form.set("file", new Blob([new Uint8Array(Buffer.from(png, "base64"))], { type: "image/png" }), "synthetic-review.png");
      form.set("kind", "imaging"); form.set("title", "Synthetic review test image");
      const uploaded = await fetch(`${baseUrl}/api/patients/${patientId}/documents`, { method: "POST", body: form,
        headers: { Cookie: h.sessions.admin.cookie, Origin: baseUrl, "Sec-Fetch-Site": "same-origin" } });
      expect(uploaded.status).toBe(201); const documentId = (await uploaded.json()).id;
      const opened = await authedMutation(`/api/patients/${patientId}/ceph`, h.sessions.doctorA, "POST", JSON.stringify({ documentId, phase: "pretreatment", xrayDate: null }));
      expect(opened.status).toBe(201); const id = (await opened.json()).id;
      const saved = async () => (await db.query("SELECT skeletal,dental,soft_tissue,final_dx,note,created_by FROM ceph_diagnoses WHERE analysis_id=$1", [id])).rows;
      expect((await page.goto(`${baseUrl}/ceph/${id}`))?.status()).toBe(200);
      const section = page.locator("div.border-t").filter({ has: page.getByText("التشخيص السيفالومتري المنظم", { exact: true }) });
      await section.getByPlaceholder("هيكلي…", { exact: true }).waitFor();
      expect(await page.getByRole("button", { name: "توليد التشخيص الذكي", exact: true }).count()).toBe(0);
      expect(await page.getByRole("button", { name: "تعبئة أساسية", exact: true }).count()).toBe(0);
      for (const field of await section.locator("textarea").all()) expect(await field.inputValue()).toBe("");
      expect(await saved()).toEqual([]);

      for (const flags of [{}, { useAiChat: true, save: true, saveToDiagnosis: true }]) {
        const response = await authedMutation(`/api/ceph/${id}/ai-analyze`, h.sessions.doctorA, "POST", JSON.stringify({ action: "generate-diagnosis", ...flags }));
        expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ code: "clinical_review_required" });
      }
      expect((await authedMutation(`/api/ceph/${id}/ai-analyze`, h.sessions.doctorB, "POST", JSON.stringify({ action: "generate-diagnosis", saveToDiagnosis: true }))).status).toBe(403);
      expect((await fetch(`${baseUrl}/api/ceph/${id}/ai-analyze`, { method: "POST", headers: { "Content-Type": "application/json", Origin: baseUrl, "Sec-Fetch-Site": "same-origin" }, body: JSON.stringify({ action: "generate-diagnosis" }) })).status).toBe(401);
      expect(await saved()).toEqual([]);

      const authored = ["تقييم هيكلي كتبه الطبيب للاختبار", "مراجعة القواطع لاحقاً", "الفحص السريري مطلوب", "الاستنتاج الاصطناعي للطبيب", "قرار علاجي مؤجل حتى اكتمال السجلات"];
      const fields = section.locator("textarea");
      expect(await fields.count()).toBe(5);
      for (let i = 0; i < authored.length; i++) await fields.nth(i).fill(authored[i]);
      const wrote = page.waitForResponse(r => r.url().endsWith(`/api/ceph/${id}`) && r.request().method() === "PATCH");
      await section.getByRole("button", { name: "حفظ التشخيص", exact: true }).click();
      expect((await wrote).status()).toBe(200);
      const before = await saved(); expect(before).toHaveLength(1);
      expect(before[0]).toMatchObject({ skeletal: authored[0], dental: authored[1], soft_tissue: authored[2], final_dx: authored[3], note: authored[4] });
      await page.reload(); await fields.nth(0).waitFor();
      for (let i = 0; i < authored.length; i++) expect(await fields.nth(i).inputValue()).toBe(authored[i]);

      await fields.nth(0).fill("مسودة محفوظة على الشاشة عند رفض الكتابة");
      await db.query("UPDATE users SET permissions=$1 WHERE username=$2", [JSON.stringify({ ...JSON.parse(doctor.permissions), canUploadXrays: false }), TEST_USERS.doctorA.username]);
      const refused = page.waitForResponse(r => r.url().endsWith(`/api/ceph/${id}`) && r.request().method() === "PATCH");
      await section.getByRole("button", { name: "حفظ التشخيص", exact: true }).click();
      expect((await refused).status()).toBe(403);
      await page.getByText("غير مصرّح لك بالوصول لهذا التحليل.", { exact: true }).waitFor();
      expect(await fields.nth(0).inputValue()).toBe("مسودة محفوظة على الشاشة عند رفض الكتابة");
      expect(await saved()).toEqual(before);
      await section.scrollIntoViewIfNeeded();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await page.screenshot({ path: `.settings-ui-artifacts/ceph-clinician-review-${width}.png` });

      // Fixture-only historical status, with explicit author; no production record
      // is touched and no claim is made that incomplete landmarks were completed.
      await db.query("UPDATE ceph_analyses SET status='completed',completed_by='synthetic archive',completed_at=NOW() WHERE id=$1", [id]);
      await page.reload(); await section.getByText(authored[3], { exact: false }).waitFor();
      expect(await section.locator("textarea").count()).toBe(0);
      expect(await saved()).toEqual(before);
      expect(await section.innerText()).toContain(authored[4]);
      expect(errors).toEqual([]);
    } finally {
      await db.query("UPDATE users SET permissions=$1 WHERE username=$2", [doctor.permissions, TEST_USERS.doctorA.username]);
      await context.close();
    }
  });
});
