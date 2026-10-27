import { INVENTORY_SUPPLIER_NUMBER_SQL } from "../../lib/inventory-domain/supplier-number-schema-proposal";
import { createInventoryRecoveryCommand } from "../../lib/inventory-command-recovery";
import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { chromium, type Browser } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { INVENTORY_PROCUREMENT_SQL } from "../../lib/inventory-domain/schema-proposal";
import { INVENTORY_CUSTODY_SQL } from "../../lib/inventory-domain/custody-schema-proposal";
import { guardBrowserRoutes } from "../helpers/guarded-browser-routes";
import {
  valuationSnapshot,
  type RequestRevision,
  type PurchaseOrder,
  type ReceiptRevision,
} from "../../lib/inventory-domain/procurement";
import {
  harness,
  authedMutation,
  authedGet,
  baseUrl,
  loginStaff,
  TEST_USERS,
} from "./_server";
import { INVENTORY_SUPPLIER_FINANCE_SQL } from "../../lib/inventory-domain/supplier-finance-schema-proposal";
import { INVENTORY_COMMAND_LIFECYCLE_SQL } from "../../lib/inventory-domain/command-lifecycle-schema-proposal";
import { INVENTORY_SUPPLIER_TRANSPORT_SQL } from "../../lib/inventory-domain/supplier-transport-schema-proposal";
import { STAFF_AUTHORITY_SQL } from "../../lib/staff-authority-schema-proposal";
import {
  bootstrapStaffIdentityInTransaction,
  rotateStaffExecutionEpochInTransaction,
} from "../../lib/staff-authority-lifecycle.mjs";
let h: Awaited<ReturnType<typeof harness>>,
  db: Client,
  browser: Browser,
  admin: { cookie: string };
let itemId: number, supplierId: number, doctorId: number, adminId: number;
const diagnostics: {
  pageErrors: string[];
  consoleErrors: string[];
  networkFailures: { url: string; error: string | null }[];
} = { pageErrors: [], consoleErrors: [], networkFailures: [] };
const location = `SYN-FINANCE-${randomUUID()}`;
const artifacts =
  process.env.INVENTORY_EVIDENCE_DIR ?? ".inventory-procurement-artifacts";
beforeAll(async () => {
  h = await harness();
  const url = new URL(h.seeded.dbUrl);
  expect(url.hostname).toBe("127.0.0.1");
  expect(url.pathname).toBe("/aqlan_sec_http");
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  for (const sql of [
    INVENTORY_PROCUREMENT_SQL,
    INVENTORY_SUPPLIER_FINANCE_SQL,
    INVENTORY_SUPPLIER_NUMBER_SQL,
    INVENTORY_COMMAND_LIFECYCLE_SQL,
    STAFF_AUTHORITY_SQL,
    INVENTORY_SUPPLIER_TRANSPORT_SQL,
  ])
    await db.query(sql);
  await db.query("BEGIN");
  try {
    await bootstrapStaffIdentityInTransaction(
      db,
      "Explicit synthetic HTTP bootstrap",
    );
    await db.query("COMMIT");
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  }
  const users = (
    await db.query(
      "SELECT id,username FROM users WHERE username IN ('secadmin','secdoctora')",
    )
  ).rows;
  adminId = users.find((r) => r.username === "secadmin").id;
  doctorId = users.find((r) => r.username === "secdoctora").id;
  itemId = (
    await db.query(
      "INSERT INTO inventory_items(name,category,unit,min_level,created_by) VALUES('SYN-FINANCE cartridges','anesthesia','cartridge',5,'secadmin') RETURNING id",
    )
  ).rows[0].id;
  supplierId = (
    await db.query(
      "INSERT INTO parties(name,kind) VALUES('SYN-FINANCE supplier','supplier') RETURNING id",
    )
  ).rows[0].id;
  await db.query(
    "INSERT INTO inventory_item_unit_versions(item_id,version,entered_unit,base_unit,factor,entered_precision,base_precision) VALUES($1,1,'box','cartridge',50,0,0)",
    [itemId],
  );
  await db.query(
    "INSERT INTO inventory_locations(id,branch_key,label,kind) VALUES($1,'clinic','Synthetic finance store','store')",
    [location],
  );
  await db.query(
    "INSERT INTO inventory_approval_policies(id,branch_key,version,currency,limit_minor,created_by) SELECT $1,'clinic',COALESCE(MAX(version),0)+1,'YER',1000000000,$2 FROM inventory_approval_policies WHERE branch_key='clinic'",
    [randomUUID(), adminId],
  );
  admin = await loginStaff(
    TEST_USERS.admin.username,
    TEST_USERS.admin.password,
  );
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.INVENTORY_CHROMIUM_EXECUTABLE,
  });
  await mkdir(artifacts, { recursive: true });
});
afterAll(async () => {
  await writeFile(
    `${artifacts}/browser-diagnostics.json`,
    JSON.stringify(diagnostics, null, 2),
  );
  await browser?.close();
  await db?.end();
  expect(diagnostics.pageErrors).toEqual([]);
});
const operation = (command: string, payload: object) =>
  JSON.stringify({ command, operationKey: randomUUID(), ...payload });
