import { mkdir } from "node:fs/promises";
import { Client } from "pg";
import { chromium, type Browser, type Locator, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { baseUrl, harness, TEST_USERS } from "./_server";

// Actual built Next patient page/CSS/SessionProvider/PatientOrtho. The database
// fixture exists only in aqlan_sec_http; browser requests are read-only. One
// synthetic image response is intercepted, and a queued File stays in memory.
// Exactly two viewport PNGs capture both new informational messages together.
let h: Awaited<ReturnType<typeof harness>>;
let db: Client, browser: Browser, patientId: number, caseId: number, documentId: number;
const marker = "SYNTHETIC-ORTHO-PHOTO-COMPLETENESS";
const unknownText = "تعذّر تأكيد اكتمال مجموعات الصور المحفوظة من البيانات المتاحة؛ لا يعني ذلك عدم وجود صور.";
const queueText = "الصور المختارة معاينة فقط؛ لا تُعد مجموعة محفوظة حتى تظهر في السجل بعد نجاح الرفع.";
beforeAll(async () => {
  h = await harness();
  expect(new URL(h.seeded.dbUrl).pathname).toBe("/aqlan_sec_http");
  expect(new URL(baseUrl).hostname).toBe("127.0.0.1");
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false }); await db.connect();
  const doctor = Number((await db.query(
    "SELECT party_id FROM users WHERE username=$1", [TEST_USERS.doctorA.username],
  )).rows[0].party_id);
  expect(Number.isSafeInteger(doctor)).toBe(true);
  patientId = Number((await db.query(
    "INSERT INTO patients (patient_number,full_name,primary_doctor_id) VALUES ($1,$2,$3) RETURNING id",
    ["ORTHO-PHOTO-UI-" + Date.now(), "مريض صور تقويم اصطناعي — ليس حقيقياً", doctor],
  )).rows[0].id);
  caseId = Number((await db.query(
    "INSERT INTO ortho_cases (patient_id,status,phase,upper_wire,lower_wire,bracket_system,created_by)"
      + " VALUES ($1,'active','aligning','014 NiTi','012 NiTi',$2,'synthetic-ortho-photo-ui') RETURNING id",
    [patientId, marker],
  )).rows[0].id);
  const adjustmentId = Number((await db.query(
    "INSERT INTO ortho_adjustments (case_id,done_on,phase,upper_wire,lower_wire,recorded_by)"
      + " VALUES ($1,(NOW() AT TIME ZONE 'Asia/Aden')::date,'aligning','014 NiTi','012 NiTi','synthetic-ortho-photo-ui') RETURNING id",
    [caseId],
  )).rows[0].id);
  // Missing taken_on is deliberate legacy metadata, not evidence of no images.
  documentId = Number((await db.query(
    "INSERT INTO patient_documents (patient_id,ortho_case_id,adjustment_id,kind,title,mime_type,size_bytes,sha256,storage_key,uploaded_by,photo_stage,photo_view)"
      + " VALUES ($1,$2,$3,'photo','صورة تقويم اصطناعية بلا تاريخ','image/png',68,$4,$5,'synthetic-ortho-photo-ui','initial','intraoral_frontal') RETURNING id",
    [patientId, caseId, adjustmentId, "0".repeat(64), "synthetic-ortho-photo-ui/" + patientId + "/image.png"],
  )).rows[0].id);
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
  await mkdir(".settings-ui-artifacts", { recursive: true });
}, 240_000);
afterAll(async () => { await browser?.close(); await db?.end(); });

