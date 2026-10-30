/** Slice 26: real password admission and real shift commands on a built server
 * and an owned synthetic database. Financial writers outside shifts stay out. */
import { afterAll, beforeAll, expect, it } from "vitest";
import { mkdir } from "node:fs/promises";
import { openCanonicalJourney, type CanonicalJourney } from "./_canonical-journey-harness";

const GRANTS = { "finance.shifts.view": true, "finance.shifts.operate": true };
const ACCOUNTS = {
  owner: { username: "canon-shift-owner", password: "Canon#ShiftOwner1", role: "admin", display: "المالك التجريبي" },
  operator: { username: "canon-shift-operator", password: "Canon#ShiftOperator1", role: "reception", display: "مسؤول الصندوق", grants: GRANTS },
  doctor: { username: "canon-shift-doctor", password: "Canon#ShiftDoctor1", role: "doctor", doctor: true, patientScope: "own", display: "طبيب مفوض", grants: GRANTS },
  reader: { username: "canon-shift-reader", password: "Canon#ShiftReader1", role: "accountant", display: "قارئ الصندوق", grants: { "finance.shifts.view": true } },
  ungrantedAdmin: { username: "canon-shift-admin", password: "Canon#ShiftAdmin1", role: "admin", display: "مدير بلا منح", grants: {} },
  own: { username: "canon-shift-own", password: "Canon#ShiftOwn1", role: "doctor", doctor: true, patientScope: "own", display: "قارئ سندات مرضاه", grants: { "finance.shifts.view": true, "finance.payments.view": true } },
  expenses: { username: "canon-shift-expenses", password: "Canon#ShiftExpense1", role: "reception", display: "قارئ المصروفات", grants: { "finance.shifts.view": true, "finance.expenses.view": true } },
} as const;
type Key = keyof typeof ACCOUNTS;
let journey: CanonicalJourney<Key>;
let ownPatient: number, outsidePatient: number, ownPayment: number, outsidePayment: number;
beforeAll(async () => {
  journey = await openCanonicalJourney({ portOffset: 33, secret: "canonical-shifts-journey-secret-0123456789", accounts: ACCOUNTS, ownerKey: "owner", seed: async (db, _ids, parties) => {
    ownPatient = (await db.query("INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES('SYN-SH-OWN','مريض ظاهر للصندوق',$1) RETURNING id", [parties.own])).rows[0].id;
    outsidePatient = (await db.query("INSERT INTO patients(patient_number,full_name) VALUES('SYN-SH-OUT','SYN-HIDDEN-PATIENT') RETURNING id")).rows[0].id;
  } });
}, 300_000);
afterAll(async () => { await journey?.close(); }, 60_000);
const request = (cookie: string, method: "POST" | "PATCH", body: object) => journey.api("/api/shifts", cookie, { method, body: JSON.stringify(body) });

it("HTTP: exact grants control writes; role labels and adjacent read grants do not authorize opening or closing", async () => {
  for (const key of ["reader", "ungrantedAdmin"] as const) {
    const login = await journey.login(key);
    expect(login.status).toBe(200);
    expect((await journey.api("/api/shifts", login.cookie)).status).toBe(key === "reader" ? 200 : 403);
    for (const method of ["POST", "PATCH"] as const) {
      const response = await request(login.cookie, method, { id: 1, opening: {}, counted: {} });
      expect(response.status).toBe(403);
      expect(response.headers.get("cache-control")).toContain("no-store");
      expect((await response.json()).message).toMatch(/[؀-ۿ]/);
    }
  }
  const doctor = await journey.login("doctor");
  const opened = await request(doctor.cookie, "POST", { opening: { YER: "1000", SAR: "12.34", USD: "56.78" }, openedBy: "forged" });
  expect(opened.status).toBe(201);
  const shift = await opened.json();
  expect(shift).toMatchObject({ openedBy: ACCOUNTS.doctor.username, opening: { YER: 1000, SAR: 1234, USD: 5678 } });
  expect((await request(doctor.cookie, "POST", { opening: {} })).status).toBe(409);
  const refused = await request(doctor.cookie, "PATCH", { id: shift.id, counted: { YER: "999", SAR: "12.34", USD: "56.78" } });
  expect(refused.status).toBe(409);
  expect(await refused.json()).toMatchObject({ code: "difference_reason_required", difference: { YER: -1, SAR: 0, USD: 0 } });
  expect((await journey.db.query("SELECT status FROM cashier_shifts WHERE id=$1", [shift.id])).rows[0].status).toBe("open");
  const body = { id: shift.id, counted: { YER: "999", SAR: "12.34", USD: "56.78" }, differenceReason: "سبب تجريبي", note: "SYN-HIDDEN-SHIFT-NOTE", closedBy: "forged" };
  const closed = await request(doctor.cookie, "PATCH", body);
  expect(closed.status).toBe(200);
  expect(await closed.json()).toMatchObject({ status: "closed", closedBy: ACCOUNTS.doctor.username, difference: { YER: -1, SAR: 0, USD: 0 } });
  expect((await request(doctor.cookie, "PATCH", body)).status).toBe(409);
  expect((await journey.db.query("SELECT action,actor FROM audit_log WHERE entity='shift' AND entity_id=$1 ORDER BY id", [String(shift.id)])).rows)
    .toEqual([{ action: "shift.open", actor: ACCOUNTS.doctor.username }, { action: "shift.close", actor: ACCOUNTS.doctor.username }]);
  expect(await journey.ddlLog()).toEqual([]);
});

