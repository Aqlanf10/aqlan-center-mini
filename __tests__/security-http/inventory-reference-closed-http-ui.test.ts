import { mkdir, writeFile } from "node:fs/promises";
import { afterAll, beforeAll, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { Client } from "pg";
import {
  authedGet,
  authedMutation,
  baseUrl,
  harness,
  loginStaff,
  TEST_USERS,
} from "./_server";
let browser: Browser, db: Client, admin: { cookie: string };
const directory =
  process.env.INVENTORY_EVIDENCE_DIR ?? ".inventory-procurement-artifacts";
const diagnostics = {
  pageErrors: [] as string[],
  consoleErrors: [] as string[],
};
beforeAll(async () => {
  const h = await harness();
  const url = new URL(h.seeded.dbUrl);
  expect(url.hostname).toBe("127.0.0.1");
  expect(url.pathname).toBe("/aqlan_sec_http");
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  admin = await loginStaff(
    TEST_USERS.admin.username,
    TEST_USERS.admin.password,
  );
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.INVENTORY_CHROMIUM_EXECUTABLE,
  });
  await mkdir(directory, { recursive: true });
});
afterAll(async () => {
  await writeFile(
    `${directory}/reference-closed-diagnostics.json`,
    JSON.stringify(diagnostics, null, 2),
  );
  await browser?.close();
  await db?.end();
  expect(diagnostics.pageErrors).toEqual([]);
});
it.each([390, 1280])(
  "real signed-login reference setup remains closed without canonical authority at %ipx",
  async (width) => {
    // No proposal or business reference fixtures are installed in this file.
    const snapshot = async () =>
      (
        await db.query(
          "SELECT (SELECT count(*) FROM inventory_items)::text AS items,(SELECT count(*) FROM inventory_movements)::text AS movements,(SELECT count(*) FROM payables)::text AS payables,(SELECT count(*) FROM audit_log)::text AS audits",
        )
      ).rows[0];
    const before = await snapshot();
    for (const view of ["reference-setup", "first-use-readiness"]) {
      const response = await authedGet(
        `/api/inventory/procurement?view=${view}`,
        admin,
      );
      expect(response.status).toBe(503);
      expect((await response.json()).code).toBe(
        "inventory_reference_authority_unavailable",
      );
    }
    const response = await authedMutation(
      "/api/inventory/procurement",
      admin,
      "POST",
      JSON.stringify({
        command: "reference.admit",
        intent: {
          protocol: "inventory-reference-v1",
          authority: {
            realmId: "asserted",
            subjectId: "asserted",
            generation: "asserted",
          },
          nonce: "00000000-0000-4000-8000-000000000001",
          input: {
            action: "item.create",
            name: "Untrusted actor assertion",
            category: "other",
            baseUnit: "piece",
            basePrecision: 0,
            minLevel: "0",
            note: "",
            reason: "Synthetic refused assertion",
          },
        },
      }),
    );
    expect(response.status).toBe(503);
    expect((await response.json()).code).toBe(
      "inventory_reference_authority_unavailable",
    );
    const context = await browser.newContext({
      viewport: { width, height: 900 },
    });
    const [name, ...value] = admin.cookie.split("=");
    await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
    try {
      const page = await context.newPage();
      page.on("pageerror", (e) => diagnostics.pageErrors.push(e.message));
      page.on("console", (m) => {
        if (m.type() === "error") diagnostics.consoleErrors.push(m.text());
      });
      await page.goto(`${baseUrl}/inventory/procurement/setup`);
      await page
        .getByRole("heading", { name: "التهيئة غير متاحة", exact: true })
        .waitFor();
      expect(
        await page
          .getByRole("heading", { name: "تهيئة المواد والمواقع", exact: true })
          .isVisible(),
      ).toBe(true);
      expect(await page.getByTestId("reference-editor").count()).toBe(0);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page
        .getByRole("button", { name: "المواقع والعهد", exact: true })
        .focus();
      await page.keyboard.press("Enter");
      expect(
        await page
          .getByRole("button", { name: "المواقع والعهد", exact: true })
          .getAttribute("aria-current"),
      ).toBe("page");
      await page.screenshot({
        path: `${directory}/reference-setup-closed-ar-${width}.png`,
        fullPage: true,
      });
      await page.getByRole("button", { name: "English", exact: true }).click();
      expect(
        await page
          .getByRole("heading", { name: "Setup unavailable", exact: true })
          .isVisible(),
      ).toBe(true);
      expect(await page.locator('main[lang="en"]').getAttribute("dir")).toBe(
        "ltr",
      );
    } finally {
      await context.close();
    }
    expect(await snapshot()).toEqual(before);
  },
);
