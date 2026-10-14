import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { Client } from "pg";
import { chromium, type Browser, type Locator, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REQUIRED_LANDMARKS, type LandmarkMap } from "../../lib/ceph";
import { authedMutation, baseUrl, harness } from "./_server";

let browser: Browser, db: Client, h: Awaited<ReturnType<typeof harness>>;
beforeAll(async () => {
  h = await harness();
  expect(new URL(h.seeded.dbUrl).pathname).toBe("/aqlan_sec_http");
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false }); await db.connect();
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
  await mkdir(".settings-ui-artifacts", { recursive: true });
});
afterAll(async () => { await browser?.close(); await db?.end(); });

async function captureVisibleRow(page: Page, row: Locator, path: string) {
  await row.evaluate(element => element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" }));
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  const visible = await row.evaluate(element => {
    const box = element.getBoundingClientRect();
    const x = Math.max(0, Math.min(innerWidth - 1, (Math.max(0, box.left) + Math.min(innerWidth, box.right)) / 2));
    const y = box.top + box.height / 2;
    const hit = document.elementFromPoint(x, y);
    return { width: innerWidth, top: box.top, bottom: box.bottom,
      inViewport: box.top >= 0 && box.bottom <= innerHeight,
      unobscured: hit !== null && element.contains(hit) };
  });
  expect(visible.inViewport).toBe(true);
  expect(visible.unobscured).toBe(true);
  await page.screenshot({ path });
  await writeFile(path.replace(/\.png$/, ".json"), JSON.stringify(visible, null, 2));
}

describe("versioned ceph planes in the built browser and print consumer", () => {
  it.each([390, 1280])("keeps new and historic stamps distinct at %ipx", async width => {
    const patientId = (await db.query("INSERT INTO patients(patient_number,full_name,birth_year) VALUES($1,$2,2000) RETURNING id",
      [`SYN-PLANES-${randomUUID()}`, `قياسات اصطناعية ${width}`])).rows[0].id;
    const context = await browser.newContext({ viewport: { width, height: 900 }, locale: "ar-YE", timezoneId: "Asia/Aden" });
    const [name, ...value] = h.sessions.admin.cookie.split("=");
    await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
    const page = await context.newPage(), errors: string[] = [];
    page.setDefaultTimeout(15_000); page.on("pageerror", error => errors.push(error.message));
    try {
      // A new explicitly synthetic 500px test image, made in native canvas and
      // uploaded through real multipart/storage. No source radiograph is claimed.
      const png = await page.evaluate(() => {
        const c = document.createElement("canvas"); c.width = 500; c.height = 500;
        const g = c.getContext("2d")!; g.fillStyle = "#edf2f7"; g.fillRect(0, 0, 500, 500);
        g.fillStyle = "#334155"; g.font = "20px sans-serif"; g.fillText("SYNTHETIC GEOMETRY — NOT AN X-RAY", 20, 450);
        return c.toDataURL("image/png").split(",")[1];
      });
      const form = new FormData(); form.set("file", new Blob([new Uint8Array(Buffer.from(png, "base64"))], { type: "image/png" }), "synthetic-planes.png");
      form.set("kind", "imaging"); form.set("title", "Synthetic plane verification — not a patient image");
      const upload = await fetch(`${baseUrl}/api/patients/${patientId}/documents`, { method: "POST", body: form,
        headers: { Cookie: h.sessions.admin.cookie, Origin: baseUrl, "Sec-Fetch-Site": "same-origin" } });
      expect(upload.status).toBe(201); const documentId = (await upload.json()).id;
      const opened = await authedMutation(`/api/patients/${patientId}/ceph`, h.sessions.admin, "POST", JSON.stringify({ documentId, phase: "pretreatment", xrayDate: null }));
      expect(opened.status).toBe(201); const id = (await opened.json()).id;
      expect((await authedMutation(`/api/ceph/${id}`, h.sessions.admin, "PATCH", JSON.stringify({ calibration: { x1: 0, y1: 0, x2: 100, y2: 0, mm: 50 } }))).status).toBe(200);
      const points: LandmarkMap = { S: { x: 100, y: 100 }, N: { x: 110, y: 100 },
        Po: { x: 100, y: 80 }, Or: { x: 100 + 10 * Math.sqrt(3), y: 90 },
        Go: { x: 100, y: 110 }, Gn: { x: 110, y: 120 }, Me: { x: 100 + 10 * Math.sqrt(3), y: 100 } };
      const landmarks = [...new Set([...REQUIRED_LANDMARKS, ...Object.keys(points)])].map((code, i) => ({ code,
        ...(points[code as keyof LandmarkMap] ?? { x: 40 + i * 3, y: 40 + (i * 7) % 100 }), source: "manual" }));
      expect((await authedMutation(`/api/ceph/${id}`, h.sessions.admin, "PATCH", JSON.stringify({ landmarks }))).status).toBe(200);
      expect((await context.request.get(`${baseUrl}/api/auth/me`)).status()).toBe(200);
      const workspace = await page.goto(`${baseUrl}/ceph/${id}`);
      expect(workspace?.status()).toBe(200);
      expect(new URL(page.url()).pathname).toBe(`/ceph/${id}`);
      const row = (code: string) => page.getByRole("row").filter({ hasText: code });
      await row("STEINER_SN_GOGN_V1").waitFor();
      expect(await row("STEINER_SN_GOGN_V1").innerText()).toContain("45");
      expect(await row("DOWNS_FH_GOME_V1").innerText()).toContain("60");
      expect(await row("STEINER_SN_GOGN_V1").innerText()).toContain("المرجع غير محقق");
      page.once("dialog", dialog => dialog.accept());
      const completed = page.waitForResponse(response => response.url().endsWith(`/api/ceph/${id}/complete`));
      await page.getByRole("button", { name: "اعتماد التحليل", exact: true }).click();
      expect((await completed).status()).toBe(200);
      await page.getByText("القياسات المعتمدة — لقطة الاعتماد", { exact: true }).waitFor();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      const current = (await db.query("SELECT code,value FROM ceph_measurements WHERE analysis_id=$1 ORDER BY code", [id])).rows;
      expect(current.find(r => r.code === "STEINER_SN_GOGN_V1").value).toBeCloseTo(45, 10);
      expect(current.find(r => r.code === "DOWNS_FH_GOME_V1").value).toBeCloseTo(60, 10);
      await captureVisibleRow(page, row("STEINER_SN_GOGN_V1"), `.settings-ui-artifacts/ceph-versioned-current-${width}.png`);
      const historical = (await db.query(`INSERT INTO ceph_analyses(patient_id,document_id,status,phase,xray_date,created_by,completed_by,completed_at)
        VALUES($1,$2,'completed','during',NULL,'synthetic archive','synthetic archive',TIMESTAMPTZ '2026-10-14 23:30:00+00') RETURNING id`, [patientId, documentId])).rows[0].id;
      await db.query("INSERT INTO ceph_measurements(analysis_id,code,value) VALUES($1,'SNGOGN',31.678901234)", [historical]);
      await page.goto(`${baseUrl}/ceph/${historical}`);
      await row("SNGOGN").waitFor();
      expect(await row("SNGOGN").innerText()).toContain("31.7");
      expect(await row("SNGOGN").innerText()).toContain("Historical SN–GoMe");
      expect(await row("STEINER_SN_GOGN_V1").count()).toBe(0);
      expect(await row("DOWNS_FH_GOME_V1").count()).toBe(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await captureVisibleRow(page, row("SNGOGN"), `.settings-ui-artifacts/ceph-versioned-historical-${width}.png`);
      await page.goto(`${baseUrl}/print/ceph/${historical}`);
      expect(await row("SNGOGN").innerText()).toContain("31.7");
      expect(await row("STEINER_SN_GOGN_V1").count()).toBe(0);
      expect(await page.locator("body").innerText()).not.toContain("26 سنة");
      expect(await row("SNGOGN").innerText()).toContain("Reference unverified");
      expect((await db.query("SELECT code,value FROM ceph_measurements WHERE analysis_id=$1", [historical])).rows).toEqual([{ code: "SNGOGN", value: 31.678901234 }]);
      expect((await db.query("SELECT code,value FROM ceph_measurements WHERE analysis_id=$1 ORDER BY code", [id])).rows).toEqual(current);
      expect(errors).toEqual([]);
    } catch (error) {
      await page.screenshot({ path: `.settings-ui-artifacts/ceph-versioned-failure-${width}.png`, fullPage: true });
      await writeFile(`.settings-ui-artifacts/ceph-versioned-failure-${width}.txt`, await page.locator("body").innerText());
      throw error;
    } finally { await context.close(); }
  });
});
