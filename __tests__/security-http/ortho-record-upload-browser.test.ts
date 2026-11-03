import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import sharp from "sharp";
import { Client } from "pg";
import { chromium, type Browser } from "playwright";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { baseUrl, harness, authedMutation, authedGet } from "./_server";
let h: Awaited<ReturnType<typeof harness>>, db: Client, browser: Browser;
beforeAll(async () => {
  h = await harness(); expect(new URL(h.seeded.dbUrl).pathname).toBe("/aqlan_sec_http");
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false }); await db.connect();
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
  await mkdir(".settings-ui-artifacts", { recursive: true });
});
afterAll(async () => { await browser?.close(); await db?.end(); });
async function scope() {
  const patientId = (await db.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'صور حالة اصطناعية') RETURNING id", [`SYN-RECORD-${randomUUID()}`])).rows[0].id;
  const opened = await authedMutation("/api/ortho/intake", h.sessions.admin, "POST", JSON.stringify({ patientId, command: { schemaVersion: 1, clientRequestId: randomUUID(), reason: "ملف اصطناعي لتوثيق الصور" } }));
  expect(opened.status).toBe(201); return { patientId, orthoCaseId: (await opened.json()).orthoCaseId as number };
}
describe("explicit source image capture and same-command recovery", () => {
  it.each([390, 1280])("previews before upload, preserves a draft, and stores one original with verified provenance at %ipx", async width => {
    const { patientId, orthoCaseId } = await scope();
    const bytes = await sharp({ create: { width: 80, height: 120, channels: 3, background: "#315d80" } }).png().toBuffer();
    const docs = async () => (await db.query("SELECT id,ortho_case_id,taken_on::text,photo_stage,photo_view,sha256,note FROM patient_documents WHERE patient_id=$1 ORDER BY id", [patientId])).rows;
    const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: "ar-YE" });
    const [name, ...value] = h.sessions.admin.cookie.split("="); await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
    const page = await context.newPage(), errors: string[] = [], commands: string[] = []; page.setDefaultTimeout(20000); page.on("pageerror", e => errors.push(e.message));
    try {
      await page.goto(`${baseUrl}/patients/${patientId}?tab=treatment&sub=ortho&orthoCaseId=${orthoCaseId}&pillar=diagnostics#ortho-assessment/${patientId}/${orthoCaseId}/records`);
      const grid = page.getByTestId("ortho-records-grid");
      const chooser = page.waitForEvent("filechooser"); await page.getByTestId("ortho-record-slot-extraoral_frontal").getByRole("button", { name: /إضافة صورة/ }).click();
      await (await chooser).setFiles({ name: "synthetic-record.png", mimeType: "image/png", buffer: bytes });
      await page.getByAltText("معاينة الصورة المختارة قبل الرفع").waitFor(); expect(await docs()).toHaveLength(0);
      await page.getByRole("button", { name: "حفظ الصورة ومصدرها", exact: true }).click();
      await page.getByText("اختر مرحلة الصورة وحالة تاريخ التصوير، أو صرّح بأنهما غير معلومين.", { exact: true }).waitFor(); expect(await docs()).toHaveLength(0);
      await page.getByLabel("عنوان صورة التقويم", { exact: true }).fill("صورة أصلية اصطناعية موثقة");
      await page.getByLabel("مرحلة صورة التقويم", { exact: true }).selectOption(width === 390 ? "unknown" : "initial");
      await page.getByLabel("حالة تاريخ تصوير التقويم", { exact: true }).selectOption(width === 390 ? "unknown" : "known");
      if (width === 1280) await page.getByLabel("تاريخ تصوير التقويم", { exact: true }).fill("2026-01-02");
      await page.getByLabel("مصدر صورة التقويم وتاريخها", { exact: true }).fill("مصدر اصطناعي موثق؛ لا بيانات لمريض حقيقي");
      // Changing diagnostic sections preserves the selected file and its source.
      await page.getByRole("button", { name: "فحص الوجه والابتسامة", exact: true }).click();
      await page.getByRole("button", { name: "الصور والأشعة", exact: true }).click();
      await page.getByRole("button", { name: /خطة العلاج والميكانيكا/ }).click();
      await page.getByRole("button", { name: /السجلات والسيفالومتري/ }).click();
      expect(await page.getByLabel("عنوان صورة التقويم", { exact: true }).inputValue()).toBe("صورة أصلية اصطناعية موثقة");
      await page.route(`**/api/ortho/${orthoCaseId}/record-uploads`, async route => {
        const response = await route.fetch(); commands.push((await response.json()).commandId);
        if (commands.length === 1) { expect(response.status()).toBe(201); return route.abort("failed"); }
        expect(response.status()).toBe(200); return route.fulfill({ response });
      });
      await page.getByRole("button", { name: "حفظ الصورة ومصدرها", exact: true }).click();
      await page.getByRole("button", { name: "التحقق بنفس طلب رفع الصورة", exact: true }).waitFor(); expect(await docs()).toHaveLength(1);
      await page.getByRole("button", { name: "التحقق بنفس طلب رفع الصورة", exact: true }).click();
      await expect.poll(() => page.getByRole("region", { name: "توثيق الصورة قبل رفعها" }).count()).toBe(0);
      expect(commands).toHaveLength(2); expect(commands[0]).toBe(commands[1]);
      const stored = await docs(); expect(stored).toHaveLength(1); expect(stored[0]).toMatchObject({ ortho_case_id: orthoCaseId, taken_on: width === 390 ? null : "2026-01-02", photo_stage: width === 390 ? null : "initial", photo_view: "extraoral_frontal", sha256: createHash("sha256").update(bytes).digest("hex") });
      expect(stored[0].note).toContain("مصدر اصطناعي موثق");
      const image = await authedGet(`/api/documents/${stored[0].id}`, h.sessions.admin); expect(image.status).toBe(200); expect(image.headers.get("cache-control")).toContain("private"); expect(Buffer.from(await image.arrayBuffer())).toEqual(bytes);
      expect((await authedGet(`/api/documents/${stored[0].id}`, h.sessions.doctorB)).status).toBe(403);
      await page.reload(); await grid.getByText(`تاريخ التصوير: ${width === 390 ? "غير معلوم" : "2026-01-02"}`, { exact: true }).waitFor();
      await grid.locator("summary").filter({ hasText: "تاريخ التصوير" }).click(); await grid.getByText(/مصدر الصورة والتاريخ:/).waitFor();
      expect(await docs()).toEqual(stored);
      expect((await db.query("SELECT (SELECT count(*)::int FROM ortho_record_uploads WHERE patient_id=$1) uploads,(SELECT count(*)::int FROM invoices WHERE patient_id=$1) invoices,(SELECT count(*)::int FROM payments WHERE patient_id=$1) payments,(SELECT count(*)::int FROM visits WHERE patient_id=$1) visits", [patientId])).rows[0]).toEqual({ uploads: 1, invoices: 0, payments: 0, visits: 0 });
      expect(errors).toEqual([]); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const faceGrid = page.getByTestId("ortho-record-slot-extraoral_frontal").locator("..");
      const thumbnail = page.getByTestId("ortho-record-slot-extraoral_frontal").locator("img");
      const bounds = await thumbnail.boundingBox(); expect(bounds).not.toBe(null); expect(bounds!.height).toBeGreaterThan(60); expect(bounds!.width / bounds!.height).toBeCloseTo(4 / 3, 1);
      await faceGrid.scrollIntoViewIfNeeded(); await page.mouse.move(0, 0);
      await faceGrid.screenshot({ path: `.settings-ui-artifacts/ortho-record-upload-${width}.png`, animations: "disabled" });
    } finally { await context.close(); }
  });
  it("refuses unreadable, foreign and mismatched source uploads over authenticated multipart HTTP", async () => {
    const one = await scope(), other = await scope();
    const bytes = await sharp({ create: { width: 20, height: 30, channels: 3, background: "#335588" } }).png().toBuffer();
    const command = (data: Buffer) => ({ schemaVersion: 1, clientRequestId: randomUUID(), title: "Synthetic HTTP image", photoView: "extraoral_frontal", photoStage: null, occurrence: { state: "unknown", takenOn: null, sourceNote: "Synthetic source date unknown" }, file: { sha256: createHash("sha256").update(data).digest("hex"), mimeType: "image/png", sizeBytes: data.length } });
    async function upload(patientId: number, data: Buffer, cmd = command(data)) {
      const form = new FormData(); form.set("patientId", String(patientId)); form.set("command", JSON.stringify(cmd)); form.set("file", new Blob([new Uint8Array(data)], { type: "image/png" }), "synthetic.png");
      return fetch(`${baseUrl}/api/ortho/${one.orthoCaseId}/record-uploads`, { method: "POST", headers: { Cookie: h.sessions.admin.cookie, Origin: baseUrl, "Sec-Fetch-Site": "same-origin" }, body: form, redirect: "manual" });
    }
    expect((await upload(other.patientId, bytes)).status).toBe(404);
    expect((await upload(one.patientId, bytes, { ...command(bytes), file: { ...command(bytes).file, sha256: "b".repeat(64) } })).status).toBe(400);
    const invalid = bytes.subarray(0, 20); const unreadable = await upload(one.patientId, invalid);
    expect(unreadable.status).toBe(400); expect(await unreadable.json()).toMatchObject({ code: "unreadable_record_image" });
    expect((await db.query("SELECT count(*)::int n FROM patient_documents WHERE patient_id=ANY($1)", [[one.patientId, other.patientId]])).rows[0].n).toBe(0);
  });
});