it("HTTP: untrusted bodies, cross-origin writes, and stale sessions have no effect", async () => {
  const operator = await journey.login("operator");
  const before = (await journey.db.query("SELECT count(*)::int AS n FROM cashier_shifts")).rows[0].n;
  for (const body of [[], { opening: { YER: "-1" } }, { opening: { USD: true } }, { opening: { USD: [] } }]) {
    expect((await request(operator.cookie, "POST", body)).status).toBe(400);
  }
  const crossOrigin = await journey.api("/api/shifts", operator.cookie, { method: "POST", headers: { Origin: "https://invalid.example" }, body: JSON.stringify({ opening: {} }) });
  expect(crossOrigin.status).toBe(403);
  const malformed = await journey.api("/api/shifts", operator.cookie, { method: "POST", body: "{" });
  expect(malformed.status).toBe(400);
  await journey.db.query("UPDATE users SET permissions=jsonb_set(permissions::jsonb,'{revision}','2'::jsonb)::text WHERE id=$1", [journey.ids.operator]);
  const stale = await request(operator.cookie, "POST", {});
  expect(stale.status).toBe(401);
  expect((await journey.db.query("SELECT count(*)::int AS n FROM cashier_shifts")).rows[0].n).toBe(before);
  expect(await journey.ddlLog()).toEqual([]);
});

it("HTTP: complete aggregates survive projection; receipt scope, expenses and unattributed notes have separate gates", async () => {
  const owner = await journey.login("owner");
  const opened = await request(owner.cookie, "POST", { opening: { YER: "100", SAR: "2", USD: "3" } });
  expect(opened.status).toBe(201);
  const shift = await opened.json();
  const rows = (await journey.db.query(`INSERT INTO payments(receipt_number,patient_id,shift_id,kind,amount_minor,currency,base_amount_minor,method,note)
    VALUES('SYN-OWN-RECEIPT',$1,$3,'payment',40,'YER',40,'cash','ملاحظة السند الظاهر'),
          ('SYN-HIDDEN-RECEIPT',$2,$3,'payment',70,'YER',70,'cash','SYN-HIDDEN-PAYMENT-NOTE'),
          ('SYN-HIDDEN-TRANSFER',$2,$3,'payment',900,'YER',900,'transfer',NULL) RETURNING id`, [ownPatient, outsidePatient, shift.id])).rows;
  ownPayment = rows[0].id; outsidePayment = rows[1].id;
  await journey.db.query(`INSERT INTO expenses(voucher_number,category,payee_text,shift_id,amount_minor,currency,base_amount_minor,note)
    VALUES('SYN-HIDDEN-VOUCHER','other','SYN-HIDDEN-PAYEE',$1,10,'YER',10,'SYN-HIDDEN-EXPENSE-NOTE')`, [shift.id]);
  const full = await (await journey.api("/api/shifts", owner.cookie)).json();
  expect(full.drawer.expected).toEqual({ YER: 200, SAR: 200, USD: 300 });
  expect(full.payments).toHaveLength(3); expect(full.expenses).toHaveLength(1); expect(full.canOperate).toBe(true);
  expect(JSON.stringify(full)).toContain("SYN-HIDDEN-SHIFT-NOTE");
  for (const key of ["own", "reader", "expenses"] as const) {
    const login = await journey.login(key);
    const response = await journey.api(`/api/shifts?patientId=${outsidePatient}&doctorId=0&scope=all&details=all&export=1`, login.cookie);
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("private, no-store");
    const body = await response.json();
    expect(body.drawer).toEqual(full.drawer); expect(body.canOperate).toBe(false);
    expect(body).not.toHaveProperty("totals"); expect(body).not.toHaveProperty("expenseTotals");
    expect(JSON.stringify(body)).not.toMatch(/SYN-HIDDEN-(PATIENT|RECEIPT|TRANSFER|PAYMENT-NOTE|SHIFT-NOTE)/);
    if (key === "own") {
      expect(body.payments).toHaveLength(1); expect(body.payments[0].id).toBe(ownPayment);
      expect(Object.keys(body.receiptProvenance)).toEqual([String(ownPayment)]);
    } else { expect(body).not.toHaveProperty("payments"); expect(body).not.toHaveProperty("receiptProvenance"); }
    if (key === "expenses") expect(body.expenses).toHaveLength(1);
    else expect(JSON.stringify(body)).not.toMatch(/SYN-HIDDEN-(VOUCHER|PAYEE|EXPENSE-NOTE)/);
  }
  expect(await journey.ddlLog()).toEqual([]);
});

