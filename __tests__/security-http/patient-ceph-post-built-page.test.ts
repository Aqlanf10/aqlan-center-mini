import { mkdir } from "node:fs/promises";
import { Client } from "pg";
import { chromium, type Browser, type Locator, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { baseUrl, harness, TEST_USERS } from "./_server";

// Actual built Next patient page, CSS, SessionProvider, PatientOrtho and Ceph
// handlers. Only one armed synthetic Ceph POST and synthetic image bytes are
// intercepted. No browser mutation reaches the isolated server, and no real
// patient, financial record, storage object or Production service is touched.
let h: Awaited<ReturnType<typeof harness>>;
let db: Client, browser: Browser, patientId: number, caseId: number, documentId: number;
const marker = "SYNTHETIC-CEPH-POST-LIFETIME";
const NEW = "+ دراسة سيفالومترية جديدة", OPEN = "📐 افتح مساحة التتبع والتحليل";
const WARNING = "تعذّر تأكيد فتح التحليل. قد يكون الطلب نُفّذ؛ راجع الدراسات قبل المحاولة مجددًا.";
const syntheticAnalysisId = 987654321;
beforeAll(async () => {
  h = await harness();
  expect(new URL(h.seeded.dbUrl).pathname).toBe("/aqlan_sec_http");
  expect(new URL(baseUrl).hostname).toBe("127.0.0.1");
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false }); await db.connect();
  const doctor = Number((await db.query("SELECT party_id FROM users WHERE username=$1", [TEST_USERS.doctorA.username])).rows[0].party_id);
  expect(Number.isSafeInteger(doctor)).toBe(true);
  patientId = Number((await db.query(
    "INSERT INTO patients (patient_number,full_name,primary_doctor_id) VALUES ($1,$2,$3) RETURNING id",
    ["CEPH-POST-UI-" + Date.now(), "مريض سيفالو اصطناعي — ليس حقيقياً", doctor],
  )).rows[0].id);
  caseId = Number((await db.query(
    "INSERT INTO ortho_cases (patient_id,status,phase,bracket_system,created_by) VALUES ($1,'active','aligning',$2,'synthetic-ceph-post-ui') RETURNING id",
    [patientId, marker],
  )).rows[0].id);
  documentId = Number((await db.query(
    "INSERT INTO patient_documents (patient_id,ortho_case_id,kind,title,mime_type,size_bytes,sha256,storage_key,uploaded_by,photo_stage,photo_view)"
      + " VALUES ($1,$2,'photo','صورة سيفالو اصطناعية','image/png',68,$3,$4,'synthetic-ceph-post-ui','initial','lateral_ceph') RETURNING id",
    [patientId, caseId, "0".repeat(64), "synthetic-ceph-post-ui/" + patientId + "/image.png"],
  )).rows[0].id);
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
  await mkdir(".settings-ui-artifacts", { recursive: true });
}, 240_000);
afterAll(async () => { await browser?.close(); await db?.end(); });

