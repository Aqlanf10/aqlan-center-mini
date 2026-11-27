import { Client } from "pg";
import { chromium, type BrowserContext, type Locator } from "playwright";
import { expect, it } from "vitest";
import { guardBrowserRoutes } from "../helpers/guarded-browser-routes";
import { baseUrl, harness } from "./_server";

const title = "الوصفات الطبية";
const voidWarning = "VOIDED";
const voidReason = "سبب إبطال اصطناعي للاختبار فقط";

async function openStoredView(context: BrowserContext, link: Locator, path: string) {
  expect(await link.getAttribute("href")).toBe(path);
  const [popup, response] = await Promise.all([
    context.waitForEvent("page"),
    context.waitForEvent("response", {
      predicate: (result) => result.url() === baseUrl + path && result.request().resourceType() === "document",
    }),
    link.click(),
  ]);
  expect(response.status()).toBe(200);
  await popup.waitForURL(baseUrl + path, { waitUntil: "domcontentloaded" });
  await popup.locator(".sheet-a5").waitFor();
  return popup;
}

/** Real standalone app, cookie login and three fictional records in the owned
 * security-http database. No product HTML is substituted and no print dialog,
 * screenshot, prescription issuance, or actual clinic data is involved. */
it("opens saved prescription history from Summary and views the exact active and void copies without issuing", async () => {
  expect(new URL(baseUrl).hostname).toBe("127.0.0.1");
  const h = await harness();
  const target = new URL(h.seeded.dbUrl);
  expect(target.hostname).toBe("127.0.0.1");
  expect(target.pathname).toBe("/aqlan_sec_http");
  const db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  try {
    const { rows: [doctor] } = await db.query<{ party_id: number }>(
      "SELECT party_id FROM users WHERE username = 'secdoctora'",
    );
    expect(doctor?.party_id).toBeGreaterThan(0);
    const fileNumber = `SYN-RX-HISTORY-${Date.now()}`;
    const patientName = "ملف اختبار اصطناعي للوصفات المحفوظة";
    const { rows: [patient] } = await db.query<{ id: number }>(
      "INSERT INTO patients (patient_number, full_name, primary_doctor_id) VALUES ($1,$2,$3) RETURNING id",
      [fileNumber, patientName, doctor.party_id],
    );
    const created = [
      { status: "active", name: "SYNTHETIC-NONMEDICINE-OLDER", date: "2031-01-03T22:00:00.000Z" },
      { status: "void", name: "SYNTHETIC-NONMEDICINE-VOID", date: "2031-01-04T22:00:00.000Z" },
      { status: "active", name: "SYNTHETIC-NONMEDICINE-ACTIVE", date: "2031-01-05T22:00:00.000Z" },
    ] as const;
    const [older, voided, active] = await Promise.all(created.map(async (source) => {
      const { rows: [saved] } = await db.query<{ id: number }>(
        `INSERT INTO prescriptions
          (patient_id, items, instructions_lang, status, void_reason, voided_by, voided_at, created_by, doctor_party_id, created_at)
        VALUES ($1,$2::jsonb,'both',$3,$4,$5,$6,'secdoctora',$7,$8) RETURNING id`,
        [patient.id, JSON.stringify([{ name: source.name, dose: "SYN-STRENGTH", form: "SYN-FORM",
          frequency: "SYN-FREQUENCY", duration: "SYN-DURATION", instructionsEn: "SYN-INSTRUCTION" }]),
        source.status, source.status === "void" ? voidReason : null,
        source.status === "void" ? "secdoctora" : null, source.status === "void" ? source.date : null,
        doctor.party_id, source.date],
      );
      return { ...source, id: saved.id };
    }));
    const persisted = async () => (await db.query(
      "SELECT id, patient_id, items, status, void_reason, created_by, created_at FROM prescriptions WHERE patient_id=$1 ORDER BY id",
      [patient.id],
    )).rows;
    const before = await persisted();
    expect(before).toHaveLength(3);

    const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
    try {
      const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, locale: "ar-YE", serviceWorkers: "block" });
      const [name, ...parts] = h.sessions.doctorA.cookie.split("=");
      await context.addCookies([{ name, value: parts.join("="), url: baseUrl }]);
      const unexpected: string[] = [];
      let historyReads = 0;
      const listPath = `/api/patients/${patient.id}/prescriptions`;
      const guarded = await guardBrowserRoutes(context, baseUrl, unexpected, async (route) => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== baseUrl || !["GET", "HEAD", "OPTIONS"].includes(request.method())) {
          unexpected.push(`${request.method()} ${url.pathname}`);
          await route.abort();
          return;
        }
        if (request.method() === "GET" && url.pathname === listPath) historyReads++;
        await route.continue();
      });

      await guarded.run(async () => {
        const page = await context.newPage();
        const listing = `${baseUrl}/patients/${patient.id}`;
        expect((await page.goto(`${listing}?tab=summary`, { waitUntil: "domcontentloaded" }))?.status()).toBe(200);
        const panel = page.getByRole("region", { name: title, exact: true });
        await panel.getByText(`#${active.id}`, { exact: true }).waitFor();
        await panel.getByText(`#${voided.id}`, { exact: true }).waitFor();
        expect(await panel.getByRole("listitem").count()).toBe(2);
        expect(await panel.getByText(`#${older.id}`, { exact: true }).count()).toBe(0);
        expect(await panel.getByRole("link").count()).toBe(0);
        expect(historyReads).toBe(1);

        await panel.getByRole("button", { name: "عرض الوصفات المحفوظة", exact: true }).click();
        await expect.poll(() => page.getByTestId("patient-tab-prescriptions").getAttribute("aria-current")).toBe("page");
        expect(new URL(page.url()).searchParams.get("tab")).toBe("prescriptions");
        await panel.getByText(`#${older.id}`, { exact: true }).waitFor();
        expect(await panel.getByRole("listitem").count()).toBe(3);
        expect(historyReads).toBe(1);

        const activeRow = panel.getByRole("listitem").filter({ has: page.getByText(`#${active.id}`, { exact: true }) });
        await activeRow.getByText("سارية", { exact: true }).waitFor();
        const activeWindow = await openStoredView(context, activeRow.getByRole("link", { name: /فتح نسخة للطباعة/ }),
          `/print/prescription/${patient.id}?rx=${active.id}`);
        const activeSheet = activeWindow.locator(".sheet-a5");
        const activeText = await activeSheet.innerText();
        for (const part of [patientName, fileNumber, active.name, "SYN-STRENGTH", "SYN-FREQUENCY", "SYN-DURATION", "SYN-INSTRUCTION"]) {
          expect(activeText).toContain(part);
        }
        expect(activeText).not.toContain(voidWarning);
        expect(activeText).not.toContain(voided.name);
        await activeWindow.close();

        const voidRow = panel.getByRole("listitem").filter({ has: page.getByText(`#${voided.id}`, { exact: true }) });
        await voidRow.getByText("مُبطلة، لا تُصرف", { exact: true }).waitFor();
        expect(await voidRow.getByRole("link", { name: /فتح نسخة للطباعة/ }).count()).toBe(0);
        const voidWindow = await openStoredView(context, voidRow.getByRole("link", { name: /عرض الوصفة المبطلة/ }),
          `/print/prescription/${patient.id}?rx=${voided.id}`);
        const voidText = await voidWindow.locator(".sheet-a5").innerText();
        for (const part of [patientName, fileNumber, voided.name, voidReason, voidWarning, "لا تُصرف منها"]) {
          expect(voidText).toContain(part);
        }
        expect(voidText).not.toContain(active.name);
        await voidWindow.close();
        expect(await page.getByTestId("patient-tab-prescriptions").getAttribute("aria-current")).toBe("page");
      }, () => { expect(unexpected).toEqual([]); });
    } finally {
      await browser.close();
    }
    expect(await persisted()).toEqual(before);
  } finally {
    // The harness owns and drops the entire isolated aqlan_sec_http database.
    await db.end();
  }
});
