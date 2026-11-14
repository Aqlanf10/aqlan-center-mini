/** 0129 (docs/finance/SHIFT_OPENING_REVIEWS_0129.md; owner #483 6831365228 item 1): the blind opening, the
 * note after the server reveals a difference, the pending notice, and the review by the exact grant, on a
 * built server and an owned synthetic database. No cash movement, no change to the previous close. */
import { afterAll, beforeAll, expect, it } from "vitest";
import { mkdir } from "node:fs/promises";
import { openCanonicalJourney, type CanonicalJourney } from "./_canonical-journey-harness";

const OPERATE = { "finance.shifts.view": true, "finance.shifts.operate": true };
const ACCOUNTS = {
  owner: { username: "open-review-owner", password: "Open#ReviewOwner1", role: "admin", display: "المالك التجريبي" },
  operator: { username: "open-review-operator", password: "Open#ReviewOperator1", role: "reception", display: "مسؤول الصندوق", grants: OPERATE },
  reviewer: { username: "open-review-reviewer", password: "Open#ReviewReviewer1", role: "accountant", display: "مراجع الفروق",
    grants: { "finance.shifts.view": true, "finance.shifts.review-opening": true } },
  reader: { username: "open-review-reader", password: "Open#ReviewReader1", role: "accountant", display: "قارئ الصندوق", grants: { "finance.shifts.view": true } },
} as const;
type Key = keyof typeof ACCOUNTS;
let journey: CanonicalJourney<Key>;
beforeAll(async () => {
  journey = await openCanonicalJourney({ portOffset: 148, secret: "shift-opening-review-journey-secret-0123456789", accounts: ACCOUNTS, ownerKey: "owner" });
}, 300_000);
afterAll(async () => { await journey?.close(); }, 60_000);
const shiftsApi = (cookie: string, method: "POST" | "PATCH", body: object) => journey.api("/api/shifts", cookie, { method, body: JSON.stringify(body) });
const count = async (sql: string) => Number((await journey.db.query(sql)).rows[0].n);

it("HTTP: a mismatch is refused without a note and never discloses the previous count; reviews follow the exact grant", async () => {
  const operator = await journey.login("operator");
  const first = await (await shiftsApi(operator.cookie, "POST", { opening: { YER: "1000" } })).json();
  expect((await shiftsApi(operator.cookie, "PATCH", { id: first.id, counted: { YER: "1000" } })).status).toBe(200);
  const shifts = await count("SELECT count(*)::int AS n FROM cashier_shifts");
  const refused = await shiftsApi(operator.cookie, "POST", { opening: { YER: "950" } });
  expect(refused.status).toBe(409);
  const body = await refused.json();
  expect(body).toMatchObject({ code: "opening_difference_note_required", differences: [{ currency: "YER", differenceMinor: -50, previousCountKnown: true }] });
  expect(JSON.stringify(body)).not.toMatch(/1[,.]?000|previousCounted/);
  expect(await count("SELECT count(*)::int AS n FROM cashier_shifts")).toBe(shifts);
  const opened = await shiftsApi(operator.cookie, "POST", { opening: { YER: "950" }, openingDifferenceNote: "نقص بعد إعادة العد" });
  expect(opened.status).toBe(201);
  const shift = await opened.json();
  expect(shift.openingReviews).toEqual([expect.objectContaining({ currency: "YER", differenceMinor: -50, openingNote: "نقص بعد إعادة العد" })]);
  const id = shift.openingReviews[0].id;
  // The opener holds no review grant; the reader neither; both are refused and nothing changes.
  for (const key of ["operator", "reader"] as const) {
    const login = await journey.login(key);
    const response = await journey.api("/api/shifts/opening-reviews", login.cookie, { method: "POST", body: JSON.stringify({ id, reason: "سبب", settlement: "تسوية" }) });
    expect(response.status).toBe(403);
    expect((await response.json()).message).toMatch(/[؀-ۿ]/);
  }
  expect(await count("SELECT count(*)::int AS n FROM shift_opening_reviews WHERE reviewed_at IS NOT NULL")).toBe(0);
  expect(await count("SELECT count(*)::int AS n FROM payments") + await count("SELECT count(*)::int AS n FROM expenses")).toBe(0);
  expect((await shiftsApi(operator.cookie, "PATCH", { id: shift.id, counted: { YER: "950" } })).status).toBe(200);
  expect(await journey.ddlLog()).toEqual([]);
});

