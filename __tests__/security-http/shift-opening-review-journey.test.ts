/** 0129 (docs/finance/SHIFT_OPENING_REVIEWS_0129.md; owner #483 6831365228 item 1; blind count 6886911163, §8) on
 * a built server and an owned synthetic database: the count is committed in one step before any comparison is
 * shown; the previous close is sealed for the operator until then; only the owner or a reviewer sees amounts;
 * review and correction follow the exact grant. No cash movement, no change to the previous close. */
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
// The previous counts used below, in every way they can be printed.
const PREVIOUS = /4[,٬]?321|٤[,٬]?٣٢١/;
const BROWSER_PREVIOUS = /4[,٬]?300|٤[,٬]?٣٠٠/;
const STATE_ONLY = ["currency", "id", "shiftId", "state"];

it("HTTP: one-step opening, a sealed previous close, state-only answers, and the exact grant for review and correction", async () => {
  const operator = await journey.login("operator");
  const first = await (await shiftsApi(operator.cookie, "POST", { opening: { YER: "4321" } })).json();
  expect((await shiftsApi(operator.cookie, "PATCH", { id: first.id, counted: { YER: "4321" } })).status).toBe(200);
  // Before the next count is fixed: the operator's feed never carries the previous close's count.
  const before = await (await journey.api("/api/shifts", operator.cookie)).json();
  expect(before.open).toBeNull();
  expect(before.recent[0]).toMatchObject({ id: first.id, counted: null, expected: null, difference: null, sealed: true });
  expect(JSON.stringify(before)).not.toMatch(PREVIOUS);
  const owned = await (await journey.api("/api/shifts", (await journey.login("owner")).cookie)).json();
  expect(owned.recent[0]).toMatchObject({ id: first.id, counted: { YER: 4321, SAR: 0, USD: 0 } });
  // A differing count opens at once; the operator learns only that YER waits for review.
  const opened = await shiftsApi(operator.cookie, "POST", { opening: { YER: "4000" } });
  expect(opened.status).toBe(201);
  const shift = await opened.json();
  expect(shift.openingReviews.map((r: object) => Object.keys(r).sort())).toEqual([STATE_ONLY]);
  expect(JSON.stringify(shift)).not.toMatch(PREVIOUS);
  expect((await journey.db.query("SELECT difference_minor::int AS d FROM shift_opening_reviews WHERE shift_id=$1", [shift.id])).rows).toEqual([{ d: -321 }]);
  const id = shift.openingReviews[0].id;
  // Reads follow the grant: the reader gets the state; the reviewer gets the amounts.
  const readerList = await (await journey.api("/api/shifts/opening-reviews?status=pending", (await journey.login("reader")).cookie)).json();
  expect(readerList.reviews.find((r: { id: number }) => r.id === id)).toEqual({ id, shiftId: shift.id, currency: "YER", state: "pending" });
  const reviewer = await journey.login("reviewer");
  const reviewerList = await (await journey.api("/api/shifts/opening-reviews?status=pending", reviewer.cookie)).json();
  expect(reviewerList.reviews.find((r: { id: number }) => r.id === id)).toMatchObject({ previousCountedMinor: 4321, differenceMinor: -321 });
  // The opener and the reader may neither review nor correct; nothing changes.
  for (const key of ["operator", "reader"] as const) {
    const login = await journey.login(key);
    const review = await journey.api("/api/shifts/opening-reviews", login.cookie, { method: "POST", body: JSON.stringify({ id, reason: "سبب", settlement: "تسوية" }) });
    expect(review.status).toBe(403);
    const correction = await journey.api("/api/shifts/opening-corrections", login.cookie, { method: "POST", body: JSON.stringify({ shiftId: shift.id, opening: { YER: "4321" }, reason: "تصحيح" }) });
    expect(correction.status).toBe(403);
    expect((await correction.json()).message).toMatch(/[؀-ۿ]/);
  }
  expect(await count("SELECT count(*)::int AS n FROM shift_opening_reviews WHERE reviewed_at IS NOT NULL")).toBe(0);
  expect(await count("SELECT count(*)::int AS n FROM shift_opening_corrections")).toBe(0);
  // The reviewer corrects the count with a reason: audited, no cash movement.
  const corrected = await journey.api("/api/shifts/opening-corrections", reviewer.cookie, { method: "POST",
    body: JSON.stringify({ shiftId: shift.id, opening: { YER: "4321" }, reason: "أعيد العدّ بحضور المراجع" }) });
  expect(corrected.status).toBe(200);
  expect((await corrected.json()).corrections).toEqual([expect.objectContaining({ currency: "YER", fromMinor: 4000, toMinor: 4321 })]);
  expect(await count("SELECT count(*)::int AS n FROM audit_log WHERE action='shift.opening_correct'")).toBe(1);
  expect(await count("SELECT count(*)::int AS n FROM payments") + await count("SELECT count(*)::int AS n FROM expenses")).toBe(0);
  const after = await (await journey.api("/api/shifts", operator.cookie)).json();
  expect(after.open.opening.YER).toBe(4321);
  expect(after.open.openingCorrections).toEqual([{ id: expect.any(Number), shiftId: shift.id, currency: "YER" }]);
  // Close at 4300 (a stated shortfall): this close is what the browser test below must never show the opener.
  expect((await shiftsApi(operator.cookie, "PATCH", { id: shift.id, counted: { YER: "4300" }, differenceReason: "نقص تجريبي" })).status).toBe(200);
  expect(await journey.ddlLog()).toEqual([]);
});