it.each([390, 1280])("browser: scoped read at %ipx mounts only the canonical feed, with no hidden DOM, overflow, print or export controls", async width => {
  const context = await journey.browser.newContext({ viewport: { width, height: 900 }, locale: "ar" });
  try {
    const page = await context.newPage(), calls: string[] = [], failures: string[] = [];
    page.on("request", request => { const path = new URL(request.url()).pathname; if (path.startsWith("/api/")) calls.push(path); });
    page.on("pageerror", error => failures.push(error.message));
    await journey.browserLogin(page, "own"); calls.length = 0;
    await page.getByRole("link", { name: "الصندوق والورديات", exact: true }).first().click();
    await page.waitForURL(/\/finance$/);
    const view = page.getByTestId("canonical-shifts");
    await view.getByText(/مريض ظاهر للصندوق/).waitFor();
    expect(await view.innerText()).not.toMatch(/SYN-HIDDEN/);
    expect(await view.locator("[data-payment-id]").count()).toBe(1);
    expect(await view.getByRole("button", { name: /تأكيد|طباعة|تصدير/ }).count()).toBe(0);
    expect(await view.locator('a[href*="print"],a[href*="export"]').count()).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    expect(calls.filter(path => !/^\/api\/auth\/(login|me)$/.test(path) && path !== "/api/shifts")).toEqual([]);
    expect(failures).toEqual([]);
    await mkdir(".settings-ui-artifacts", { recursive: true });
    await page.screenshot({ path: `.settings-ui-artifacts/canonical-shifts-own-${width}.png`, fullPage: true });
    // Browser printing can only contain the same admitted DOM. No alternate feed.
    await page.emulateMedia({ media: "print" });
    expect(await page.locator("body").innerText()).not.toMatch(/SYN-HIDDEN/);
  } finally { await context.close(); }
});

it("HTTP: canonical sessions cannot turn the legacy print/export/report routes into a detail bypass", async () => {
  for (const key of ["own", "reader", "owner"] as const) {
    const login = await journey.login(key);
    for (const path of [`/print/receipt/${outsidePayment}`, "/api/export?type=payments", "/api/reports", "/api/payments", "/api/expenses"]) {
      const response = await journey.api(path, login.cookie);
      expect([401, 403, 404, 307]).toContain(response.status);
      expect(await response.text()).not.toMatch(/SYN-HIDDEN|SYN-OWN-RECEIPT/);
    }
  }
  expect(await journey.ddlLog()).toEqual([]);
});

it("browser: failed or malformed rereads clear old details and never echo response text", async () => {
  const context = await journey.browser.newContext({ viewport: { width: 390, height: 900 }, locale: "ar" });
  try {
    const page = await context.newPage(); await journey.browserLogin(page, "own");
    await page.goto(`${journey.baseUrl}/finance`);
    const view = page.getByTestId("canonical-shifts"); await view.getByText(/مريض ظاهر للصندوق/).waitFor();
    for (const status of [500, 200]) {
      await page.route("**/api/shifts", route => route.fulfill({ status, contentType: "application/json", body: "SYN-HIDDEN-SERVER-ERROR not JSON" }));
      await view.getByRole("button", { name: "تحديث بيانات الصندوق" }).click();
      await view.getByRole("alert").waitFor();
      expect(await view.innerText()).not.toMatch(/مريض ظاهر للصندوق|SYN-HIDDEN|SYN-OWN-RECEIPT/);
      expect(await view.getByRole("region", { name: "إجمالي الصندوق" }).count()).toBe(0);
      await page.unroute("**/api/shifts");
      await view.getByRole("button", { name: "إعادة القراءة", exact: true }).click();
      await view.getByText(/مريض ظاهر للصندوق/).waitFor();
    }
  } finally { await context.close(); }
});