it("Browser: the opener explains after recounting; the reviewer reviews once; the notice clears", async () => {
  await mkdir(".settings-ui-artifacts", { recursive: true });
  const failures: string[] = [];
  const context = await journey.browser.newContext({ viewport: { width: 390, height: 844 } });
  try {
    const page = await context.newPage();
    page.on("pageerror", error => failures.push(error.message));
    await journey.browserLogin(page, "operator");
    await page.goto(`${journey.baseUrl}/finance`);
    const view = page.getByTestId("canonical-shifts");
    await view.getByRole("button", { name: "تأكيد فتح وردية جديدة" }).waitFor();
    // The previous close counted 950; the form never shows it.
    expect(await view.innerText()).not.toMatch(/950/);
    await view.getByRole("textbox", { name: "الافتتاحي YER", exact: true }).fill("1000");
    await view.getByRole("button", { name: "تأكيد فتح وردية جديدة" }).click();
    await view.getByTestId("opening-difference-note").waitFor();
    expect(await view.innerText()).toMatch(/زيادة/);
    expect(await view.getByRole("button", { name: "تأكيد الجرد والإقفال" }).count()).toBe(0);
    await view.getByTestId("opening-difference-note").fill("وجدت مبلغًا إضافيًا في الدرج");
    await view.getByRole("button", { name: "تأكيد فتح وردية جديدة" }).click();
    await view.getByRole("button", { name: "تأكيد الجرد والإقفال" }).waitFor();
    const notice = view.getByTestId("opening-differences");
    await notice.getByText(/زيادة .*بانتظار المراجعة/).waitFor();
    expect(await notice.getByRole("button", { name: "راجع الفروق المعلّقة" }).count()).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await page.screenshot({ path: ".settings-ui-artifacts/shift-opening-difference-operator-390.png", fullPage: true });

    const reviewerContext = await journey.browser.newContext({ viewport: { width: 1280, height: 900 } });
    const reviewerPage = await reviewerContext.newPage();
    reviewerPage.on("pageerror", error => failures.push(error.message));
    await journey.browserLogin(reviewerPage, "reviewer");
    await reviewerPage.goto(`${journey.baseUrl}/finance`);
    const panel = reviewerPage.getByTestId("canonical-shifts").getByTestId("opening-differences");
    await panel.getByTestId("opening-differences-pending").waitFor();
    await panel.getByRole("button", { name: "راجع الفروق المعلّقة" }).click();
    // The first test left its own pending difference; review this one.
    const form = panel.getByTestId("opening-review-form").filter({ hasText: "وجدت مبلغًا إضافيًا في الدرج" });
    await form.waitFor();
    expect(await form.innerText()).toMatch(/وجدت مبلغًا إضافيًا في الدرج/);
    await form.getByRole("textbox", { name: "سبب الفرق" }).fill("مبلغ لم يُسجَّل عند الإقفال");
    await form.getByRole("textbox", { name: /كيف سُوّي/ }).fill("أُضيف إلى العهدة بعلم المالك");
    await form.getByRole("button", { name: "سجّل المراجعة" }).click();
    await panel.getByText(/روجع \(open-review-reviewer\)/).waitFor();
    await reviewerPage.screenshot({ path: ".settings-ui-artifacts/shift-opening-difference-reviewed-1280.png", fullPage: true });
    expect((await journey.db.query("SELECT review_reason, review_settlement, reviewed_by FROM shift_opening_reviews WHERE reviewed_at IS NOT NULL")).rows)
      .toEqual([{ review_reason: "مبلغ لم يُسجَّل عند الإقفال", review_settlement: "أُضيف إلى العهدة بعلم المالك", reviewed_by: ACCOUNTS.reviewer.username }]);
    expect(await count("SELECT count(*)::int AS n FROM payments") + await count("SELECT count(*)::int AS n FROM expenses")).toBe(0);
    await reviewerContext.close();
    expect(failures).toEqual([]);
    expect(await journey.ddlLog()).toEqual([]);
  } finally { await context.close(); }
});
