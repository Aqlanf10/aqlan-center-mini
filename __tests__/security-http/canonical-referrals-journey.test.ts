/**
 * M2 slice 73 — canonical referrals, built application, owned database and server.
 * Synthetic data only.
 *
 * - HTTP: issue needs clinical.referrals.manage and a clinician link; the wrong side of a
 *   workflow step is refused with an Arabic message; a referral outside the scope is 404.
 * - Browser: the referring doctor issues an internal referral from the canonical patient
 *   file; the receiving doctor sees it in «عملي السريري» and accepts it from the file;
 *   no request runs DDL.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { openCanonicalJourney, type CanonicalJourney } from "./_canonical-journey-harness";

const ARABIC = /[؀-ۿ]/;
const GRANTS = { "clinical.referrals.manage": true, "clinical.plans.view": true } as const;
const ACCOUNTS = {
  owner: { username: "canon-ref-owner", password: "Canon#RefOwner1", role: "admin", display: "المالك التجريبي" },
  referrer: { username: "canon-ref-a", password: "Canon#RefA1", role: "doctor", display: "د. محيل تجريبي", doctor: true, patientScope: "own", appointmentScope: "own", grants: GRANTS },
  receiver: { username: "canon-ref-b", password: "Canon#RefB1", role: "doctor", display: "د. مستقبل تجريبي", doctor: true, patientScope: "own", appointmentScope: "own", grants: GRANTS },
  desk: { username: "canon-ref-desk", password: "Canon#RefDesk1", role: "reception", display: "استقبال", patientScope: "all", appointmentScope: "all", grants: GRANTS },
} as const;
type Key = keyof typeof ACCOUNTS;
let journey: CanonicalJourney<Key>;
const ids = { patient: 0, other: 0, receiverParty: 0 };
const post = (body: unknown) => ({ method: "POST", body: JSON.stringify(body) });

beforeAll(async () => {
  journey = await openCanonicalJourney({
    portOffset: 122, secret: "canonical-referrals-journey-secret-0123456789abcdef", accounts: ACCOUNTS, ownerKey: "owner",
    async seed(db, _ids, parties) {
      ids.receiverParty = parties.receiver!;
      ids.patient = (await db.query<{ id: number }>("INSERT INTO patients(patient_number,full_name,phone,primary_doctor_id) VALUES ('SYN-RJ-1','مريض الإحالة التجريبي','0500000981',$1) RETURNING id", [parties.referrer!])).rows[0].id;
      ids.other = (await db.query<{ id: number }>("INSERT INTO patients(patient_number,full_name,phone) VALUES ('SYN-RJ-2','مريض بعيد','0500000982') RETURNING id")).rows[0].id;
    },
  });
}, 300_000);
afterAll(async () => { await journey?.close(); }, 60_000);

it("HTTP: issuer link, scope and the workflow sides", async () => {
  const desk = await journey.login("desk");
  const noLink = await journey.api(`/api/patients/${ids.patient}/referrals`, desk.cookie,
    post({ requestKey: "journey-referral-key-desk-01", kind: "internal", toPartyId: ids.receiverParty, toSpecialty: "endodontics", reason: "سبب", urgency: "routine" }));
  expect(noLink.status).toBe(403);
  expect((await noLink.json()).message).toMatch(ARABIC);
  const referrer = await journey.login("referrer");
  const outside = await journey.api(`/api/patients/${ids.other}/referrals`, referrer.cookie,
    post({ requestKey: "journey-referral-key-out-001", toName: "جهة", toSpecialty: "other", reason: "سبب", urgency: "routine" }));
  expect(outside.status).toBe(404);
  const created = await journey.api(`/api/patients/${ids.patient}/referrals`, referrer.cookie,
    post({ requestKey: "journey-referral-key-http-01", kind: "internal", toPartyId: ids.receiverParty, toSpecialty: "periodontics", reason: "تقييم لثة", urgency: "soon" }));
  expect(created.status).toBe(201);
  expect(created.headers.get("cache-control")).toContain("no-store");
  const referral = await created.json();
  const wrongSide = await journey.api(`/api/referrals/${referral.id}/transition`, referrer.cookie, post({ action: "accept" }));
  expect(wrongSide.status).toBe(403);
  expect((await wrongSide.json()).message).toMatch(/الطبيب المحال إليه/);
  expect(await journey.ddlLog()).toEqual([]);
});

it("browser: issue from the file; the receiver sees it in «عملي السريري» and accepts it", async () => {
  const context = await journey.browser.newContext({ viewport: { width: 390, height: 844 }, locale: "ar", timezoneId: "Asia/Aden" });
  const page = await context.newPage();
  const failures: string[] = [];
  await journey.browserLogin(page, "referrer");
  page.on("response", response => { const path = new URL(response.url()).pathname; if (path.startsWith("/api/") && response.status() >= 400) failures.push(`${response.status()} ${path}`); });
  await page.goto(`${journey.baseUrl}/patients/${ids.patient}`);
  const work = page.getByTestId("referral-work");
  await work.getByTestId("referral-issue-open").click();
  const form = work.getByTestId("referral-issue-form");
  await form.getByTestId("referral-receiver").selectOption(String(ids.receiverParty));
  await form.getByTestId("referral-specialty").selectOption("endodontics");
  await form.getByTestId("referral-reason").fill("علاج عصب للضرس 36");
  await form.getByTestId("referral-issue-save").click();
  await expect.poll(async () => (await journey.db.query("SELECT count(*)::int AS n FROM patient_referrals WHERE reason='علاج عصب للضرس 36'")).rows[0].n).toBe(1);
  await context.close();

  const second = await journey.browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "ar", timezoneId: "Asia/Aden" });
  const receiverPage = await second.newPage();
  await journey.browserLogin(receiverPage, "receiver");
  receiverPage.on("response", response => { const path = new URL(response.url()).pathname; if (path.startsWith("/api/") && response.status() >= 400) failures.push(`${response.status()} ${path}`); });
  await receiverPage.goto(`${journey.baseUrl}/my-work`);
  await receiverPage.getByRole("region", { name: "أُحيلت إليك" }).getByText("مريض الإحالة التجريبي").first().waitFor();
  await receiverPage.goto(`${journey.baseUrl}/patients/${ids.patient}`);
  const { rows: [row] } = await journey.db.query<{ id: number }>("SELECT id FROM patient_referrals WHERE reason='علاج عصب للضرس 36'");
  const line = receiverPage.getByTestId("referral-work").locator(`[data-referral="${row.id}"]`);
  await line.locator('[data-step="accept"]').click();
  await line.getByTestId("referral-step-save").click();
  await expect.poll(async () => (await journey.db.query<{ s: string }>("SELECT workflow_state AS s FROM patient_referrals WHERE id=$1", [row.id])).rows[0].s).toBe("accepted");
  expect((await journey.db.query("SELECT actor FROM audit_log WHERE action='referral.accept' AND details->>'الإحالة'=$1::text", [row.id])).rows).toEqual([{ actor: "canon-ref-b" }]);
  expect(failures).toEqual([]);
  await second.close();
  expect(await journey.ddlLog()).toEqual([]);
});
