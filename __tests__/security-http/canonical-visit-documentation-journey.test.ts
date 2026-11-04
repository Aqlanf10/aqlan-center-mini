/**
 * M2 slice 85 — canonical visit documentation, built application, owned database and
 * server. Synthetic data only.
 *
 * HTTP: the clinician saves notes (no money in the response, no-store); an account
 * without a clinician link is refused on an older visit (403, Arabic); signing, a
 * currency change and a lab draft are refused (409, Arabic) and nothing is signed; a
 * discount without the grant is refused (409). Browser at 390px: the clinician edits the
 * diagnosis, adds a planned item from the remaining work, saves it without seeing a
 * price, then adds an addendum to a signed visit. No DDL.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { openCanonicalJourney, type CanonicalJourney } from "./_canonical-journey-harness";

const ARABIC = /[؀-ۿ]/;
const PRICE = 43219;
const ACCOUNTS = {
  owner: { username: "canon-vd-owner", password: "Canon#VdOwner1", role: "admin", display: "المالك التجريبي" },
  doctor: { username: "canon-vd-dr", password: "Canon#VdDoctor1", role: "doctor", display: "الطبيب", doctor: true, patientScope: "own",
    grants: { "clinical.visits.document": true } },
  assistant: { username: "canon-vd-asst", password: "Canon#VdAsst1", role: "assistant", display: "المساعد", patientScope: "all",
    grants: { "clinical.visits.document": true } },
} as const;
type Key = keyof typeof ACCOUNTS;
let journey: CanonicalJourney<Key>;
const ids = { mine: 0, today: 0, old: 0, signed: 0, service: 0, item: 0 };

beforeAll(async () => {
  journey = await openCanonicalJourney({
    portOffset: 144, secret: "canonical-visit-documentation-journey-secret-012345", accounts: ACCOUNTS, ownerKey: "owner",
    async seed(db, _ids, parties) {
      const doctor = parties.doctor ?? null;
      ids.mine = (await db.query<{ id: number }>("INSERT INTO patients(patient_number,full_name,phone,primary_doctor_id) VALUES ('SYN-VDJ-1','مريض التوثيق التجريبي',NULL,$1) RETURNING id", [doctor])).rows[0].id;
      ids.service = (await db.query<{ id: number }>("INSERT INTO services(name,price_minor,is_active,price_configured,category) VALUES('حشوة توثيق تجريبية',$1,TRUE,TRUE,'restorative') RETURNING id", [PRICE])).rows[0].id;
      const plan = (await db.query<{ id: number }>("INSERT INTO treatment_plans (patient_id, title, total_minor, status) VALUES ($1,'خطة التوثيق',$2,'active') RETURNING id", [ids.mine, PRICE])).rows[0].id;
      ids.item = (await db.query<{ id: number }>("INSERT INTO plan_items(plan_id,service_id,service_name,quantity,unit_price_minor,tooth_code,status) VALUES($1,$2,'حشوة توثيق تجريبية',1,$3,26,'planned') RETURNING id", [plan, ids.service, PRICE])).rows[0].id;
      const visit = async (when: string | null) => (await db.query<{ id: number }>(
        `INSERT INTO visits (patient_name, patient_id, doctor_id${when ? ", arrived_at" : ""}) VALUES ('مريض التوثيق التجريبي',$1,$2${when ? `, ${when}` : ""}) RETURNING id`, [ids.mine, doctor])).rows[0].id;
      ids.today = await visit(null);
      ids.old = await visit("now() - interval '3 days'");
      ids.signed = await visit(null);
      await db.query("UPDATE visits SET signed_at = now(), signed_by = 'SYN' WHERE id = $1", [ids.signed]);
    },
  });
}, 300_000);
afterAll(async () => { await journey?.close(); }, 60_000);

const post = (visitId: number, cookie: string, body: Record<string, unknown>) =>
  journey.api(`/api/visits/${visitId}/clinical`, cookie, { method: "POST", body: JSON.stringify(body) });

it("HTTP: save, the actor rule, and the refusals that never guess", async () => {
  const doctor = await journey.login("doctor");
  const saved = await post(ids.today, doctor.cookie, { action: "save", diagnosis: "تسوس اصطناعي", doctorId: journey.parties.doctor });
  expect(saved.status).toBe(200);
  expect(saved.headers.get("cache-control")).toContain("no-store");
  const body = await saved.json();
  expect(body).toMatchObject({ id: ids.today, diagnosis: "تسوس اصطناعي" });
  expect(JSON.stringify(body)).not.toMatch(/unitPriceMinor|totalMinor|43219/);

  const assistant = await journey.login("assistant");
  const old = await post(ids.old, assistant.cookie, { action: "save", nextPlan: "x" });
  expect(old.status).toBe(403);
  expect((await old.json()).message).toMatch(ARABIC);

  for (const refused of [{ action: "sign" }, { action: "save", billingCurrency: "USD" }, { action: "save", labRequestKey: "journey-lab-key-0001", procedures: [] }]) {
    const response = await post(ids.today, doctor.cookie, refused);
    expect(response.status).toBe(409);
    expect((await response.json()).message).toMatch(ARABIC);
  }
  const discount = await post(ids.today, doctor.cookie, { action: "save", doctorId: journey.parties.doctor,
    procedures: [{ serviceId: ids.service, toothCode: 11, unitPriceMinor: 100, priceReason: "خصم بلا صلاحية", doctorId: journey.parties.doctor }] });
  expect(discount.status).toBe(409);
  expect((await discount.json()).message).toMatch(ARABIC);
  expect((await journey.db.query("SELECT signed_at FROM visits WHERE id=$1", [ids.today])).rows[0].signed_at).toBeNull();
  expect((await journey.db.query("SELECT count(*)::int AS n FROM visit_procedures WHERE visit_id=$1", [ids.today])).rows[0].n).toBe(0);
  expect(await journey.ddlLog()).toEqual([]);
});

it("browser: the clinician documents, adds planned work without a price, and adds an addendum (390px)", async () => {
  const context = await journey.browser.newContext({ viewport: { width: 390, height: 844 }, locale: "ar", timezoneId: "Asia/Aden" });
  const page = await context.newPage();
  await journey.browserLogin(page, "doctor");
  const failures: string[] = [];
  page.on("response", response => { const path = new URL(response.url()).pathname; if (path.startsWith("/api/") && response.status() >= 400) failures.push(`${response.status()} ${path}`); });
  await page.goto(`${journey.baseUrl}/visits/${ids.today}`);
  const notes = page.getByTestId("canonical-visit-notes");
  await notes.getByLabel("التشخيص").fill("تسوس عميق اصطناعي");
  await notes.getByRole("button", { name: "حفظ التوثيق" }).click();
  await page.getByTestId("canonical-visit-notice").getByText("حُفظ التوثيق.").waitFor();
  await page.getByTestId("canonical-visit-outstanding").getByRole("button", { name: "إضافة لهذه الزيارة" }).click();
  await page.getByTestId("canonical-visit-procedures").getByRole("button", { name: "حفظ الإجراءات" }).click();
  await page.getByTestId("canonical-visit-notice").getByText("حُفظت الإجراءات والتوثيق.").waitFor();
  expect(await page.getByTestId("canonical-visit-line-price").count()).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  expect((await journey.db.query("SELECT diagnosis FROM visits WHERE id=$1", [ids.today])).rows[0].diagnosis).toBe("تسوس عميق اصطناعي");
  expect((await journey.db.query("SELECT plan_item_id, unit_price_minor::int AS price FROM visit_procedures WHERE visit_id=$1", [ids.today])).rows)
    .toEqual([{ plan_item_id: ids.item, price: PRICE }]);

  await page.goto(`${journey.baseUrl}/visits/${ids.signed}`);
  await page.getByLabel("ملحق على الزيارة الموقَّعة").fill("ملحق من المتصفح");
  await page.getByRole("button", { name: "إضافة الملحق" }).click();
  await page.getByTestId("canonical-visit-addendum").getByText("ملحق من المتصفح", { exact: false }).waitFor();
  expect(failures).toEqual([]);
  expect((await journey.db.query("SELECT actor FROM audit_log WHERE action='visit.addendum' AND entity_id=$1::text", [ids.signed])).rows.map(row => row.actor)).toEqual(["canon-vd-dr"]);
  await context.close();
  expect(await journey.ddlLog()).toEqual([]);
});
