/**
 * M2 slice 84 — the canonical visit cockpit read, built application, owned database and
 * server. Synthetic data only.
 *
 * HTTP: a clinician without the invoice view reads the visit with its work and no money
 * (no-store); a holder of finance.invoices.view reads the prices; a visit outside the
 * clinician's scope is 404 (Arabic); an account without a clinical grant is refused; the
 * lab receipt read answers not found for an unknown key and refuses without
 * clinical.lab.order. Browser at 390px: the clinician sees the procedure and no price,
 * the biller sees the price; no 4xx/5xx on the page. No DDL.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { openCanonicalJourney, type CanonicalJourney } from "./_canonical-journey-harness";

const ARABIC = /[؀-ۿ]/;
const PRICE = 43219;
const ACCOUNTS = {
  owner: { username: "canon-vc-owner", password: "Canon#VcOwner1", role: "admin", display: "المالك التجريبي" },
  doctor: { username: "canon-vc-dr", password: "Canon#VcDoctor1", role: "doctor", display: "الطبيب", doctor: true, patientScope: "own",
    grants: { "clinical.visits.document": true, "clinical.lab.view": true, "clinical.lab.order": true } },
  biller: { username: "canon-vc-bill", password: "Canon#VcBill1", role: "reception", display: "الفوترة", patientScope: "all",
    grants: { "clinical.visits.document": true, "finance.invoices.view": true } },
  front: { username: "canon-vc-front", password: "Canon#VcFront1", role: "reception", display: "الاستقبال", patientScope: "all",
    grants: { "appointments.create": true } },
} as const;
type Key = keyof typeof ACCOUNTS;
let journey: CanonicalJourney<Key>;
const ids = { mine: 0, other: 0, visit: 0, otherVisit: 0 };

beforeAll(async () => {
  journey = await openCanonicalJourney({
    portOffset: 142, secret: "canonical-visit-clinical-journey-secret-0123456789", accounts: ACCOUNTS, ownerKey: "owner",
    async seed(db, _ids, parties) {
      const patient = async (number: string, name: string, doctor: number | null) =>
        (await db.query<{ id: number }>("INSERT INTO patients(patient_number,full_name,phone,primary_doctor_id) VALUES ($1,$2,NULL,$3) RETURNING id", [number, name, doctor])).rows[0].id;
      ids.mine = await patient("SYN-VCJ-1", "مريض الزيارة التجريبي", parties.doctor ?? null);
      ids.other = await patient("SYN-VCJ-2", "مريض آخر تجريبي", null);
      const service = (await db.query<{ id: number }>("INSERT INTO services(name,price_minor,is_active,price_configured,category) VALUES('حشوة تجريبية',$1,TRUE,TRUE,'restorative') RETURNING id", [PRICE])).rows[0].id;
      ids.visit = (await db.query<{ id: number }>("INSERT INTO visits (patient_name, patient_id, doctor_id, chief_complaint) VALUES ('مريض الزيارة التجريبي',$1,$2,'ألم في الضرس') RETURNING id", [ids.mine, parties.doctor ?? null])).rows[0].id;
      await db.query("INSERT INTO visit_procedures (visit_id, service_id, quantity, unit_price_minor, tooth_code) VALUES ($1,$2,1,$3,16)", [ids.visit, service, PRICE]);
      ids.otherVisit = (await db.query<{ id: number }>("INSERT INTO visits (patient_name, patient_id) VALUES ('مريض آخر تجريبي',$1) RETURNING id", [ids.other])).rows[0].id;
    },
  });
}, 300_000);
afterAll(async () => { await journey?.close(); }, 60_000);

it("HTTP: the work without its price, the price by the invoice view, the scope and the receipt read", async () => {
  const doctor = await journey.login("doctor");
  const read = await journey.api(`/api/visits/${ids.visit}/clinical`, doctor.cookie);
  expect(read.status).toBe(200);
  expect(read.headers.get("cache-control")).toContain("no-store");
  const body = await read.json();
  expect(body).toMatchObject({ id: ids.visit, patientId: ids.mine, chiefComplaint: "ألم في الضرس", procedures: [{ serviceName: "حشوة تجريبية", toothCode: 16 }] });
  expect(JSON.stringify(body)).not.toMatch(/unitPriceMinor|totalMinor|invoiceId|billingCurrency|sessionPricing|labSignVersion|43219/);

  const biller = await journey.login("biller");
  const billed = await journey.api(`/api/visits/${ids.visit}/clinical`, biller.cookie);
  expect(billed.status).toBe(200);
  expect(await billed.json()).toMatchObject({ totalMinor: PRICE, procedures: [{ unitPriceMinor: PRICE, totalMinor: PRICE }] });

  const outside = await journey.api(`/api/visits/${ids.otherVisit}/clinical`, doctor.cookie);
  expect(outside.status).toBe(404);
  expect((await outside.json()).message).toMatch(ARABIC);
  const front = await journey.login("front");
  const refused = await journey.api(`/api/visits/${ids.visit}/clinical`, front.cookie);
  expect(refused.status).toBe(403);
  expect((await refused.json()).message).toMatch(ARABIC);

  const receipt = (cookie: string) => journey.api(`/api/visits/${ids.visit}/lab-work-command?key=journey-receipt-0001&hash=${"d".repeat(64)}`, cookie);
  const absent = await receipt(doctor.cookie);
  expect(absent.status).toBe(200);
  expect(await absent.json()).toEqual({ found: false });
  const noLab = await receipt(biller.cookie);
  expect(noLab.status).toBe(403);
  expect((await noLab.json()).message).toMatch(ARABIC);
  expect(await journey.ddlLog()).toEqual([]);
});

it("browser: the clinician sees the work and no price; the biller sees the price (390px)", async () => {
  for (const [key, priced] of [["doctor", false], ["biller", true]] as const) {
    const context = await journey.browser.newContext({ viewport: { width: 390, height: 844 }, locale: "ar", timezoneId: "Asia/Aden" });
    const page = await context.newPage();
    await journey.browserLogin(page, key);
    const failures: string[] = [];
    page.on("response", response => { const path = new URL(response.url()).pathname; if (path.startsWith("/api/") && response.status() >= 400) failures.push(`${response.status()} ${path}`); });
    await page.goto(`${journey.baseUrl}/visits/${ids.visit}`);
    const procedures = page.getByTestId("canonical-visit-procedures");
    await procedures.getByText("حشوة تجريبية — سن 16").waitFor();
    await page.getByTestId("canonical-visit-notes").getByText("ألم في الضرس").waitFor();
    expect(await page.getByTestId("canonical-visit-line-price").count()).toBe(priced ? 1 : 0);
    expect(await page.getByTestId("canonical-visit-total").count()).toBe(priced ? 1 : 0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    expect(failures).toEqual([]);
    await context.close();
  }
  expect(await journey.ddlLog()).toEqual([]);
});