const conversion = () => ({
  itemId,
  version: 1,
  baseUnit: "cartridge",
  enteredUnit: "box",
  baseUnitsPerEnteredUnit: "50",
  enteredPrecision: 0,
  basePrecision: 0,
});
const counts = async () =>
  (
    await db.query(
      "SELECT (SELECT COUNT(*) FROM inventory_movements)::int AS stock,(SELECT COUNT(*) FROM payables)::int AS debt,(SELECT COUNT(*) FROM expenses)::int AS cash",
    )
  ).rows[0];
async function fixture(missingNumber = false) {
  const before = await counts();
  const r: RequestRevision = {
    id: randomUUID(),
    version: 1,
    branchId: "clinic",
    requestedBy: 999999,
    reason: "SYN request journey",
    proposedSupplierPartyId: supplierId,
    value: { currency: "SAR", amountMinor: 30000 },
    lines: [
      { id: randomUUID(), itemId, quantity: "3", conversion: conversion() },
    ],
  };
  const body = operation("request.submit", { document: r });
  expect(
    (
      await authedMutation(
        "/api/inventory/procurement",
        h.sessions.doctorA,
        "POST",
        body,
      )
    ).status,
  ).toBe(201);
  expect(
    (
      await authedMutation(
        "/api/inventory/procurement",
        h.sessions.doctorA,
        "POST",
        body,
      )
    ).status,
  ).toBe(201);
  expect(await counts()).toEqual(before);
  expect(
    (
      await db.query("SELECT requested_by FROM purchase_requests WHERE id=$1", [
        r.id,
      ])
    ).rows[0].requested_by,
  ).toBe(doctorId);
  const approval = {
    requestId: r.id,
    version: 1,
    decisions: [
      { lineId: r.lines[0].id, quantity: "3", reason: "Synthetic approval" },
    ],
    valuation: valuationSnapshot({
      purpose: "approval_estimate",
      currency: "SAR",
      amountMinor: 30000,
      rateToBase: "500",
      capturedAt: "2026-10-14T01:00:00Z",
      sourceRef: "synthetic quote",
    }),
  };
  expect(
    (
      await authedMutation(
        "/api/inventory/procurement",
        h.sessions.doctorA,
        "POST",
        operation("request.approve", { approval }),
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await authedMutation(
        "/api/inventory/procurement",
        admin,
        "POST",
        operation("request.approve", { approval }),
      )
    ).status,
  ).toBe(200);
  const o: PurchaseOrder = {
    id: randomUUID(),
    version: 1,
    branchId: "clinic",
    supplierPartyId: supplierId,
    currency: "SAR",
    shippingMinor: 0,
    discountMinor: 0,
    lines: [
      {
        id: randomUUID(),
        itemId,
        kind: "stock",
        quantity: "3",
        conversion: conversion(),
        price: {
          state: "known",
          currency: "SAR",
          unitPriceMinor: 10000,
          reason: "Synthetic quote",
        },
        trackLot: true,
        requiresExpiry: true,
        minimumShelfLifeDays: 30,
        sources: [
          {
            id: randomUUID(),
            requestId: r.id,
            requestLineId: r.lines[0].id,
            baseQuantity: "150",
          },
        ],
      },
    ],
  };
  expect(
    (
      await authedMutation(
        "/api/inventory/procurement",
        admin,
        "POST",
        operation("order.issue", { document: o }),
      )
    ).status,
  ).toBe(201);
  expect(await counts()).toEqual(before);
  const receipt: ReceiptRevision = {
    id: randomUUID(),
    version: 1,
    orderId: o.id,
    orderVersion: 1,
    branchId: "clinic",
    supplierPartyId: supplierId,
    actualArrivalDate: "2026-10-14",
    lines: [
      {
        orderLineId: o.lines[0].id,
        arrivedQuantity: "2",
        portions: [
          {
            id: randomUUID(),
            quantity: "2",
            disposition: "accepted",
            lotCode: "SYN-HTTP-LOT",
            expiryDate: "2027-11-01",
            locationId: location,
            damaged: false,
            reason: "Synthetic inspection",
          },
        ],
      },
    ],
  };
  const receiptBody = operation("receipt.post", { document: receipt });
  for (let retry = 0; retry < 2; retry++) {
    const response = await authedMutation(
      "/api/inventory/procurement",
      admin,
      "POST",
      receiptBody,
    );
    expect(response.status).toBe(201);
    expect(
      (await response.json()).remaining[0].remainingFulfillmentBaseQuantity,
    ).toBe("50");
  }
  const after = await counts();
  expect(after.stock - before.stock).toBe(1);
  expect(after.debt).toBe(before.debt);
  expect(after.cash).toBe(before.cash);
  const lineId = randomUUID();
  const invoice = {
    id: randomUUID(),
    version: 1,
    orderId: o.id,
    orderVersion: 1,
    branchId: "clinic",
    supplierPartyId: supplierId,
    currency: "SAR",
    invoiceNumber: missingNumber ? null : `SYN-${randomUUID()}`,
    invoiceDate: "2026-10-14",
    missingNumberReason: missingNumber
      ? "SYN official supplier number pending"
      : null,
    shippingMinor: 0,
    discountMinor: 0,
    valuation: valuationSnapshot({
      purpose: "invoice_valuation",
      currency: "SAR",
      amountMinor: 20000,
      rateToBase: "500",
      capturedAt: "2026-10-14T01:00:00Z",
      sourceRef: "synthetic invoice",
    }),
    lines: [
      {
        id: lineId,
        orderLineId: o.lines[0].id,
        quantity: "2",
        price: {
          state: "known",
          currency: "SAR",
          unitPriceMinor: 10000,
          reason: "Synthetic invoice",
        },
        receiptAllocations: [
          {
            id: randomUUID(),
            invoiceLineId: lineId,
            receiptLineId: receipt.lines[0].portions[0].id,
            baseQuantity: "100",
          },
        ],
      },
    ],
  };
  const matched = await authedMutation(
    "/api/inventory/procurement",
    admin,
    "POST",
    operation("invoice.match", { document: invoice }),
  );
  expect(matched.status).toBe(201);
  expect((await matched.json()).financialPosting).toBe(
    "pending_shared_finance_review",
  );
  expect(await counts()).toEqual(after);
  return { order: o, invoice };
}
async function openInvoice(width: number, orderId: string) {
  const context = await browser.newContext({
    viewport: { width, height: 900 },
  });
  context.setDefaultTimeout(15000);
  context.on("page", (p) => {
    p.on("pageerror", (e) => diagnostics.pageErrors.push(e.message));
    p.on("console", (m) => {
      if (m.type() === "error") diagnostics.consoleErrors.push(m.text());
    });
    p.on("requestfailed", (r) =>
      diagnostics.networkFailures.push({
        url: r.url(),
        error: r.failure()?.errorText ?? null,
      }),
    );
  });
  const [name, ...value] = admin.cookie.split("=");
  await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
  const page = await context.newPage();
  await page.goto(`${baseUrl}/inventory/procurement/operations`, {
    waitUntil: "domcontentloaded",
  });
  await page
    .getByLabel("أمر الشراء للفواتير", { exact: true })
    .selectOption(orderId);
  await page.getByTestId("supplier-finance-invoice").waitFor();
  return { context, page };
}
async function confirm(
  page: import("playwright").Page,
  action: "post" | "cancel",
  reason: string,
) {
  await page
    .getByTestId("supplier-finance-invoice")
    .getByRole("button", {
      name:
        action === "post"
          ? "ترحيل مستحق المورد"
          : "إلغاء الفاتورة غير المسدّدة",
      exact: true,
    })
    .click();
  const form = page.getByTestId("supplier-confirmation");
  await form.getByLabel("سبب العملية", { exact: true }).fill(reason);
  await form
    .getByRole("button", { name: "تأكيد العملية", exact: true })
    .click();
}
describe("signed supplier finance operational HTTP and UI", () => {
  it("old sessions reauthenticate; fresh doctor and revoked admin cannot enter supplier finance", async () => {
    const f = await fixture(),
      path = `/api/inventory/procurement?view=supplier-finance&orderId=${f.order.id}`;
    expect((await authedGet(path, h.sessions.admin)).status).toBe(401);
    const doctor = await loginStaff(
      TEST_USERS.doctorA.username,
      TEST_USERS.doctorA.password,
    );
    expect((await authedGet(path, doctor)).status).toBe(403);
    await db.query("UPDATE users SET is_active=FALSE WHERE id=$1", [adminId]);
    try {
      expect([401, 403]).toContain((await authedGet(path, admin)).status);
    } finally {
      await db.query("UPDATE users SET is_active=TRUE WHERE id=$1", [adminId]);
    }
    expect((await authedGet(path, admin)).status).toBe(200);
  });
  it.each([390, 1280])(
    "real login reviews, revises, posts and cancels unpaid supplier debt at %ipx",
    async (width) => {
      const f = await fixture(),
        before = await counts();
      const { context, page } = await openInvoice(width, f.order.id);
      try {
        await page
          .getByTestId("supplier-finance-invoice")
          .getByRole("button", { name: "مراجعة الإصدار", exact: true })
          .click();
        const editor = page.getByTestId("supplier-revision-form");
        await editor
          .getByLabel("سبب المراجعة", { exact: true })
          .fill(`SYN review ${width}`);
        await editor
          .getByRole("button", { name: "حفظ الإصدار الجديد", exact: true })
          .click();
        await page
          .getByTestId("supplier-finance-invoice")
          .getByRole("heading", {
            name: `${f.invoice.invoiceNumber} · إصدار 2`,
            exact: true,
          })
          .waitFor();
        await confirm(page, "post", `SYN reviewed posting ${width}`);
        await page
          .getByTestId("supplier-finance-invoice")
          .getByText("مستحق مُرحّل", { exact: true })
          .waitFor();
        expect(
          await page.getByTestId("supplier-finance-invoice").innerText(),
        ).toContain("200.00");
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        await page.screenshot({
          path: `${artifacts}/supplier-posted-ar-${width}.png`,
          fullPage: true,
        });
        await page
          .getByRole("link", { name: "كشف المورد والسداد", exact: true })
          .click();
        await page.waitForURL(`**/finance/parties/${supplierId}`);
        const payableRow = page
          .getByRole("listitem")
          .filter({ hasText: `Supplier invoice ${f.invoice.invoiceNumber}` });
        await payableRow
          .getByRole("button", { name: "سداد", exact: true })
          .waitFor();
        expect(await payableRow.innerText()).toContain("200.00");
        await page.goBack({ waitUntil: "domcontentloaded" });
        await page
          .getByLabel("أمر الشراء للفواتير", { exact: true })
          .selectOption(f.order.id);
        await page
          .getByTestId("supplier-finance-invoice")
          .getByText("مستحق مُرحّل", { exact: true })
          .waitFor();
        await confirm(
          page,
          "cancel",
          `SYN explicit unpaid cancellation ${width}`,
        );
        await page
          .getByTestId("supplier-finance-invoice")
          .getByText("ملغاة ماليًا", { exact: true })
          .waitFor();
        await page.screenshot({
          path: `${artifacts}/supplier-cancelled-ar-${width}.png`,
          fullPage: true,
        });
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        await page
          .getByRole("link", { name: "كشف المورد والسداد", exact: true })
          .click();
        await page.waitForURL(`**/finance/parties/${supplierId}`);
        await page.getByText("الحساب مسدّد", { exact: true }).waitFor();
        await page.goBack({ waitUntil: "domcontentloaded" });
        await page
          .getByLabel("أمر الشراء للفواتير", { exact: true })
          .selectOption(f.order.id);
        await page
          .getByTestId("supplier-finance-invoice")
          .getByText("ملغاة ماليًا", { exact: true })
          .waitFor();
        const after = await counts();
        expect(after).toEqual({ ...before, debt: before.debt + 1 });
        const view = await (
          await authedGet(
            `/api/inventory/procurement?view=supplier-finance&orderId=${f.order.id}`,
            admin,
          )
        ).json();
        expect(view.invoices[0]).toMatchObject({
          status: "cancelled",
          effectiveMinor: 0,
          settledMinor: 0,
        });
      } finally {
        await context.close();
      }
    },
  );
  it("lost admission and execution replies retain exact intent across reload, 403 and two tabs", async () => {
    const f = await fixture(),
      before = await counts();
    const { context, page } = await openInvoice(390, f.order.id);
    const admissions: string[] = [],
      executions: string[] = [];
    let refuse = true,
      abortAdmission = true,
      abortExecution = true;
    let finalReplies = 0,
      releaseReplies!: () => void;
    const bothReplies = new Promise<void>((resolve) => {
      releaseReplies = resolve;
    });
    await context.route("**/api/inventory/procurement", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      const raw = route.request().postData()!,
        body = JSON.parse(raw);
      if (body.command === "supplier.admit") {
        admissions.push(raw);
        const response = await route.fetch();
        expect(response.status()).toBe(201);
        if (abortAdmission) {
          abortAdmission = false;
          return route.abort();
        }
        return route.fulfill({ response });
      }
      if (body.command === "supplier.execute") {
        executions.push(raw);
        if (executions.length > 1 && refuse) {
          refuse = false;
          return route.fulfill({
            status: 403,
            contentType: "application/json",
            body: JSON.stringify({ code: "operation_forbidden" }),
          });
        }
        const response = await route.fetch();
        expect(response.status()).toBe(200);
        if (abortExecution) {
          abortExecution = false;
          return route.abort();
        }
        finalReplies++;
        if (finalReplies === 2) releaseReplies();
        await bothReplies;
        return route.fulfill({ response });
      }
      return route.continue();
    });
    try {
      await confirm(page, "post", "SYN lost replies exact command");
      await page
        .getByTestId("supplier-saved-intent")
        .getByRole("button", { name: "إعادة تأكيد العملية نفسها", exact: true })
        .waitFor();
      await page.waitForFunction(() => {
        const b = [...document.querySelectorAll("button")].find((x) =>
          x.textContent?.includes("إعادة تأكيد العملية نفسها"),
        );
        return b && !b.disabled;
      });
      await page.reload({ waitUntil: "domcontentloaded" });
      await page
        .getByLabel("أمر الشراء للفواتير", { exact: true })
        .selectOption(f.order.id);
      await page
        .getByRole("button", { name: "إعادة تأكيد العملية نفسها", exact: true })
        .click();
      await page
        .getByRole("button", { name: "إعادة تأكيد العملية نفسها", exact: true })
        .waitFor({ state: "visible" });
      await page.waitForFunction(() => {
        const b = [...document.querySelectorAll("button")].find((x) =>
          x.textContent?.includes("إعادة تأكيد العملية نفسها"),
        );
        return b && !b.disabled;
      });
      await page.reload({ waitUntil: "domcontentloaded" });
      await page
        .getByLabel("أمر الشراء للفواتير", { exact: true })
        .selectOption(f.order.id);
      await page
        .getByRole("button", { name: "إعادة تأكيد العملية نفسها", exact: true })
        .click();
      await page.waitForFunction(() => {
        const b = [...document.querySelectorAll("button")].find((x) =>
          x.textContent?.includes("إعادة تأكيد العملية نفسها"),
        );
        return b && !b.disabled;
      });
      expect(await page.getByTestId("supplier-saved-intent").count()).toBe(1);
      await page.screenshot({
        path: `${artifacts}/supplier-held-after-403-ar-390.png`,
        fullPage: true,
      });
      const second = await context.newPage();
      await second.goto(`${baseUrl}/inventory/procurement/operations`, {
        waitUntil: "domcontentloaded",
      });
      await second
        .getByRole("button", { name: "إعادة تأكيد العملية نفسها", exact: true })
        .waitFor();
      await Promise.all([
        page
          .getByRole("button", {
            name: "إعادة تأكيد العملية نفسها",
            exact: true,
          })
          .click(),
        second
          .getByRole("button", {
            name: "إعادة تأكيد العملية نفسها",
            exact: true,
          })
          .click(),
      ]);
      await Promise.all([
        page
          .getByTestId("supplier-saved-intent")
          .waitFor({ state: "detached" }),
        second
          .getByTestId("supplier-saved-intent")
          .waitFor({ state: "detached" }),
      ]);
      expect(admissions.length).toBeGreaterThanOrEqual(2);
      expect(new Set(admissions).size).toBe(1);
      expect(executions.length).toBeGreaterThanOrEqual(4);
      expect(new Set(executions).size).toBe(1);
      expect(await counts()).toEqual({ ...before, debt: before.debt + 1 });
    } finally {
      await context.close();
    }
  });
  it("preserves an unresolved legacy command while posting an independent invoice", async () => {
    const f = await fixture(),
      { context, page } = await openInvoice(1280, f.order.id);
    const legacy = await createInventoryRecoveryCommand(
      { actor: "secadmin", actorUserId: adminId, workspace: "operations" },
      "invoice.match",
      {
        document: {
          ...f.invoice,
          id: randomUUID(),
          invoiceNumber: "SYN held legacy invoice",
        },
      },
    );
    try {
      await page.evaluate(async (command) => {
        await new Promise<void>((resolve, reject) => {
          const request = indexedDB.open("aqlan-inventory-command-recovery", 1);
          request.onupgradeneeded = () =>
            request.result.createObjectStore("inventory-commands", {
              keyPath: "scope",
            });
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const db = request.result,
              tx = db.transaction("inventory-commands", "readwrite"),
              scope = JSON.stringify([command.actorUserId, command.workspace]);
            tx.objectStore("inventory-commands").put({
              scope,
              revision: 0,
              command,
            });
            tx.oncomplete = () => {
              db.close();
              resolve();
            };
            tx.onabort = () => reject(tx.error);
          };
        });
      }, legacy);
      await page.reload({ waitUntil: "domcontentloaded" });
      await page
        .getByLabel("أمر الشراء للفواتير", { exact: true })
        .selectOption(f.order.id);
      await page
        .getByText(
          "توجد عملية قديمة غير مؤكدة، وما زالت محفوظة في قسم الاسترداد. يمكنك متابعة فاتورة مستقلة هنا دون حذفها أو تغيير مفتاحها.",
          { exact: true },
        )
        .waitFor();
      await confirm(page, "post", "SYN independent invoice alongside legacy");
      await page
        .getByTestId("supplier-finance-invoice")
        .getByText("مستحق مُرحّل", { exact: true })
        .waitFor();
      const saved = await page.evaluate(
        async (key) =>
          new Promise<unknown>((resolve, reject) => {
            const r = indexedDB.open("aqlan-inventory-command-recovery", 1);
            r.onsuccess = () => {
              const db = r.result,
                t = db.transaction("inventory-commands", "readonly"),
                q = t.objectStore("inventory-commands").get(key);
              q.onsuccess = () => resolve(q.result.command);
              t.oncomplete = () => db.close();
            };
            r.onerror = () => reject(r.error);
          }),
        JSON.stringify([adminId, "operations"]),
      );
      expect(saved).toEqual(legacy);
      await page.screenshot({
        path: `${artifacts}/supplier-independent-legacy-held-ar-1280.png`,
        fullPage: true,
      });
    } finally {
      await context.close();
    }
  });
  it("lost explicit retirement reply is recovered by ordinary exact retry without debt", async () => {
    const f = await fixture(),
      before = await counts(),
      { context, page } = await openInvoice(390, f.order.id);
    let retired = false;
    await context.route("**/api/inventory/procurement", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      const body = JSON.parse(route.request().postData()!);
      if (body.command === "supplier.execute" && !retired)
        return route.fulfill({
          status: 403,
          contentType: "application/json",
          body: JSON.stringify({ code: "operation_forbidden" }),
        });
      if (body.command === "supplier.retire") {
        const response = await route.fetch();
        expect(response.status()).toBe(200);
        expect((await response.json()).status).toBe("retired");
        retired = true;
        return route.abort();
      }
      return route.continue();
    });
    try {
      await confirm(page, "post", "SYN stop uncommitted intent");
      const ready = () =>
        page.waitForFunction(() => {
          const b = [...document.querySelectorAll("button")].find((x) =>
            x.textContent?.includes("إعادة تأكيد العملية نفسها"),
          );
          return b && !b.disabled;
        });
      await ready();
      page.once("dialog", (dialog) =>
        dialog.accept("SYN explicit no-longer-required intent"),
      );
      await page
        .getByRole("button", { name: "إيقاف العملية غير المنفذة", exact: true })
        .click();
      await ready();
      await page.reload({ waitUntil: "domcontentloaded" });
      await page
        .getByRole("button", { name: "إعادة تأكيد العملية نفسها", exact: true })
        .click();
      await page
        .getByTestId("supplier-saved-intent")
        .waitFor({ state: "detached" });
      expect(await counts()).toEqual(before);
    } finally {
      await context.close();
    }
  });

  it("another browser's pending intent durably rejects a new nonce and recovers a lost refusal reply", async () => {
    const f = await fixture(),
      before = await counts();
    const view = await (
        await authedGet(
          `/api/inventory/procurement?view=supplier-finance&orderId=${f.order.id}`,
          admin,
        )
      ).json(),
      i = view.invoices[0];
    const original = {
      protocol: "inventory-supplier-v2",
      authority: view.authority,
      nonce: randomUUID(),
      action: "post",
      input: {
        invoiceId: i.invoiceId,
        expectedVersion: i.version,
        expectedDigest: i.digest,
        reason: "SYN original other-browser intent",
      },
    };
    const admitted = await authedMutation(
      "/api/inventory/procurement",
      admin,
      "POST",
      JSON.stringify({ command: "supplier.admit", intent: original }),
    );
    expect(admitted.status).toBe(201);
    const originalAdmission = await admitted.json();
    const { context, page } = await openInvoice(390, f.order.id);
    let lost = true;
    const attempts: string[] = [];
    await context.route("**/api/inventory/procurement", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      const raw = route.request().postData()!,
        body = JSON.parse(raw);
      expect(body.command).toBe("supplier.admit");
      attempts.push(raw);
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      expect((await response.json()).status).toBe("rejected");
      if (lost) {
        lost = false;
        return route.abort();
      }
      return route.fulfill({ response });
    });
    try {
      await confirm(page, "post", "SYN duplicate browser intent");
      await page.waitForFunction(() => {
        const b = [...document.querySelectorAll("button")].find((x) =>
          x.textContent?.includes("إعادة تأكيد العملية نفسها"),
        );
        return b && !b.disabled;
      });
      expect(
        await page
          .getByTestId("supplier-confirmation")
          .getByRole("button", { name: "تأكيد العملية", exact: true })
          .isDisabled(),
      ).toBe(true);
      await page.reload({ waitUntil: "domcontentloaded" });
      await page
        .getByRole("button", { name: "إعادة تأكيد العملية نفسها", exact: true })
        .click();
      await page
        .getByTestId("supplier-saved-intent")
        .waitFor({ state: "detached" });
      expect(attempts).toHaveLength(2);
      expect(attempts[0]).toBe(attempts[1]);
      expect(await counts()).toEqual(before);
      expect(
        (
          await db.query(
            "SELECT 1 FROM inventory_supplier_intents WHERE intent_nonce=$1",
            [original.nonce],
          )
        ).rowCount,
      ).toBe(1);
      expect(
        (
          await db.query(
            "SELECT 1 FROM inventory_operations WHERE operation_key=$1",
            [originalAdmission.envelope.operationKey],
          )
        ).rowCount,
      ).toBe(0);
    } finally {
      await context.close();
    }
  });
  it("old-epoch pending remains visible and blocks its invoice while independent work continues", async () => {
    const f = await fixture(),
      g = await fixture(),
      before = await counts();
    const view = await (
        await authedGet(
          `/api/inventory/procurement?view=supplier-finance&orderId=${f.order.id}`,
          admin,
        )
      ).json(),
      i = view.invoices[0];
    const intent = {
      protocol: "inventory-supplier-v2",
      authority: view.authority,
      nonce: randomUUID(),
      action: "post",
      input: {
        invoiceId: i.invoiceId,
        expectedVersion: i.version,
        expectedDigest: i.digest,
        reason: "SYN old epoch pending source",
      },
    };
    const response = await authedMutation(
      "/api/inventory/procurement",
      admin,
      "POST",
      JSON.stringify({ command: "supplier.admit", intent }),
    );
    expect(response.status).toBe(201);
    const admission = await response.json();
    const { context, page } = await openInvoice(1280, f.order.id);
    try {
      await page.evaluate(
        async (row) =>
          new Promise<void>((resolve, reject) => {
            const r = indexedDB.open("aqlan-inventory-supplier-recovery", 1);
            r.onupgradeneeded = () => r.result.createObjectStore("intents");
            r.onsuccess = () => {
              const db = r.result,
                t = db.transaction("intents", "readwrite");
              t.objectStore("intents").put(
                row,
                JSON.stringify([
                  row.intent.authority.realmId,
                  row.intent.authority.subjectId,
                  row.intent.nonce,
                ]),
              );
              t.oncomplete = () => {
                db.close();
                resolve();
              };
              t.onabort = () => reject(t.error);
            };
            r.onerror = () => reject(r.error);
          }),
        { intent, admission },
      );
      await db.query("BEGIN");
      try {
        await rotateStaffExecutionEpochInTransaction(
          db,
          "Synthetic browser restore epoch",
        );
        await db.query("COMMIT");
      } catch (e) {
        await db.query("ROLLBACK");
        throw e;
      }
      admin = await loginStaff(
        TEST_USERS.admin.username,
        TEST_USERS.admin.password,
      );
      const [name, ...value] = admin.cookie.split("=");
      await context.addCookies([
        { name, value: value.join("="), url: baseUrl },
      ]);
      await page.reload({ waitUntil: "domcontentloaded" });
      await page
        .getByLabel("أمر الشراء للفواتير", { exact: true })
        .selectOption(f.order.id);
      await page
        .getByRole("button", {
          name: "التحقق من النتيجة الأصلية فقط",
          exact: true,
        })
        .waitFor();
      expect(
        await page
          .getByTestId("supplier-finance-invoice")
          .getByRole("button", { name: "ترحيل مستحق المورد", exact: true })
          .isDisabled(),
      ).toBe(true);
      await page
        .getByRole("button", {
          name: "التحقق من النتيجة الأصلية فقط",
          exact: true,
        })
        .click();
      await page.waitForFunction(() => {
        const b = [...document.querySelectorAll("button")].find((x) =>
          x.textContent?.includes("التحقق من النتيجة الأصلية فقط"),
        );
        return b && !b.disabled;
      });
      expect(await page.getByTestId("supplier-saved-intent").count()).toBe(1);
      await page
        .getByLabel("أمر الشراء للفواتير", { exact: true })
        .selectOption(g.order.id);
      await page
        .getByTestId("supplier-finance-invoice")
        .getByRole("heading", {
          name: `${g.invoice.invoiceNumber} · إصدار 1`,
          exact: true,
        })
        .waitFor();
      await confirm(page, "post", "SYN independent after restore");
      await page
        .getByTestId("supplier-finance-invoice")
        .getByText("مستحق مُرحّل", { exact: true })
        .waitFor();
      expect(await page.getByTestId("supplier-saved-intent").count()).toBe(1);
      expect(await counts()).toEqual({ ...before, debt: before.debt + 1 });
      await page.screenshot({
        path: `${artifacts}/supplier-old-epoch-held-independent-ar-1280.png`,
        fullPage: true,
      });
    } finally {
      await context.close();
    }
  });
  it.each([390, 1280])(
    "completes official invoice number through reviewed revision and exact lost-reply recovery at %ipx",
    async (width) => {
      const f = await fixture(true),
        before = await counts(),
        official = `SYN-OFFICIAL-${width}-${randomUUID()}`;
      const { context, page } = await openInvoice(width, f.order.id);
      const writes: string[] = [];
      let lost = false;
      await context.route("**/api/inventory/procurement", async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        const raw = route.request().postData()!,
          body = JSON.parse(raw);
        if (
          body.command === "supplier.execute" &&
          body.admission.envelope.action === "revise"
        ) {
          writes.push(raw);
          const response = await route.fetch();
          expect(response.status()).toBe(200);
          if (!lost) {
            lost = true;
            return route.abort();
          }
          return route.fulfill({ response });
        }
        return route.continue();
      });
      try {
        expect(
          await page
            .getByTestId("supplier-finance-invoice")
            .getByRole("button", { name: "ترحيل مستحق المورد", exact: true })
            .isDisabled(),
        ).toBe(true);
        await page
          .getByRole("button", { name: "مراجعة الإصدار", exact: true })
          .click();
        const form = page.getByTestId("supplier-revision-form");
        await form
          .getByLabel(/^الرقم الرسمي المستكمل/)
          .fill(official);
        await form
          .getByLabel("سبب المراجعة", { exact: true })
          .fill("SYN reviewed original supplier document");
        expect(await form.innerText()).toContain(
          "SYN official supplier number pending",
        );
        await page.screenshot({
          path: `${artifacts}/supplier-official-number-review-ar-${width}.png`,
          fullPage: true,
        });
        await form
          .getByRole("button", { name: "حفظ الإصدار الجديد", exact: true })
          .click();
        await page.waitForFunction(() => {
          const b = [...document.querySelectorAll("button")].find((x) =>
            x.textContent?.includes("إعادة تأكيد العملية نفسها"),
          );
          return b && !b.disabled;
        });
        await page.reload({ waitUntil: "domcontentloaded" });
        await page
          .getByLabel("أمر الشراء للفواتير", { exact: true })
          .selectOption(f.order.id);
        await page
          .getByRole("button", {
            name: "إعادة تأكيد العملية نفسها",
            exact: true,
          })
          .click();
        await page
          .getByTestId("supplier-saved-intent")
          .waitFor({ state: "detached" });
        expect(writes).toHaveLength(2);
        expect(writes[0]).toBe(writes[1]);
        await page
          .getByTestId("supplier-finance-invoice")
          .getByRole("heading", { name: `${official} · إصدار 2`, exact: true })
          .waitFor();
        await confirm(page, "post", `SYN official number verified ${width}`);
        await page
          .getByTestId("supplier-finance-invoice")
          .getByText("مستحق مُرحّل", { exact: true })
          .waitFor();
        expect(
          await page.getByTestId("official-number-lineage").innerText(),
        ).toContain("SYN official supplier number pending");
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        await page.screenshot({
          path: `${artifacts}/supplier-official-number-posted-ar-${width}.png`,
          fullPage: true,
        });
        expect(await counts()).toEqual({ ...before, debt: before.debt + 1 });
        expect(
          (
            await db.query(
              "SELECT document FROM supplier_invoices WHERE id=$1",
              [f.invoice.id],
            )
          ).rows[0].document,
        ).toEqual(f.invoice);
        expect(
          (
            await db.query(
              "SELECT first_version,document FROM supplier_invoice_number_claims WHERE invoice_id=$1",
              [f.invoice.id],
            )
          ).rows[0],
        ).toMatchObject({
          first_version: 2,
          document: { invoiceNumber: official, missingNumberReason: null },
        });
      } finally {
        await context.close();
      }
    },
  );
});
