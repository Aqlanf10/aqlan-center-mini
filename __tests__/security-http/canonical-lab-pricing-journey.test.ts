/**
 * M2 slice 70b — lab cost prices (owner decision 2026-11-03: only with
 * finance.cost-prices.view), built application, owned database and server. Synthetic data.
 *
 * - Direct API access: clinical.lab.view alone is refused for the list and for resolve;
 *   an editor without the cost capability writes but never receives an amount back.
 * - /settings/lab-pricing: without the capability the page never requests prices; with
 *   it the table shows them. No request runs DDL.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { openCanonicalJourney, type CanonicalJourney } from "./_canonical-journey-harness";

const ARABIC = /[؀-ۿ]/;
const VIEW = { "clinical.lab.view": true } as const;
const ACCOUNTS = {
  owner: { username: "canon-lpj-owner", password: "Canon#LPJOwner1", role: "admin", display: "المالك التجريبي" },
  labViewer: { username: "canon-lpj-lab", password: "Canon#LPJLab1", role: "reception", display: "منسق المختبر", grants: { ...VIEW } },
  editor: { username: "canon-lpj-edit", password: "Canon#LPJEdit1", role: "reception", display: "محرر الأسعار", grants: { ...VIEW, "finance.lab-prices.edit": true } },
  costViewer: { username: "canon-lpj-cost", password: "Canon#LPJCost1", role: "accountant", display: "المحاسب", grants: { ...VIEW, "finance.cost-prices.view": true } },
} as const;
type Key = keyof typeof ACCOUNTS;
let journey: CanonicalJourney<Key>;
const ctx = { lab: 0, service: 0 };

beforeAll(async () => {
  journey = await openCanonicalJourney({
    portOffset: 116, secret: "canonical-lab-pricing-journey-secret-0123456789abcdef", accounts: ACCOUNTS, ownerKey: "owner",
    async seed(db) {
      ctx.lab = (await db.query<{ id: number }>("INSERT INTO parties(name,kind,currency) VALUES('مختبر السعر التجريبي','lab','YER') RETURNING id")).rows[0].id;
      ctx.service = (await db.query<{ id: number }>("INSERT INTO lab_services(name,code,category,tooth_scope) VALUES('تاج تسعير تجريبي','SYN-LPJ-CROWN','prostho','single_tooth') RETURNING id")).rows[0].id;
      await db.query("INSERT INTO lab_pricing_rules(party_id,lab_service_id,cost_minor,cost_currency,effective_from,created_by) VALUES($1,$2,4567800,'YER','2026-01-01','synthetic')", [ctx.lab, ctx.service]);
    },
  });
}, 300_000);
afterAll(async () => { await journey?.close(); }, 60_000);

it("HTTP: prices only with finance.cost-prices.view — list, resolve and write responses alike", async () => {
  const viewer = await journey.login("labViewer");
  for (const path of ["/api/lab/pricing", `/api/lab/pricing?resolve=1&partyId=${ctx.lab}&labServiceId=${ctx.service}`]) {
    const refused = await journey.api(path, viewer.cookie);
    expect(refused.status).toBe(403);
    const text = await refused.text();
    expect(text).toMatch(ARABIC);
    expect(text).not.toContain("4567800");
  }
  const editor = await journey.login("editor");
  expect((await journey.api("/api/lab/pricing", editor.cookie)).status).toBe(403);
  const created = await journey.api("/api/lab/pricing", editor.cookie, { method: "POST", body: JSON.stringify({ partyId: ctx.lab, labServiceId: ctx.service, costMinor: 1234500, effectiveFrom: "2031-01-01" }) });
  expect(created.status).toBe(201);
  const createdText = await created.text();
  expect(createdText).not.toMatch(/1234500|costMinor/);
  const ruleId = JSON.parse(createdText).rule.id as number;
  const updated = await journey.api(`/api/lab/pricing/${ruleId}`, editor.cookie, { method: "PUT", body: JSON.stringify({ note: "ملاحظة" }) });
  expect([updated.status, (await updated.text()).includes("1234500")]).toEqual([200, false]);
  const cost = await journey.login("costViewer");
  const rules = await (await journey.api(`/api/lab/pricing?partyId=${ctx.lab}`, cost.cookie)).json();
  expect(rules.rules.map((rule: { costMinor: number }) => rule.costMinor).sort()).toEqual([1234500, 4567800]);
  expect((await journey.api("/api/lab/pricing", cost.cookie, { method: "POST", body: JSON.stringify({ partyId: ctx.lab, labServiceId: ctx.service, costMinor: 1 }) })).status).toBe(403);
  expect(await journey.ddlLog()).toEqual([]);
});

it("browser: the pricing page never requests prices without the capability; with it the table shows them", async () => {
  const context = await journey.browser.newContext({ viewport: { width: 390, height: 844 }, locale: "ar", timezoneId: "Asia/Aden" });
  const page = await context.newPage();
  const apiCalls: string[] = [];
  page.on("request", request => { const path = new URL(request.url()).pathname; if (path.startsWith("/api/")) apiCalls.push(`${request.method()} ${path}`); });
  await journey.browserLogin(page, "editor");
  await page.goto(`${journey.baseUrl}/settings/lab-pricing`);
  const root = page.getByTestId("canonical-lab-pricing");
  await root.getByTestId("pricing-hidden").waitFor();
  await root.getByTestId("pricing-form").waitFor();
  expect(await root.textContent()).not.toMatch(/45,?678|4567800/);
  expect(apiCalls.filter(call => call.startsWith("GET /api/lab/pricing"))).toEqual([]);
  await context.close();

  const costContext = await journey.browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "ar", timezoneId: "Asia/Aden" });
  const costPage = await costContext.newPage();
  await journey.browserLogin(costPage, "costViewer");
  await costPage.goto(`${journey.baseUrl}/settings/lab-pricing`);
  const list = costPage.getByTestId("canonical-lab-pricing").getByTestId("pricing-list");
  await list.waitFor();
  expect(await list.textContent()).toContain("مختبر السعر التجريبي");
  expect(await costPage.getByTestId("pricing-form").count()).toBe(0);
  await costContext.close();
  expect(await journey.ddlLog()).toEqual([]);
});