it("browser: a revoked grant clears already displayed details before the refused reread, with no role fallback", async () => {
  const context = await journey.browser.newContext({ viewport: { width: 390, height: 900 }, locale: "ar" });
  try {
    const page = await context.newPage(); await journey.browserLogin(page, "own");
    await page.goto(`${journey.baseUrl}/finance`);
    const view = page.getByTestId("canonical-shifts"); await view.getByText(/مريض ظاهر للصندوق/).waitFor();
    await journey.db.query("UPDATE users SET permissions=jsonb_set(jsonb_set(permissions::jsonb,'{revision}','2'::jsonb),'{grants}','{}'::jsonb)::text WHERE id=$1", [journey.ids.own]);
    const response = page.waitForResponse(response => new URL(response.url()).pathname === "/api/shifts");
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    expect((await response).status()).toBe(401);
    await view.getByRole("alert").waitFor();
    expect(await view.innerText()).not.toMatch(/مريض ظاهر للصندوق|SYN-HIDDEN|SYN-OWN-RECEIPT/);
    expect(await view.getByRole("region", { name: "إجمالي الصندوق" }).count()).toBe(0);
    const fresh = await journey.login("own");
    const denied = await journey.api("/api/shifts", fresh.cookie);
    expect(denied.status).toBe(403);
    const body = await denied.json(); expect(body.message).toMatch(/[؀-ۿ]/);
    expect(JSON.stringify(body)).not.toMatch(/SYN-|SELECT|permissions|patient_id/);
  } finally { await context.close(); }
});

it("browser: a lost committed open response followed by an external close cannot auto-open another shift, even after reload", async () => {
  const owner = await journey.login("owner");
  const current = await (await journey.api("/api/shifts", owner.cookie)).json();
  expect((await request(owner.cookie, "PATCH", { id: current.open.id, counted: { YER: "200", SAR: "2", USD: "3" } })).status).toBe(200);
  const before = Number((await journey.db.query("SELECT count(*) FROM audit_log WHERE action='shift.open'")).rows[0].count);
  const context = await journey.browser.newContext({ viewport: { width: 390, height: 900 }, locale: "ar" });
  try {
    const page = await context.newPage(); let posts = 0; const failures: string[] = [];
    page.on("pageerror", error => failures.push(error.message));
    await journey.browserLogin(page, "operator"); await page.goto(`${journey.baseUrl}/finance`);
    const view = page.getByTestId("canonical-shifts"); await view.getByRole("button", { name: "تأكيد فتح وردية جديدة" }).waitFor();
    await page.route("**/api/shifts", async route => {
      if (route.request().method() !== "POST") return route.continue();
      posts++;
      if (posts !== 1) return route.continue();
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      const opened = await response.json();
      // Another operator closes it before this tab learns the open succeeded.
      expect((await request(owner.cookie, "PATCH", { id: opened.id, counted: { YER: "55" } })).status).toBe(200);
      await route.abort("failed");
    });
    await view.getByRole("textbox", { name: "الافتتاحي YER", exact: true }).fill("55");
    await view.getByRole("button", { name: "تأكيد فتح وردية جديدة" }).click();
    await view.getByRole("region", { name: "التحقق من نتيجة العملية" }).waitFor();
    expect(await view.getByRole("button", { name: "تأكيد فتح وردية جديدة" }).isDisabled()).toBe(true);
    await page.reload();
    await view.getByRole("region", { name: "التحقق من نتيجة العملية" }).waitFor();
    await view.getByRole("button", { name: "تحديث بيانات الصندوق" }).click();
    await view.getByText("لا توجد وردية مفتوحة", { exact: true }).waitFor();
    expect(await view.getByRole("button", { name: "تأكيد فتح وردية جديدة" }).isDisabled()).toBe(true);
    expect(posts).toBe(1);
    expect(Number((await journey.db.query("SELECT count(*) FROM audit_log WHERE action='shift.open'")).rows[0].count)).toBe(before + 1);
    await view.getByRole("button", { name: "راجعت النتيجة وأريد بدء عملية جديدة" }).click();
    await view.getByText("تمت إعادة التحقق. اختر العملية الجديدة وأدخل بياناتها.").waitFor();
    expect(posts).toBe(1); // Acknowledgement only rereads; it never writes.
    await view.getByRole("textbox", { name: "الافتتاحي YER", exact: true }).fill("77");
    await view.getByRole("button", { name: "تأكيد فتح وردية جديدة" }).click();
    await view.getByRole("button", { name: "تأكيد الجرد والإقفال" }).waitFor();
    expect(posts).toBe(2);
    await view.getByRole("textbox", { name: "المعدود YER", exact: true }).fill("76");
    await view.getByRole("button", { name: "تأكيد الجرد والإقفال" }).click();
    await view.getByRole("textbox", { name: "سبب فرق الجرد" }).fill("فرق جرد تجريبي");
    await view.getByRole("button", { name: "تأكيد الجرد والإقفال" }).click();
    await view.getByRole("button", { name: "تأكيد فتح وردية جديدة" }).waitFor();
    expect(await view.innerText()).toContain("أُقفلت الوردية وسُجّل الجرد.");
    expect(failures).toEqual([]); expect(await journey.ddlLog()).toEqual([]);
  } finally { await context.close(); }
});
