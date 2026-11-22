import { Client } from "pg";
import { chromium } from "playwright";
import { expect, it } from "vitest";
import { guardBrowserRoutes } from "../helpers/guarded-browser-routes";
import { baseUrl, harness } from "./_server";

it("highlights a full Arabic-digit file number and opens it only on the receptionist's Enter", async () => {
  expect(new URL(baseUrl).hostname).toBe("127.0.0.1");
  const h = await harness();
  const target = new URL(h.seeded.dbUrl);
  expect(target.hostname).toBe("127.0.0.1");
  expect(target.pathname).toBe("/aqlan_sec_http");
  const db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  try {
    const fixtures = [
      { code: "P-91847", name: "SYNTHETIC RECEPTION SEARCH ZULU" },
      { code: "P-918476", name: "SYNTHETIC RECEPTION SEARCH ALPHA" },
    ] as const;
    const [exact, partial] = await Promise.all(fixtures.map(async (fixture) => ({
      ...fixture,
      id: (await db.query<{ id: number }>(
        "INSERT INTO patients (patient_number, full_name) VALUES ($1,$2) RETURNING id",
        [fixture.code, fixture.name],
      )).rows[0].id,
    })));
    const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
    try {
      const context = await browser.newContext({ locale: "ar-YE", viewport: { width: 1280, height: 960 }, serviceWorkers: "block" });
      const [name, ...parts] = h.sessions.reception.cookie.split("=");
      await context.addCookies([{ name, value: parts.join("="), url: baseUrl }]);
      const unexpected: string[] = [];
      const guarded = await guardBrowserRoutes(context, baseUrl, unexpected, async (route) => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== baseUrl || !["GET", "HEAD", "OPTIONS"].includes(request.method())) {
          unexpected.push(`${request.method()} ${url.pathname}`);
          await route.abort();
          return;
        }
        await route.continue();
      });
      await guarded.run(async () => {
        const page = await context.newPage();
        expect((await page.goto(`${baseUrl}/patients`, { waitUntil: "networkidle" }))?.status()).toBe(200);
        const directory = page.url();
        await page.keyboard.press("Control+k");
        const search = page.getByRole("dialog", { name: "البحث السريع", exact: true });
        const field = search.getByRole("combobox", { name: "ابحث عن مريض أو شاشة", exact: true });
        const exactChoice = search.getByRole("option").filter({ hasText: exact.name });
        const partialChoice = search.getByRole("option").filter({ hasText: partial.name });
        const find = async (q: string) => {
          const finished = page.waitForResponse(response => {
            const address = new URL(response.url());
            return address.origin === baseUrl && address.pathname === "/api/patients" && address.searchParams.get("q") === q;
          });
          await field.fill(q);
          expect((await finished).status()).toBe(200);
          await exactChoice.waitFor();
          await partialChoice.waitFor();
          expect(page.url()).toBe(directory);
        };
        await find("P-٩١٨٤");
        await expect.poll(() => partialChoice.getAttribute("aria-selected")).toBe("true");
        await find("P-٩١٨٤٧");
        await expect.poll(() => exactChoice.getAttribute("aria-selected")).toBe("true");
        expect(await partialChoice.getAttribute("aria-selected")).toBe("false");
        expect(await field.getAttribute("aria-activedescendant")).toBe(await exactChoice.getAttribute("id"));
        expect(page.url()).toBe(directory);
        await field.press("Enter");
        await page.waitForURL(url => url.pathname === `/patients/${exact.id}`);
        await page.getByText(exact.code, { exact: true }).first().waitFor();
        expect(page.url()).not.toContain(`/patients/${partial.id}`);
      }, () => { expect(unexpected).toEqual([]); });
    } finally {
      await browser.close();
    }
  } finally {
    // The security-http harness owns and drops the whole fixture database.
    await db.end();
  }
});
