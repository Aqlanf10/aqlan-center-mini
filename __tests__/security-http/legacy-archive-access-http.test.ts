import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir } from "node:fs/promises";
import { Client } from "pg";
import { chromium, type Browser, type Locator } from "playwright";
import { hashPassword } from "../../lib/auth";
import { DEFAULT_DOCTOR_PERMISSIONS } from "../../lib/doctor-permissions";
import { authedGet, authedMutation, baseUrl, harness, loginStaff } from "./_server";

// Remote built-app gate, real sessions/permissions/database; synthetic records only.
let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let browser: Browser;
let own = 0; let other = 0; let target = 0; let archiveId = 0; let duplicateNumber = "";
let permitted: { cookie: string }; let clinicalOnly: { cookie: string };
const stamp = Date.now();
beforeAll(async () => {
  h = await harness(); db = new Client({ connectionString: h.seeded.dbUrl, ssl: false }); await db.connect();
  const doctors = (await db.query<{ username: string; party_id: number }>("SELECT username,party_id FROM users WHERE username IN ('secdoctora','secdoctorb')")).rows;
  const partyA = doctors.find((row) => row.username === "secdoctora")!.party_id;
  const partyB = doctors.find((row) => row.username === "secdoctorb")!.party_id;
  const patient = async (label: string, doctor: number) => (await db.query<{ id: number }>(
    "INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES ($1,$1,$2) RETURNING id", [`ARC-${label}-${stamp}`, doctor])).rows[0].id;
  own = await patient("OWN", partyA); other = await patient("OTHER", partyB); target = await patient("TARGET", partyA);
  duplicateNumber = `ARC-OWN-${stamp}`;
  archiveId = (await db.query<{ id: number }>(`INSERT INTO legacy_treatments
    (patient_id,legacy_number,currency,price_minor,paid_minor,remaining_minor,rate,imported_by)
    VALUES ($1,$2,'SAR',67891,67891,0,143.25,'synthetic-archive-test') RETURNING id`, [own, 1000000 + own])).rows[0].id;
  await db.query("INSERT INTO visits(patient_id,patient_name,status) VALUES ($1,'Synthetic archive visit','done')", [own]);
  const password = "SyntheticArchive#Pass1"; const hash = await hashPassword(password);
  const user = async (label: string, canViewPatientPayments: boolean) => {
    const username = `arc${label}${stamp}`;
    await db.query("INSERT INTO users(username,display_name,password_hash,role,party_id,permissions) VALUES ($1,$1,$2,'doctor',$3,$4)",
      [username, hash, partyA, JSON.stringify({ ...DEFAULT_DOCTOR_PERMISSIONS, canViewAllPatients: false, canViewPatientPayments })]);
    return loginStaff(username, password);
  };
  permitted = await user("finance", true); clinicalOnly = await user("clinical", false);
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
  await mkdir(".settings-ui-artifacts", { recursive: true });
}, 120_000);
afterAll(async () => {
  try { await browser?.close(); }
  finally {
    try {
      // The shared import gate starts with an empty archive. Remove only this
      // file's exact synthetic archive row; never clear shared archive tables.
      if (archiveId) expect((await db.query(
        "DELETE FROM legacy_treatments WHERE id=$1 AND patient_id=$2 AND imported_by='synthetic-archive-test'",
        [archiveId, own])).rowCount).toBe(1);
    } finally { await db?.end(); }
  }
});

describe("historical archive financial scope and safe merge over HTTP", () => {
  it("denies a doctor who can open the clinical file but cannot read its money", async () => {
    const response = await authedGet(`/api/patients/${own}/legacy`, clinicalOnly);
    expect(response.status).toBe(403); expect(await response.text()).not.toMatch(/67891|legacyNumber|treatments|143\.25/);
  });
  it("still denies another doctor's patient when financial-read permission is granted", async () => {
    const response = await authedGet(`/api/patients/${other}/legacy`, permitted);
    expect(response.status).toBe(404); expect(await response.text()).not.toContain("treatments");
  });
  it.each(["admin", "reception", "permitted"])("returns the preserved import plus internal provenance identity to %s", async (role) => {
    const session = role === "permitted" ? permitted : h.sessions[role as "admin" | "reception"];
    const response = await authedGet(`/api/patients/${own}/legacy`, session); expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.treatments).toEqual([expect.objectContaining({ id: archiveId, legacyNumber: 1000000 + own,
      sourceKind: "legacy_import", historicalAsOf: null, priceMinor: 67891, paidMinor: 67891, remainingMinor: 0, rate: 143.25 })]);
    expect(JSON.stringify(payload)).not.toMatch(/intake|source_note|sourceNote/);
  });
  it("returns 409 for a fully paid archive and leaves the source visit and archive owner intact", async () => {
    const response = await authedMutation(`/api/patients/${target}/merge`, h.sessions.admin, "POST",
      JSON.stringify({ duplicatePatientNumber: duplicateNumber, confirmDuplicateNumber: duplicateNumber }));
    expect(response.status).toBe(409); const payload = await response.json();
    expect(payload.counts).toMatchObject({ legacyTreatments: 1, openingBalances: 0, payments: 0 });
    expect(payload.message).toContain("سجل مالي سابق"); expect(payload.message).not.toContain("قيودٍ معاكسة");
    expect((await db.query("SELECT patient_id FROM legacy_treatments WHERE id=$1", [archiveId])).rows).toEqual([{ patient_id: own }]);
    expect((await db.query("SELECT id FROM visits WHERE patient_id=$1", [own])).rows).toHaveLength(1);
    expect((await db.query("SELECT id FROM patients WHERE id=$1", [own])).rows).toHaveLength(1);
  });
});