async function storedState() {
  // Exact whole-row equality across clinical and financial owners; the one
  // synthetic POST response never creates the advertised analysis ID.
  return (await db.query([
    "SELECT",
    "(SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY p.id),'[]'::jsonb) FROM patients p WHERE p.id=$1) AS patient,",
    "(SELECT COALESCE(jsonb_agg(to_jsonb(c) ORDER BY c.id),'[]'::jsonb) FROM ortho_cases c WHERE c.patient_id=$1) AS cases,",
    "(SELECT COALESCE(jsonb_agg(to_jsonb(d) ORDER BY d.id),'[]'::jsonb) FROM patient_documents d WHERE d.patient_id=$1) AS documents,",
    "(SELECT COALESCE(jsonb_agg(to_jsonb(a) ORDER BY a.id),'[]'::jsonb) FROM ceph_analyses a WHERE a.patient_id=$1) AS analyses,",
    "(SELECT COALESCE(jsonb_agg(to_jsonb(l) ORDER BY l.id),'[]'::jsonb) FROM ceph_landmarks l JOIN ceph_analyses a ON a.id=l.analysis_id WHERE a.patient_id=$1) AS landmarks,",
    "(SELECT COALESCE(jsonb_agg(to_jsonb(m) ORDER BY m.id),'[]'::jsonb) FROM ceph_measurements m JOIN ceph_analyses a ON a.id=m.analysis_id WHERE a.patient_id=$1) AS measurements,",
    "(SELECT COALESCE(jsonb_agg(to_jsonb(d) ORDER BY d.analysis_id),'[]'::jsonb) FROM ceph_diagnoses d JOIN ceph_analyses a ON a.id=d.analysis_id WHERE a.patient_id=$1) AS diagnoses,",
    "(SELECT COALESCE(jsonb_agg(to_jsonb(v) ORDER BY v.id),'[]'::jsonb) FROM visits v WHERE v.patient_id=$1) AS visits,",
    "(SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY p.id),'[]'::jsonb) FROM treatment_plans p WHERE p.patient_id=$1) AS plans,",
    "(SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY p.id),'[]'::jsonb) FROM payments p WHERE p.patient_id=$1) AS payments,",
    "(SELECT COALESCE(jsonb_agg(to_jsonb(i) ORDER BY i.id),'[]'::jsonb) FROM invoices i WHERE i.patient_id=$1) AS invoices",
  ].join("\n"), [patientId])).rows;
}
function caseCard(page: Page) {
  return page.locator("li").filter({ has: page.getByText(new RegExp("^" + marker + "\\s*·")) });
}
async function settle(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}
type Mode = "hold" | "invalid-json";
async function fixture(width: number) {
  const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 1000 },
    locale: "ar-YE", timezoneId: "Asia/Aden", serviceWorkers: "block" });
  const [name, ...value] = h.sessions.admin.cookie.split("=");
  await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
  const postPath = "/api/patients/" + patientId + "/ceph";
  // Ignore cancellation only for this exact intercepted synthetic POST. It
  // still uses native fetch/Response/json and the built application's real
  // callback. This forces late delivery after dismissal rather than letting
  // native transport cancellation make a missing ownership check pass.
  await context.addInitScript(({ postPath }) => {
    const nativeFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      if (url.origin === location.origin && url.pathname === postPath && url.search === "" && method === "POST") {
        return nativeFetch(input, { ...init, signal: undefined });
      }
      return nativeFetch(input, init);
    };
  }, { postPath });
  let armed: Mode | null = null;
  const posts: Array<{ body: Record<string, unknown>; release: () => void }> = [];
  const unexpected: string[] = [], errors: string[] = [], navigationAttempts: string[] = [];
  await context.route("**/*", async (route) => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    if (url.origin !== baseUrl) { unexpected.push(method + " " + url.origin + url.pathname); await route.abort(); return; }
    if (method === "POST" && url.pathname === postPath && url.search === "" && armed) {
      const mode = armed; armed = null;
      let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
      posts.push({ body: request.postDataJSON() as Record<string, unknown>, release });
      if (mode === "hold") await gate;
      await route.fulfill({ status: 201, contentType: "application/json",
        body: mode === "invalid-json" ? "{synthetic-unreadable-response" : JSON.stringify({ id: syntheticAnalysisId }) });
      return;
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      unexpected.push(method + " " + url.pathname); await route.abort(); return;
    }
    if (url.pathname === "/ceph/" + syntheticAnalysisId) {
      navigationAttempts.push(url.pathname);
      await route.fulfill({ status: 200, contentType: "text/html", body: "<title>Unexpected synthetic study navigation</title>" }); return;
    }
    if (url.pathname === "/api/documents/" + documentId) {
      await route.fulfill({ contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="120"><rect width="160" height="120" fill="#dbeafe"/><text x="12" y="60" fill="#1e40af">SYNTHETIC</text></svg>' }); return;
    }
    await route.continue();
  });
  const page = await context.newPage(); page.on("pageerror", (error) => errors.push(error.message));
  try {
    const response = await page.goto(baseUrl + "/patients/" + patientId + "?tab=treatment&sub=ortho", { waitUntil: "domcontentloaded" });
    expect(response?.status()).toBe(200);
    const card = caseCard(page); await card.waitFor();
    await card.getByRole("button", { name: /السجلات/ }).click();
    await card.getByRole("button", { name: NEW, exact: true }).click();
    await expect.poll(() => card.getByRole("button", { name: OPEN, exact: true }).isDisabled()).toBe(false);
    return { page, context, card, posts, navigationAttempts,
      arm: (mode: Mode) => { if (armed) throw new Error("Synthetic POST already armed"); armed = mode; },
      release: async (index = 0) => {
        const response = page.waitForResponse((one) => one.request().method() === "POST"
          && new URL(one.url()).pathname === postPath && new URL(one.url()).search === "");
        posts[index].release(); const delivered = await response;
        expect(delivered.status()).toBe(201); expect(await delivered.finished()).toBeNull(); await settle(page);
      },
      assertIsolated: () => { expect(armed).toBeNull(); expect(unexpected).toEqual([]); expect(errors).toEqual([]); expect(navigationAttempts).toEqual([]); },
    };
  } catch (error) { await context.close(); throw error; }
}
async function captureWarning(page: Page, warning: Locator, width: number) {
  await warning.evaluate((element) => element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" }));
  await page.evaluate(async () => { await document.fonts.ready; }); await settle(page);
  const bounds = await warning.evaluate((element) => {
    const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
    const clear = [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75], [0.5, 0.5]].map(([x, y]) => {
      const hit = document.elementFromPoint(rect.left + rect.width * x, rect.top + rect.height * y);
      return hit !== null && (hit === element || element.contains(hit));
    });
    return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height,
      viewportWidth: innerWidth, viewportHeight: innerHeight, direction: style.direction, background: style.backgroundColor,
      clear, noOverflow: document.documentElement.scrollWidth <= innerWidth + 1 };
  });
  // Save exactly the two requested styled viewport scenes before fatal geometry
  // assertions; no injected CSS, hidden chrome, traces, HAR or browser state.
  await page.screenshot({ path: ".settings-ui-artifacts/patient-ceph-post-uncertain-" + width + ".png" });
  expect(bounds.direction).toBe("rtl"); expect(bounds.noOverflow).toBe(true);
  expect(bounds.background).not.toBe("rgba(0, 0, 0, 0)"); expect(bounds.background).not.toBe("transparent");
  expect(bounds.width).toBeGreaterThan(160); expect(bounds.height).toBeGreaterThan(20);
  expect(bounds.left).toBeGreaterThanOrEqual(0); expect(bounds.top).toBeGreaterThanOrEqual(0);
  expect(bounds.right).toBeLessThanOrEqual(bounds.viewportWidth); expect(bounds.bottom).toBeLessThanOrEqual(bounds.viewportHeight);
  expect(bounds.clear).toEqual([true, true, true, true, true]);
}