it("Browser: the opener never sees the previous count, opens in one step; the reviewer sees the amounts and reviews once", async () => {
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
    // The previous close counted 4300: sealed in the history, absent from the whole page, and the form starts empty.
    await view.getByText("المعدود مختوم حتى افتتاح الوردية التالية.").waitFor();
    expect(await page.locator("body").innerText()).not.toMatch(BROWSER_PREVIOUS);
    for (const currency of ["YER", "SAR", "USD"]) {
      expect(await view.getByRole("textbox", { name: `الافتتاحي ${currency}`, exact: true }).inputValue()).toBe("");
    }
    await view.getByRole("textbox", { name: "الافتتاحي YER", exact: true }).fill("4400");
    await view.getByRole("button", { name: "تأكيد فتح وردية جديدة" }).click();
    await view.getByRole("button", { name: "تأكيد الجرد والإقفال" }).waitFor();
    const notice = view.getByTestId("opening-differences");
    await notice.getByText(/سُجّل فرق في عدّ الافتتاح .*بانتظار المراجعة/).waitFor();
    expect(await notice.innerText()).not.toMatch(/زيادة|نقص|100/);
    expect(await notice.getByRole("button", { name: "راجع الفروق المعلّقة" }).count()).toBe(0);
    expect(await notice.getByTestId("opening-correction-form").count()).toBe(0);
    expect(await view.getByTestId("opening-difference-note").count()).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await page.screenshot({ path: ".settings-ui-artifacts/shift-opening-blind-operator-390.png", fullPage: true });

    const reviewerContext = await journey.browser.newContext({ viewport: { width: 1280, height: 900 } });
    const reviewerPage = await reviewerContext.newPage();
    reviewerPage.on("pageerror", error => failures.push(error.message));
    await journey.browserLogin(reviewerPage, "reviewer");
    await reviewerPage.goto(`${journey.baseUrl}/finance`);
    const panel = reviewerPage.getByTestId("canonical-shifts").getByTestId("opening-differences");
    await panel.getByText(/زيادة 100/).waitFor();
    await panel.getByTestId("opening-correction-form").waitFor();
    await panel.getByRole("button", { name: "راجع الفروق المعلّقة" }).click();
    const form = panel.getByTestId("opening-review-form").filter({ hasText: "زيادة 100" });
    await form.waitFor();
    expect(await form.innerText()).toMatch(BROWSER_PREVIOUS);
    await form.getByRole("textbox", { name: "سبب الفرق" }).fill("مبلغ لم يُسجَّل عند الإقفال");
    await form.getByRole("textbox", { name: /كيف سُوّي/ }).fill("أُضيف إلى العهدة بعلم المالك");
    await form.getByRole("button", { name: "سجّل المراجعة" }).click();
    await panel.getByText(/زيادة 100 .*روجع \(open-review-reviewer\)/).waitFor();
    await reviewerPage.screenshot({ path: ".settings-ui-artifacts/shift-opening-difference-reviewed-1280.png", fullPage: true });
    expect((await journey.db.query("SELECT review_reason, review_settlement, reviewed_by FROM shift_opening_reviews WHERE reviewed_at IS NOT NULL AND difference_minor = 100")).rows)
      .toEqual([{ review_reason: "مبلغ لم يُسجَّل عند الإقفال", review_settlement: "أُضيف إلى العهدة بعلم المالك", reviewed_by: ACCOUNTS.reviewer.username }]);
    expect(await journey.db.query("SELECT count(*)::int AS n FROM payments").then(r => r.rows[0].n)).toBe(0);
    await reviewerContext.close();
    expect(failures).toEqual([]);
    expect(await journey.ddlLog()).toEqual([]);
  } finally { await context.close(); }
});