async function assertArchiveReadable(panel: Locator) {
  await panel.evaluate((element) => element.scrollIntoView({ block: "center" }));
  await expect.poll(() => panel.evaluate((element) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const rects: DOMRect[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.textContent?.trim()) continue;
      const range = document.createRange(); range.selectNodeContents(node);
      rects.push(...Array.from(range.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0));
    }
    return rects.length > 0 && rects.every((rect) => {
      if (rect.left < 0 || rect.top < 0 || rect.right > window.innerWidth || rect.bottom > window.innerHeight) return false;
      return [rect.left + 1, rect.left + rect.width / 2, rect.right - 1].every((x) =>
        [rect.top + 1, rect.top + rect.height / 2, rect.bottom - 1].every((y) => {
          const hit = document.elementFromPoint(x, y); return hit !== null && element.contains(hit);
        }));
    });
  })).toBe(true);
}

describe("archive reader identity and restriction in the real RTL interface", () => {
  it.each([1280, 390])("renders nullable rows and explicit denied/unavailable states at %ipx", async (width) => {
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 1000 }, locale: "ar-YE", serviceWorkers: "block" });
    const [name, ...value] = h.sessions.admin.cookie.split("=");
    await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
    let readStatus = 200;
    const writes: string[] = []; const errors: string[] = [];
    // Future nullable rows are transport fixtures only. No unregistered schema
    // or manual archive writer is installed in this built-app test.
    const old = { id: 501, legacyNumber: 901, sourceKind: "legacy_import", historicalAsOf: null,
      treatedOn: "2025-01-01", doctorName: "Synthetic original doctor", service: "Imported archive fixture",
      currency: "SAR", priceMinor: 60000, rate: 143.25, paidMinor: 25000, remainingMinor: 35000, payments: [] };
    const manual = (id: number) => ({ ...old, id, legacyNumber: null, sourceKind: "manual_history", historicalAsOf: "2026-09-01",
      rate: null, service: `Manual archive fixture ${id}` });
    await context.route("**/*", async (route) => {
      const request = route.request(); const url = new URL(request.url());
      if (url.origin !== baseUrl) { await route.abort(); return; }
      if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) { writes.push(url.pathname); await route.abort(); return; }
      if (url.pathname === `/api/patients/${own}/legacy`) {
        await route.fulfill({ status: readStatus, contentType: "application/json",
          body: JSON.stringify(readStatus === 200 ? { treatments: [old, manual(502), manual(503)], orphanPayments: [] } : { message: "Synthetic archive read refusal" }) });
        return;
      }
      await route.continue();
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => { if (/unique.*key|same key/i.test(message.text())) errors.push(message.text()); });
    try {
      await page.goto(`${baseUrl}/patients/${own}?tab=account`, { waitUntil: "domcontentloaded" });
      const panel = page.getByRole("region", { name: "سجل النظام القديم", exact: true });
      const toggle = panel.getByRole("button", { name: /سجل النظام القديم \(3 معالجة\)/ });
      await toggle.waitFor(); expect(await toggle.count()).toBe(1); await toggle.click();
      await panel.getByText("Manual archive fixture 503", { exact: false }).waitFor();
      expect(await panel.locator("li").count()).toBe(3);
      expect(await panel.innerText()).toContain("#901"); expect(await panel.innerText()).toContain("143.25");
      expect(await panel.innerText()).toContain("البيانات التاريخية حتى 2026-09-01");
      expect(await panel.innerText()).not.toMatch(/#null|#502|#503/);
      expect(await page.locator("html").getAttribute("dir")).toBe("rtl");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
      await assertArchiveReadable(panel);
      await panel.screenshot({ path: width === 1280
        ? ".settings-ui-artifacts/legacy-archive-reader-1280.png"
        : ".settings-ui-artifacts/legacy-archive-reader-390.png" });
      readStatus = 403; await page.reload({ waitUntil: "domcontentloaded" });
      await panel.getByRole("status").filter({ hasText: "غير متاح بصلاحية الجلسة الحالية" }).waitFor();
      expect(await panel.innerText()).not.toMatch(/901|Manual archive|المدفوع|143\.25/);
      expect(await panel.getByRole("button").count()).toBe(0);
      readStatus = 500; await page.reload({ waitUntil: "domcontentloaded" });
      await panel.getByText("هذا لا يعني عدم وجود سجل", { exact: false }).waitFor();
      readStatus = 200; await panel.getByRole("button", { name: "أعد تحميل السجل السابق", exact: true }).click();
      await toggle.waitFor(); expect(await toggle.count()).toBe(1);
      expect(writes).toEqual([]); expect(errors).toEqual([]);
    } finally { await context.close(); }
  });
});
