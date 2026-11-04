import { afterAll, beforeAll, expect, it } from "vitest";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { seedCanonicalPlanTemplateCatalog, SYNTHETIC_PLAN_TEMPLATES } from "../fixtures/canonical-plan-template-catalog";
import { openCanonicalJourney, type CanonicalJourney } from "./_canonical-journey-harness";
const ACCOUNTS = {
  owner: { username: "canon-pt-owner", password: "Canon#TemplateOwner1", role: "admin", display: "مالك تجريبي" },
  reader: { username: "canon-pt-reader", password: "Canon#TemplateReader1", role: "reception", display: "قارئ قوالب تجريبي", patientScope: "none", grants: { "clinical.plans.view": true } },
  clinical: { username: "canon-pt-clinical", password: "Canon#TemplateClinical1", role: "doctor", doctor: true, display: "طبيب قوالب تجريبي", patientScope: "own", grants: { "clinical.plans.view": true } },
  prices: { username: "canon-pt-prices", password: "Canon#TemplatePrices1", role: "reception", display: "قارئ أسعار تجريبي", patientScope: "all", grants: { "clinical.plans.view": true, "finance.service-prices.view": true } },
  denied: { username: "canon-pt-denied", password: "Canon#TemplateDenied1", role: "admin", display: "مدير بلا قوالب", patientScope: "all", grants: { "clinical.xrays.view": true, "finance.service-prices.view": true } },
} as const;
let journey: CanonicalJourney<keyof typeof ACCOUNTS>;
let ids: Awaited<ReturnType<typeof seedCanonicalPlanTemplateCatalog>>, patient = 0;
beforeAll(async () => { journey = await openCanonicalJourney({ portOffset: 54, secret: "canonical-template-catalog-secret-0123456789", accounts: ACCOUNTS, ownerKey: "owner", async seed(q, _users, parties) {
  ids = await seedCanonicalPlanTemplateCatalog(q);
  patient = (await q.query("INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES('SYN-PT-PATIENT','SYN template patient',$1) RETURNING id", [parties.clinical])).rows[0].id;
} }); }, 300_000);
afterAll(async () => { await journey?.close(); }, 60_000);
it("HTTP: the non-patient plan-template catalogue admits its clinical grant without granting patient or price access", async () => {
  const session = await journey.login("reader"); expect(session.status).toBe(200);
  const response = await journey.api("/api/plan-templates", session.cookie); expect(response.status).toBe(200);
  const body = await response.json(); expect(body).toMatchObject({ projection: "plan-template-catalog", pricesVisible: false });
  expect(body.templates.length).toBeGreaterThan(0); expect((await journey.api("/api/patients", session.cookie)).status).toBe(403);
  expect(await journey.ddlLog()).toEqual([]);
});
it("HTTP: anonymous and adjacent grants fail; query parameters cannot request prices or hidden services", async () => {
  expect((await journey.api("/api/plan-templates", "")).status).toBe(401);
  expect((await journey.api("/api/plan-templates", (await journey.login("denied")).cookie)).status).toBe(403);
  const session = await journey.login("reader");
  for (const query of ["showPrices=true", "includeInactive=true", "scope=all", "setting=SYN.private.setting"]) expect((await journey.api(`/api/plan-templates?${query}`, session.cookie)).status).toBe(400);
});
it("HTTP: only the independent price grant changes the explicit catalogue projection", async () => {
  for (const key of ["reader", "clinical", "prices", "owner"] as const) {
    const response = await journey.api("/api/plan-templates", (await journey.login(key)).cookie), body = await response.json(); expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toContain("no-store");
    expect(Object.keys(body).sort()).toEqual(["pricesVisible", "projection", "services", "source", "templates"]); expect(body.templates).toEqual(SYNTHETIC_PLAN_TEMPLATES); expect(body.services).toHaveLength(1);
    if (key === "prices" || key === "owner") expect(body.services[0].price).toEqual({ currency: "YER", minor: 9900123, configured: true, provisional: true });
    else { expect(body.pricesVisible).toBe(false); expect(body.services[0]).not.toHaveProperty("price"); expect(JSON.stringify(body)).not.toContain("9900123"); }
    expect(JSON.stringify(body)).not.toMatch(/8800123|7700123|6600123|SYN private|inactive|canEdit|patientId/);
  }
  expect(await journey.ddlLog()).toEqual([]);
});
it("HTTP: unsafe granted prices fail generically while hidden prices do not affect the clinical reader", async () => {
  await journey.db.query("UPDATE services SET price_minor=9007199254740993 WHERE id=$1", [ids.service]);
  try {
    const response = await journey.api("/api/plan-templates", (await journey.login("prices")).cookie); expect(response.status).toBe(409);
    const body = await response.json(); expect(body.code).toBe("plan_template_price_invalid"); expect(body.message).toMatch(/[؀-ۿ]/); expect(JSON.stringify(body)).not.toMatch(/9007199254740993|SELECT|price_minor/);
    expect((await journey.api("/api/plan-templates", (await journey.login("reader")).cookie)).status).toBe(200);
  } finally { await journey.db.query("UPDATE services SET price_minor=9900123 WHERE id=$1", [ids.service]); }
});
async function openCatalog(page: import("playwright").Page, key: keyof typeof ACCOUNTS = "clinical") {
  await journey.browserLogin(page, key); await page.goto(`${journey.baseUrl}/patients/${patient}`);
  await page.getByRole("button", { name: "عرض الخطط السريرية", exact: true }).click();
  await page.getByRole("button", { name: "عرض دليل القوالب والخدمات", exact: true }).click();
  const panel = page.getByTestId("canonical-plan-template-catalog"); await panel.getByTestId("canonical-template-service").getByText("خدمة اصطناعية", { exact: true }).waitFor(); return panel;
}
it("browser: read-only templates and active clinical services fit 390px without prices or writer requests", async () => {
  const context = await journey.browser.newContext({ viewport: { width: 390, height: 844 }, locale: "ar" });
  try {
    const page = await context.newPage(), calls: string[] = []; page.on("request", request => { if (new URL(request.url()).pathname === "/api/plan-templates") calls.push(request.method()); });
    const panel = await openCatalog(page); await panel.locator("summary").click(); await panel.getByText("جلسة اصطناعية ثانية", { exact: false }).waitFor();
    expect(await panel.getByTestId("canonical-template-service-price").count()).toBe(0); expect(await panel.textContent()).not.toMatch(/9900123|inactive|SYN private/);
    expect(await panel.locator("input,textarea,select,a").count()).toBe(0); expect(calls).toEqual(["GET"]); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    if (process.env.HR_EVIDENCE_DIR) { mkdirSync(process.env.HR_EVIDENCE_DIR, { recursive: true }); await page.screenshot({ path: join(process.env.HR_EVIDENCE_DIR, "plan-template-catalog-390.png"), fullPage: true }); }
  } finally { await context.close(); }
});
it("browser: malformed saved settings disclose the existing ready-template fallback without echoing the raw setting", async () => {
  await journey.db.query("UPDATE settings SET value='SYN private corrupt JSON' WHERE key='plans.specialty_templates'");
  const context = await journey.browser.newContext();
  try { const page = await context.newPage(), panel = await openCatalog(page); await panel.getByText("القيمة المحفوظة في الإعدادات غير صالحة", { exact: false }).waitFor(); expect(await panel.getByTestId("canonical-plan-template").count()).toBeGreaterThan(1); expect(await panel.textContent()).not.toContain("SYN private corrupt"); }
  finally { await context.close(); await journey.db.query("UPDATE settings SET value=$1 WHERE key='plans.specialty_templates'", [JSON.stringify(SYNTHETIC_PLAN_TEMPLATES)]); }
});
it("browser: failed refresh clears old catalogue details without claiming no services", async () => {
  const context = await journey.browser.newContext();
  try { const page = await context.newPage(), panel = await openCatalog(page); await page.route("**/api/plan-templates", route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "تعذّر التحديث التجريبي" }) })); await panel.getByRole("button", { name: "تحديث دليل القوالب" }).click(); await panel.getByRole("alert").waitFor(); expect(await panel.getByTestId("canonical-template-service").count()).toBe(0); expect(await panel.getByTestId("canonical-plan-template").count()).toBe(0); }
  finally { await context.close(); }
});
it("browser and HTTP: price withdrawal clears old prices; a fresh session retains the clinical catalogue only", async () => {
  const context = await journey.browser.newContext(), original = (await journey.db.query("SELECT permissions FROM users WHERE id=$1", [journey.ids.prices])).rows[0].permissions;
  try {
    const stale = await journey.login("prices"), page = await context.newPage(), panel = await openCatalog(page, "prices"); expect(await panel.getByTestId("canonical-template-service-price").count()).toBe(1);
    await journey.db.query("UPDATE users SET permissions=jsonb_set(jsonb_set(permissions::jsonb,'{revision}','2'),'{grants,finance.service-prices.view}','false')::text WHERE id=$1", [journey.ids.prices]);
    await panel.getByRole("button", { name: "تحديث دليل القوالب" }).click(); await panel.getByRole("alert").waitFor(); expect(await panel.getByTestId("canonical-template-service-price").count()).toBe(0);
    expect([401, 403]).toContain((await journey.api("/api/plan-templates", stale.cookie)).status);
    const fresh = await openCatalog(page, "prices"); expect(await fresh.getByTestId("canonical-template-service-price").count()).toBe(0); expect(await fresh.getByTestId("canonical-template-service").count()).toBe(1);
  } finally { await context.close(); await journey.db.query("UPDATE users SET permissions=$1 WHERE id=$2", [original, journey.ids.prices]); }
});
it("browser: a late retired request cannot restore a closed or failed catalogue", async () => {
  const context = await journey.browser.newContext(); let release: (() => void) | undefined;
  try {
    const page = await context.newPage(), panel = await openCatalog(page), payload = await (await journey.api("/api/plan-templates", (await journey.login("clinical")).cookie)).json();
    const held = new Promise<void>(resolve => { release = resolve; }); let markEntered: (() => void) | undefined; const entered = new Promise<void>(resolve => { markEntered = resolve; }); let first = true;
    await page.route("**/api/plan-templates", async route => { if (first) { first = false; markEntered!(); await held; await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) }).catch(() => undefined); } else await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "فشل التحديث الأحدث" }) }); });
    await panel.getByRole("button", { name: "تحديث دليل القوالب" }).click(); await entered; await panel.getByRole("button", { name: "تحديث دليل القوالب" }).click(); await panel.getByRole("alert").waitFor(); release!(); await page.waitForTimeout(200); expect(await panel.getByTestId("canonical-template-service").count()).toBe(0);
  } finally { release?.(); await context.close(); }
});