async function storedState() {
  // Whole-row equality protects clinical and financial truth while the browser
  // only selects a local preview; no upload or adjustment mutation is allowed.
  return (await db.query(`SELECT
    (SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY p.id),'[]'::jsonb) FROM patients p WHERE p.id=$1) AS patient,
    (SELECT COALESCE(jsonb_agg(to_jsonb(c) ORDER BY c.id),'[]'::jsonb) FROM ortho_cases c WHERE c.patient_id=$1) AS cases,
    (SELECT COALESCE(jsonb_agg(to_jsonb(a) ORDER BY a.id),'[]'::jsonb) FROM ortho_adjustments a JOIN ortho_cases c ON c.id=a.case_id WHERE c.patient_id=$1) AS adjustments,
    (SELECT COALESCE(jsonb_agg(to_jsonb(d) ORDER BY d.id),'[]'::jsonb) FROM patient_documents d WHERE d.patient_id=$1) AS documents,
    (SELECT COALESCE(jsonb_agg(to_jsonb(v) ORDER BY v.id),'[]'::jsonb) FROM visits v WHERE v.patient_id=$1) AS visits,
    (SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY p.id),'[]'::jsonb) FROM treatment_plans p WHERE p.patient_id=$1) AS plans,
    (SELECT COALESCE(jsonb_agg(to_jsonb(i) ORDER BY i.id),'[]'::jsonb) FROM plan_installments i JOIN treatment_plans p ON p.id=i.plan_id WHERE p.patient_id=$1) AS installments,
    (SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY p.id),'[]'::jsonb) FROM payments p WHERE p.patient_id=$1) AS payments,
    (SELECT COALESCE(jsonb_agg(to_jsonb(i) ORDER BY i.id),'[]'::jsonb) FROM invoices i WHERE i.patient_id=$1) AS invoices,
    (SELECT COALESCE(jsonb_agg(to_jsonb(a) ORDER BY a.id),'[]'::jsonb) FROM appointments a WHERE a.patient_id=$1) AS appointments`, [patientId])).rows;
}
async function fixture(width: number) {
  const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 1000 },
    locale: "ar-YE", timezoneId: "Asia/Aden", serviceWorkers: "block" });
  const [name, ...value] = h.sessions.admin.cookie.split("=");
  await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
  const unexpected: string[] = [], errors: string[] = [];
  await context.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    if (url.origin !== baseUrl || !["GET", "HEAD", "OPTIONS"].includes(method)) {
      unexpected.push(method + " " + url.origin + url.pathname); await route.abort(); return;
    }
    if (url.pathname === "/api/documents/" + documentId && url.search === "") {
      await route.fulfill({ contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="120"><rect width="160" height="120" fill="#dbeafe"/><text x="12" y="60" fill="#1e40af">SYNTHETIC</text></svg>' }); return;
    }
    await route.continue();
  });
  const page = await context.newPage(); page.on("pageerror", error => errors.push(error.message));
  try {
    const [read] = await Promise.all([
      page.waitForResponse(response => response.request().method() === "GET"
        && new URL(response.url()).pathname === "/api/ortho"
        && new URL(response.url()).searchParams.get("patientId") === String(patientId)),
      page.goto(baseUrl + "/patients/" + patientId + "?tab=treatment&sub=ortho", { waitUntil: "domcontentloaded" }),
    ]);
    expect(read.status()).toBe(200);
    const payload = await read.json() as { cases: Array<{
      id: number; patientId: number; bracketSystem: string; photosVisible: boolean;
      adjustments: Array<{ photos: Array<{ id: number; takenOn: string | null }> }>;
    }> };
    const one = payload.cases.find(row => row.id === caseId);
    expect(one).toMatchObject({ patientId, bracketSystem: marker, photosVisible: true });
    expect(one?.adjustments.flatMap(row => row.photos).find(photo => photo.id === documentId)?.takenOn).toBeNull();
    const workspace = page.locator('[data-testid="patient-ortho-workspace"]');
    await expect.poll(() => workspace.getAttribute("data-read-state")).toBe("ready");
    await workspace.getByRole("button", { name: /سجّل شدّة وجلسة جديدة الآن/ }).click();
    const form = workspace.locator("form").filter({ has: page.getByLabel("ما نُفّذ في الشدّة", { exact: true }) });
    await form.getByLabel("ما نُفّذ في الشدّة", { exact: true }).fill("معاينة اصطناعية فقط؛ لم تُحفظ");
    const unknown = form.locator('[data-testid="ortho-photo-history-unknown"]');
    await unknown.waitFor(); expect(await unknown.textContent()).toBe(unknownText);
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZs8AAAAASUVORK5CYII=", "base64");
    await form.getByLabel("اختيار صور", { exact: true }).setInputFiles({
      name: "synthetic-queued-photo.png", mimeType: "image/png", buffer: png,
    });
    await expect.poll(() => form.locator('img[src^="blob:"]').count()).toBe(1);
    await form.getByLabel("وجه الصورة", { exact: true }).selectOption("intraoral_frontal");
    const queue = form.locator('[data-testid="ortho-photo-queue-preview"]');
    await queue.waitFor(); expect(await queue.textContent()).toBe(queueText);
    return { page, context, form, unknown, queue, assertIsolated: () => {
      expect(unexpected).toEqual([]); expect(errors).toEqual([]);
    } };
  } catch (error) { await context.close(); throw error; }
}
async function messageBounds(message: Locator) {
  return message.evaluate(element => {
    const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
    const parent = element.parentElement;
    const clear = [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75], [0.5, 0.5]].map(([x, y]) => {
      const hit = document.elementFromPoint(rect.left + rect.width * x, rect.top + rect.height * y);
      return hit !== null && (hit === element || element.contains(hit));
    });
    return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height,
      viewportWidth: innerWidth, viewportHeight: innerHeight, direction: style.direction, fontSize: style.fontSize,
      parentBackground: parent ? getComputedStyle(parent).backgroundColor : null,
      clear, noOverflow: document.documentElement.scrollWidth <= innerWidth + 1 };
  });
}
async function captureMessages(page: Page, unknown: Locator, queue: Locator, width: number) {
  await unknown.evaluate(element => element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" }));
  await page.evaluate(async () => { await document.fonts.ready;
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))); });
  const allBounds = [await messageBounds(unknown), await messageBounds(queue)];
  // Save the actual styled viewport before fatal geometry assertions. No CSS,
  // chrome changes, full-page composites, traces, HAR or auth state are saved.
  await page.screenshot({ path: ".settings-ui-artifacts/ortho-photo-completeness-" + width + ".png" });
  for (const bounds of allBounds) {
    expect(bounds.direction).toBe("rtl"); expect(bounds.noOverflow).toBe(true);
    expect(bounds.fontSize).toBe("10px"); expect(bounds.parentBackground).toBe("rgb(255, 255, 255)");
    expect(bounds.width).toBeGreaterThan(160); expect(bounds.height).toBeGreaterThanOrEqual(10);
    expect(bounds.left).toBeGreaterThanOrEqual(0); expect(bounds.top).toBeGreaterThanOrEqual(0);
    expect(bounds.right).toBeLessThanOrEqual(bounds.viewportWidth); expect(bounds.bottom).toBeLessThanOrEqual(bounds.viewportHeight);
    expect(bounds.clear).toEqual([true, true, true, true, true]);
  }
}

describe("photo completeness messages on the real built RTL patient page", () => {
  it.each([1280, 390])("shows styled unknown history and queued-preview information without a clinical write at %ipx", async width => {
    const before = await storedState(), f = await fixture(width);
    try {
      expect(await f.form.textContent()).not.toContain("ناقص:");
      expect(await f.form.locator('button[type="submit"]').isEnabled()).toBe(true);
      await captureMessages(f.page, f.unknown, f.queue, width);
      expect(new URL(f.page.url()).pathname).toBe("/patients/" + patientId);
      f.assertIsolated(); expect(await storedState()).toEqual(before);
    } finally { await f.context.close(); }
  });
});
