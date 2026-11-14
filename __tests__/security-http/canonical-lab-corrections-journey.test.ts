/**
 * M2 slice 69 — canonical lab-order corrections, built application, owned database and
 * server. Synthetic data only.
 *
 * - complete_prescription / update_clinical / update_shade under clinical.visits.document;
 *   stale observed state refused; accounting and posting still refused.
 * - The board completes and dispatches a prescription, corrects the work type and sets a
 *   tooth shade with real clicks; only canonical requests; no request runs DDL.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { openCanonicalJourney, type CanonicalJourney } from "./_canonical-journey-harness";

const ARABIC = /[؀-ۿ]/;
const ACCOUNTS = {
  owner: { username: "canon-lx-owner", password: "Canon#LXOwner1", role: "admin", display: "المالك التجريبي" },
  documenter: { username: "canon-lx-doc", password: "Canon#LXDoc1", role: "reception", display: "موثّق المختبر", patientScope: "all",
    grants: { "clinical.lab.view": true, "clinical.visits.document": true } },
  orderOnly: { username: "canon-lx-order", password: "Canon#LXOrder1", role: "reception", display: "منسق", patientScope: "all",
    grants: { "clinical.lab.view": true, "clinical.lab.order": true } },
} as const;
type Key = keyof typeof ACCOUNTS;
let journey: CanonicalJourney<Key>;
const ids = { needed: 0, sent: 0, lab: 0 };
const patch = (body: unknown) => ({ method: "PATCH", body: JSON.stringify(body) });
const row = async (id: number) => (await journey.db.query("SELECT status, party_id, shade, tooth_numbers, work_type, shade_specification FROM lab_orders WHERE id=$1", [id])).rows[0];

beforeAll(async () => {
  journey = await openCanonicalJourney({
    portOffset: 112, secret: "canonical-lab-corrections-journey-secret-0123456789abcdef", accounts: ACCOUNTS, ownerKey: "owner",
    async seed(db) {
      const patient = (await db.query<{ id: number }>("INSERT INTO patients(patient_number,full_name,phone) VALUES ('SYN-LXJ-1','مريض تصحيح تجريبي','0500000830') RETURNING id")).rows[0].id;
      ids.lab = (await db.query<{ id: number }>("INSERT INTO parties(name,kind,currency) VALUES('مختبر الشفاء التجريبي','lab','YER') RETURNING id")).rows[0].id;
      const order = async (status: string, party: number | null, labName: string, work: string) => (await db.query<{ id: number }>(
        `INSERT INTO lab_orders(patient_id,party_id,lab_name,work_type,status,sent_date,due_date,exchange_rate,tooth_numbers,source)
         VALUES ($1,$2,$3,$4,$5,((NOW() AT TIME ZONE 'Asia/Aden')::date),((NOW() AT TIME ZONE 'Asia/Aden')::date + 7),1,'16','manual') RETURNING id`,
        [patient, party, labName, work, status])).rows[0].id;
      ids.needed = await order("needed", null, "لم يُحدَّد بعد", "تاج زيركون كامل");
      ids.sent = await order("sent", ids.lab, "مختبر الشفاء التجريبي", "تاج إيماكس");
    },
  });
}, 300_000);
afterAll(async () => { await journey?.close(); }, 60_000);

it("HTTP: the corrections need clinical.visits.document; stale state is refused; posting needs the finance grant", async () => {
  const orderOnly = await journey.login("orderOnly");
  const denied = await journey.api(`/api/lab/${ids.sent}`, orderOnly.cookie, patch({ action: "update_shade", shadeSpecification: null, expectedShadeSpecification: null }));
  expect(denied.status).toBe(403);
  expect((await denied.json()).message).toMatch(ARABIC);
  const documenter = await journey.login("documenter");
  const stale = await journey.api(`/api/lab/${ids.needed}`, documenter.cookie, patch({ action: "complete_prescription", expected: "[\"old\"]", dispatch: false,
    prescription: { partyId: ids.lab, shade: "A2", stumpShade: "", toothNumbers: "16(Crown)", dueDate: "2031-05-01", impressionType: "physical", priority: "normal" } }));
  expect(stale.status).toBe(409);
  expect((await stale.json()).message).toMatch(ARABIC);
  const accounting = await journey.api(`/api/lab/${ids.sent}`, documenter.cookie, patch({ action: "post" }));
  // Slice 71: posting needs finance.payables.record, which the documenter lacks.
  expect(accounting.status).toBe(403);
  expect(await row(ids.needed)).toMatchObject({ status: "needed", party_id: null });
  expect(await journey.ddlLog()).toEqual([]);
});

it("browser: complete and dispatch a prescription, correct the work type, set a tooth shade — canonical requests only", async () => {
  const context = await journey.browser.newContext({ viewport: { width: 390, height: 844 }, locale: "ar", timezoneId: "Asia/Aden" });
  const page = await context.newPage();
  const apiCalls: string[] = [];
  page.on("request", request => { const path = new URL(request.url()).pathname; if (path.startsWith("/api/")) apiCalls.push(`${request.method()} ${path}`); });
  await journey.browserLogin(page, "documenter");
  await page.goto(`${journey.baseUrl}/lab`);
  const board = page.getByTestId("canonical-lab-board");

  await board.getByRole("button", { name: /لم تُرسل بعد/ }).click();
  const needed = board.locator(`[data-order="${ids.needed}"]`);
  await needed.locator('[data-correction="prescription"]').click();
  const form = needed.getByTestId("lab-prescription-form");
  await form.getByTestId("rx-party").selectOption(String(ids.lab));
  await form.getByTestId("rx-shade").selectOption("A2");
  await form.getByTestId("rx-dispatch").click();
  await expect.poll(async () => (await row(ids.needed)).status).toBe("sent");
  expect(await row(ids.needed)).toMatchObject({ party_id: ids.lab, shade: "A2", tooth_numbers: "16(Crown)" });

  await board.getByRole("button", { name: /عند المختبر/ }).click();
  const sent = board.locator(`[data-order="${ids.sent}"]`);
  await sent.locator('[data-correction="clinical"]').click();
  await sent.getByTestId("fix-work").selectOption("عدسة فينير");
  await sent.getByTestId("fix-save").click();
  await expect.poll(async () => (await row(ids.sent)).work_type).toBe("عدسة فينير");

  await board.getByRole("button", { name: /عند المختبر/ }).click();
  await sent.locator('[data-correction="shade"]').click();
  await sent.locator('[data-shade-tooth="16"]').selectOption("B1");
  await sent.getByTestId("shade-save").click();
  await expect.poll(async () => JSON.stringify((await row(ids.sent)).shade_specification)).toContain("B1");
  expect((await journey.db.query("SELECT action, actor FROM audit_log WHERE action IN ('lab_order.prescription_updated','lab_order.clinical','lab_order.shade') ORDER BY id")).rows)
    .toEqual([{ action: "lab_order.prescription_updated", actor: "canon-lx-doc" }, { action: "lab_order.clinical", actor: "canon-lx-doc" }, { action: "lab_order.shade", actor: "canon-lx-doc" }]);

  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await context.close();
  expect(apiCalls.filter(call => !/^(GET|POST) \/api\/auth\/(login|me)$/.test(call) && !/^(GET \/api\/lab(\/backlog)?|PATCH \/api\/lab\/\d+)$/.test(call))).toEqual([]);
  expect(await journey.ddlLog()).toEqual([]);
});