describe("PatientCeph delayed writes on the real built patient page", () => {
  for (const mode of ["cancel", "pillar"] as const) {
    it.each([1280, 390])("retires a delayed POST after " + mode + " at %ipx", async (width) => {
      const before = await storedState(), f = await fixture(width);
      try {
        f.arm("hold"); await f.card.getByRole("button", { name: OPEN, exact: true }).click();
        await expect.poll(() => f.posts.length).toBe(1);
        expect(f.posts[0].body).toMatchObject({ documentId, orthoCaseId: caseId, phase: "during", refSet: "builtin_default" });
        const destination = f.page.url();
        if (mode === "cancel") {
          await f.card.getByRole("button", { name: "إلغاء", exact: true }).click();
          await f.card.getByRole("button", { name: NEW, exact: true }).waitFor();
        } else {
          // Released e2ef tab names; no dependency on PR250-only controls.
          await f.card.getByRole("button", { name: /مسار/ }).click();
          await expect.poll(() => f.card.getByRole("button", { name: NEW, exact: true }).count()).toBe(0);
        }
        await f.release();
        expect(f.page.url()).toBe(destination); expect(f.posts).toHaveLength(1);
        expect(await f.card.getByRole("button", { name: OPEN, exact: true }).count()).toBe(0);
        f.assertIsolated(); expect(await storedState()).toEqual(before);
      } finally { await f.context.close(); }
    });
  }

  it.each([1280, 390])("captures the styled uncertain-result warning without resubmission at %ipx", async (width) => {
    const before = await storedState(), f = await fixture(width);
    try {
      f.arm("invalid-json"); await f.card.getByRole("button", { name: OPEN, exact: true }).click();
      const warning = f.card.getByRole("alert").filter({ hasText: WARNING }); await warning.waitFor();
      expect(await warning.textContent()).toBe(WARNING);
      expect(await f.card.getByRole("button", { name: OPEN, exact: true }).isDisabled()).toBe(false);
      await captureWarning(f.page, warning, width);
      expect(f.posts).toHaveLength(1); expect(f.posts[0].body).toMatchObject({ documentId, orthoCaseId: caseId });
      expect(new URL(f.page.url()).pathname).toBe("/patients/" + patientId);
      f.assertIsolated(); expect(await storedState()).toEqual(before);
    } finally { await f.context.close(); }
  });
});
