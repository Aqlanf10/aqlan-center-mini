/**
 * AUTHORED, NOT EXECUTED: proposed containment contract against the actual POST.
 * Stage at repository-root __tests__/lab-batch-post-containment.test.ts.
 * Session/DB boundaries are synthetic; Request, JSON decoding, byte limits,
 * NextResponse, roles, money and refusal helpers are real and are not mocked.
 * This is not evidence of PostgreSQL atomicity, proxy/CSRF, HTTP or Production.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => ({
  session: { username: "synthetic-admin", role: "admin", permissions: {} } as {
    username: string; role: string; permissions: Record<string, unknown>;
  } | null,
  requireSession: vi.fn(),
  ensureSchema: vi.fn(), getSettings: vi.fn(), ratesFromSettings: vi.fn(),
  settleLabOrdersBatch: vi.fn(), recordAudit: vi.fn(),
  listParties: vi.fn(), partyDueByCurrency: vi.fn(), listLabOrders: vi.fn(),
  listAppointmentsByDate: vi.fn(), findUserByUsername: vi.fn(),
}));
vi.mock("@/lib/session", () => ({ requireSession: boundary.requireSession }));
vi.mock("@/lib/db", () => ({ ...boundary, CLINIC_TIME_ZONE: "UTC" }));

import { POST } from "../app/api/finance/lab-reconciliation/route";
import { JSON_BODY_LIMIT_BYTES } from "../lib/security-limits";
import type { Currency } from "../lib/money";
import type { RateMap, SettlementQuote } from "../lib/supplier-payments";

const url = "http://test.invalid/api/finance/lab-reconciliation";
const settings = { syntheticSettingsRevision: "server-only" };
const serverRates: RateMap = { YER: 1, SAR: 140, USD: 535 };
const validBody = (changes: Record<string, unknown> = {}) => ({
  partyId: 7, orderIds: [11, 12], amountMinor: 20_000, currency: "YER", ...changes,
});
const makeRequest = (raw: string, headers: Record<string, string> = {}) => new Request(url, {
  method: "POST", headers: { "content-type": "application/json", ...headers }, body: raw,
});
const post = (changes: Record<string, unknown> = {}) => POST(makeRequest(JSON.stringify(validBody(changes))));

function writerSuccess(options: {
  currency?: Currency; exchangeRate?: number; baseAmountMinor?: number;
  orderIds?: number[]; rateOverrideReason?: string | null; prepayment?: boolean;
} = {}) {
  const quote: SettlementQuote = {
    paymentCurrency: options.currency ?? "YER", amountMinor: 20_000,
    paymentExchangeRate: options.exchangeRate ?? 1,
    baseAmountMinor: options.baseAmountMinor ?? 20_000,
    rateText: null, rateOverridden: Boolean(options.rateOverrideReason), payable: null,
    party: {
      id: 7, kind: "lab", guarded: true,
      outstandingBeforeMinor: options.prepayment ? 4_000 : 20_000,
      outstandingAfterMinor: options.prepayment ? -16_000 : 0,
      prepayment: options.prepayment ?? false,
    },
  };
  return {
    ok: true as const, partyName: "Synthetic selected lab", orderIds: options.orderIds ?? [11, 12], quote,
    // Only fields consumed by this route are needed at the mocked writer boundary.
    expense: {
      id: 71, voucherNumber: "SYN-0071", exchangeRate: options.exchangeRate ?? 1,
      baseAmountMinor: options.baseAmountMinor ?? 20_000,
      rateOverrideReason: options.rateOverrideReason ?? null,
    },
  };
}

function noWriterOrAudit() {
  expect(boundary.settleLabOrdersBatch).not.toHaveBeenCalled();
  expect(boundary.recordAudit).not.toHaveBeenCalled();
}
function noDatabaseAccess() {
  for (const call of [
    boundary.ensureSchema, boundary.getSettings, boundary.ratesFromSettings,
    boundary.listParties, boundary.partyDueByCurrency, boundary.listLabOrders,
    boundary.listAppointmentsByDate, boundary.findUserByUsername,
  ]) expect(call).not.toHaveBeenCalled();
  noWriterOrAudit();
}
async function expectBadInput(response: Response) {
  expect(response.status).toBe(400);
  const body = await response.json();
  expect(body.message).toEqual(expect.any(String));
  expect(body.message.trim().length).toBeGreaterThan(0);
  expect(body).not.toHaveProperty("ok", true);
  noWriterOrAudit();
}

beforeEach(() => {
  vi.resetAllMocks();
  boundary.session = { username: "synthetic-admin", role: "admin", permissions: {} };
  boundary.requireSession.mockImplementation(async () => boundary.session);
  boundary.ensureSchema.mockResolvedValue(undefined);
  boundary.getSettings.mockResolvedValue(settings);
  boundary.ratesFromSettings.mockReturnValue(serverRates);
  boundary.settleLabOrdersBatch.mockResolvedValue(writerSuccess());
  boundary.recordAudit.mockResolvedValue(undefined);
});

describe("lab batch POST admission before body and DB access", () => {
  it("returns 401 for an expired session before parsing an oversized malformed body", async () => {
    boundary.session = null;
    const request = makeRequest("{", { "content-length": String(JSON_BODY_LIMIT_BYTES + 1) });
    const response = await POST(request);
    expect(response.status).toBe(401);
    expect(request.bodyUsed).toBe(false);
    expect(boundary.requireSession).toHaveBeenCalledExactlyOnceWith();
    noDatabaseAccess();
  });

  const deniedRoles = ["doctor", "reception", "accountant", "cashier", "assistant"];
  const capabilities = [
    { viewSuppliers: false, viewReconciliation: false },
    { viewSuppliers: true, viewReconciliation: false },
    { viewSuppliers: false, viewReconciliation: true },
    { viewSuppliers: true, viewReconciliation: true },
  ];
  it.each(deniedRoles.flatMap((role) => capabilities.map((financeAccess) => ({ role, financeAccess }))))(
    "returns 403 for $role with $financeAccess despite cost visibility", async ({ role, financeAccess }) => {
      boundary.session = { username: "synthetic-user", role, permissions: { canViewCostPrices: true, financeAccess } };
      const request = makeRequest("{", { "content-length": String(JSON_BODY_LIMIT_BYTES + 1) });
      expect((await POST(request)).status).toBe(403);
      expect(request.bodyUsed).toBe(false);
      expect(boundary.requireSession).toHaveBeenCalledExactlyOnceWith();
      noDatabaseAccess();
    },
  );
});

describe("actual bounded JSON reader through POST", () => {
  it.each(["", "{", '{"partyId":7,}', "undefined"])("rejects empty or malformed JSON %j", async (raw) => {
    await expectBadInput(await POST(makeRequest(raw)));
    noDatabaseAccess();
  });

  it.each(["null", "[]", "[7,11]", "true", "123", '"scalar"'])("rejects non-object JSON %s", async (raw) => {
    await expectBadInput(await POST(makeRequest(raw)));
    noDatabaseAccess();
  });

  it("returns 413 from declared length before consuming a small, otherwise valid body", async () => {
    const request = makeRequest(JSON.stringify(validBody()), { "content-length": String(JSON_BODY_LIMIT_BYTES + 1) });
    expect((await POST(request)).status).toBe(413);
    expect(request.bodyUsed).toBe(false);
    noDatabaseAccess();
  });

  it.each<{ label: string; headers: Record<string, string> }>([
    { label: "absent", headers: {} }, { label: "misleading", headers: { "content-length": "1" } },
  ])("enforces actual UTF-8 bytes with $label content length", async ({ headers }) => {
    const raw = JSON.stringify(validBody({ padding: "é".repeat(Math.ceil(JSON_BODY_LIMIT_BYTES / 2) + 1) }));
    expect(new TextEncoder().encode(raw).byteLength).toBeGreaterThan(JSON_BODY_LIMIT_BYTES);
    const request = makeRequest(raw, headers);
    expect((await POST(request)).status).toBe(413);
    expect(request.bodyUsed).toBe(true);
    noDatabaseAccess();
  });

  it("accepts a valid object exactly at the byte limit", async () => {
    const prefixBytes = new TextEncoder().encode(JSON.stringify(validBody({ padding: "" }))).byteLength;
    const raw = JSON.stringify(validBody({ padding: "x".repeat(JSON_BODY_LIMIT_BYTES - prefixBytes) }));
    expect(new TextEncoder().encode(raw).byteLength).toBe(JSON_BODY_LIMIT_BYTES);
    expect((await POST(makeRequest(raw))).status).toBe(200);
    expect(boundary.settleLabOrdersBatch).toHaveBeenCalledTimes(1);
    expect(boundary.settleLabOrdersBatch.mock.calls[0][0]).not.toHaveProperty("padding");
  });
});

const invalidIds: { label: string; value: unknown }[] = [
  { label: "true", value: true }, { label: "false", value: false },
  { label: "object", value: { id: 11 } }, { label: "null", value: null },
  { label: "array coercible to an ID", value: [11] },
  { label: "fraction", value: 11.5 }, { label: "fraction string", value: "11.5" },
  { label: "zero", value: 0 }, { label: "negative", value: -11 },
  { label: "empty string", value: "" }, { label: "whitespace", value: " " },
  { label: "nonnumeric string", value: "invalid" },
  { label: "hexadecimal string", value: "0xb" }, { label: "exponent string", value: "11e0" },
  { label: "unsafe integer", value: Number.MAX_SAFE_INTEGER + 1 },
  { label: "unsafe integer string", value: "9007199254740993" },
  { label: "int4 overflow", value: 2_147_483_648 },
  { label: "int4 overflow string", value: "2147483648" },
];

describe("whole-selection ID validation and intentional normalization", () => {
  it.each(invalidIds)("rejects invalid partyId: $label", async ({ value }) => {
    await expectBadInput(await post({ partyId: value }));
    noDatabaseAccess();
  });

  it.each(invalidIds)("rejects an entire mixed selection containing $label, including prepayment", async ({ value }) => {
    await expectBadInput(await post({ orderIds: [11, value, 12], prepayment: true, prepaymentReason: "Synthetic explicit reason" }));
    noDatabaseAccess();
  });

  it.each([
    { label: "missing", value: undefined }, { label: "null", value: null },
    { label: "empty array", value: [] }, { label: "string", value: "11,12" },
    { label: "scalar number", value: 11 }, { label: "object", value: { first: 11 } },
  ])("rejects $label selection", async ({ value }) => {
    await expectBadInput(await post({ orderIds: value }));
    noDatabaseAccess();
  });

  it("normalizes decimal integer strings and preserves exactly the duplicate/permuted selected set", async () => {
    const response = await post({ partyId: "7", orderIds: ["12", 11, "11", 12] });
    expect(response.status).toBe(200);
    expect(boundary.settleLabOrdersBatch).toHaveBeenCalledTimes(1);
    const forwarded = boundary.settleLabOrdersBatch.mock.calls[0][0];
    expect(forwarded.partyId).toBe(7);
    expect(forwarded.orderIds.every((id: unknown) => typeof id === "number" && Number.isInteger(id))).toBe(true);
    expect([...new Set(forwarded.orderIds)].sort()).toEqual([11, 12]);
    // Sorting/deduplication may stay in the existing writer. Its returned IDs
    // remain authoritative for success/audit; actual PG proves one allocation.
    expect((await response.json()).settledCount).toBe(2);
    expect(boundary.recordAudit).toHaveBeenCalledTimes(1);
    expect(boundary.recordAudit.mock.calls[0][0].details).toMatchObject({ settledOrdersCount: 2, orderIds: [11, 12] });
  });

  it("accepts positive int4 boundary IDs without narrowing them further", async () => {
    boundary.settleLabOrdersBatch.mockResolvedValue(writerSuccess({ orderIds: [2_147_483_647] }));
    expect((await post({ partyId: "2147483647", orderIds: [2_147_483_647] })).status).toBe(200);
    expect(boundary.settleLabOrdersBatch.mock.calls[0][0]).toMatchObject({ partyId: 2_147_483_647, orderIds: [2_147_483_647] });
  });
});

describe("safe minor-unit and currency request admission", () => {
  it.each([
    { label: "zero", value: 0 }, { label: "negative", value: -1 },
    { label: "fraction", value: 20_000.5 }, { label: "fraction string", value: "20000.5" },
    { label: "unsafe integer", value: Number.MAX_SAFE_INTEGER + 1 },
    { label: "unsafe integer string", value: "9007199254740993" },
    { label: "boolean", value: true }, { label: "coercible array", value: [20_000] },
    { label: "object", value: {} }, { label: "null", value: null },
    { label: "empty", value: "" }, { label: "missing", value: undefined },
  ])("rejects amountMinor $label without writer/audit", async ({ value }) => {
    await expectBadInput(await post({ amountMinor: value }));
    noDatabaseAccess();
  });

  it.each(["1e999", "-1e999"])("rejects non-finite amount decoded from JSON numeric literal %s", async (literal) => {
    const raw = JSON.stringify(validBody()).replace('"amountMinor":20000', `"amountMinor":${literal}`);
    await expectBadInput(await POST(makeRequest(raw)));
    noDatabaseAccess();
  });

  it("preserves a supported decimal integer amount string as a numeric safe minor-unit amount", async () => {
    expect((await post({ amountMinor: "20000" })).status).toBe(200);
    expect(boundary.settleLabOrdersBatch.mock.calls[0][0].amountMinor).toBe(20_000);
  });

  it.each([undefined, null, "", "EUR", "usd", true, { currency: "YER" }])("rejects invalid currency %j", async (currency) => {
    await expectBadInput(await post({ currency }));
    noDatabaseAccess();
  });

  it.each([undefined, null, "", "  ", "ab", 123])("requires a written prepayment reason, got %j", async (prepaymentReason) => {
    await expectBadInput(await post({ prepayment: true, prepaymentReason }));
    noDatabaseAccess();
  });
});

describe("finite positive rates with server provenance", () => {
  it.each([
    { label: "zero", value: 0 }, { label: "negative", value: -1 },
    { label: "boolean", value: true }, { label: "object", value: {} },
    { label: "array", value: [] }, { label: "nonnumeric string", value: "not-a-rate" },
  ])("rejects an explicitly invalid exchange rate: $label", async ({ value }) => {
    await expectBadInput(await post({ currency: "USD", exchangeRate: value, rateOverrideReason: "Synthetic explicit override" }));
  });

  it.each(["1e999", "-1e999"])("rejects non-finite exchange rate parsed from literal %s", async (literal) => {
    const raw = JSON.stringify(validBody({ currency: "USD", exchangeRate: 540, rateOverrideReason: "Synthetic explicit override" }))
      .replace('"exchangeRate":540', `"exchangeRate":${literal}`);
    await expectBadInput(await POST(makeRequest(raw)));
  });

  it.each([undefined, null, "", "  ", "ab", 123])("requires an explicit written reason for a different valid foreign rate: %j", async (rateOverrideReason) => {
    await expectBadInput(await post({ currency: "USD", exchangeRate: 540, rateOverrideReason }));
  });

  it.each([undefined, 535])("uses the settings rate when the caller supplies %j and cannot replace the rates map", async (exchangeRate) => {
    boundary.settleLabOrdersBatch.mockResolvedValue(writerSuccess({ currency: "USD", exchangeRate: 535, baseAmountMinor: 107_000 }));
    expect((await post({ currency: "USD", exchangeRate, rates: { USD: 1 }, baseCurrency: "USD", rateOverrideReason: "Unused caller reason" })).status).toBe(200);
    expect(boundary.getSettings).toHaveBeenCalledExactlyOnceWith();
    expect(boundary.ratesFromSettings).toHaveBeenCalledExactlyOnceWith(settings);
    expect(boundary.settleLabOrdersBatch.mock.calls[0][0]).toMatchObject({
      baseCurrency: "YER", exchangeRate: 535, rates: serverRates, rateOverrideReason: null,
    });
    expect(boundary.settleLabOrdersBatch.mock.calls[0][0].rates).toBe(serverRates);
    expect(boundary.recordAudit).toHaveBeenCalledTimes(1);
  });

  it("accepts a finite positive fractional override rate instead of applying minor-unit integer rules to rates", async () => {
    boundary.settleLabOrdersBatch.mockResolvedValue(writerSuccess({
      currency: "USD", exchangeRate: 540.25, baseAmountMinor: 108_050, rateOverrideReason: "Synthetic fractional rate",
    }));
    expect((await post({ currency: "USD", exchangeRate: 540.25, rateOverrideReason: "Synthetic fractional rate" })).status).toBe(200);
    expect(boundary.settleLabOrdersBatch.mock.calls[0][0]).toMatchObject({ exchangeRate: 540.25, rates: serverRates });
    expect(boundary.recordAudit).toHaveBeenCalledTimes(2);
    expect(boundary.recordAudit.mock.calls[1][0]).toMatchObject({
      action: "expense.rate_override", details: { سعر_الإعدادات: 535, السعر_المستعمل: 540.25, السبب: "Synthetic fractional rate" },
    });
  });

  it("keeps the base-currency rate constitutional even when a different finite positive rate is supplied", async () => {
    expect((await post({ exchangeRate: 540, baseCurrency: "USD", rateOverrideReason: "Unused caller reason" })).status).toBe(200);
    expect(boundary.settleLabOrdersBatch.mock.calls[0][0]).toMatchObject({ baseCurrency: "YER", exchangeRate: 1, rateOverrideReason: null });
    expect(boundary.recordAudit).toHaveBeenCalledTimes(1);
  });

  it.each([
    { label: "missing", value: undefined }, { label: "zero", value: 0 },
    { label: "negative", value: -1 }, { label: "infinite", value: Number.POSITIVE_INFINITY },
    { label: "NaN", value: Number.NaN },
  ])("refuses $label saved USD rate without writer/audit", async ({ value }) => {
    boundary.ratesFromSettings.mockReturnValue({ YER: 1, USD: value });
    const response = await post({ currency: "USD" });
    expect(response.status).toBe(409);
    expect((await response.json()).message).toEqual(expect.any(String));
    noWriterOrAudit();
  });

  it("allows an explicitly reasoned valid override when the settings rate is missing", async () => {
    const missingRates: RateMap = { YER: 1 };
    boundary.ratesFromSettings.mockReturnValue(missingRates);
    boundary.settleLabOrdersBatch.mockResolvedValue(writerSuccess({
      currency: "USD", exchangeRate: 540, baseAmountMinor: 108_000, rateOverrideReason: "Synthetic approved rate",
    }));
    expect((await post({ currency: "USD", exchangeRate: 540, rateOverrideReason: "  Synthetic approved rate  " })).status).toBe(200);
    expect(boundary.settleLabOrdersBatch.mock.calls[0][0]).toMatchObject({
      exchangeRate: 540, rates: missingRates, rateOverrideReason: "Synthetic approved rate",
    });
    expect(boundary.recordAudit).toHaveBeenCalledTimes(2);
    expect(boundary.recordAudit.mock.calls[1][0]).toMatchObject({
      action: "expense.rate_override", details: { سعر_الإعدادات: null, السعر_المستعمل: 540, السبب: "Synthetic approved rate" },
    });
  });
});

const batchRefusals = ["batch_link_invalid", "batch_currency_mismatch", "batch_requires_full_allocation", "batch_busy"] as const;

describe("explicit short batch 409s expose no foreign quote and create no audits", () => {
  it.each(batchRefusals.flatMap((reason) => [false, true].map((prepayment) => ({ reason, prepayment }))))(
    "$reason remains a refusal with prepayment=$prepayment", async ({ reason, prepayment }) => {
      // Deliberately poison the synthetic result to prove the response mapping is
      // an allowlist, not a pass-through of foreign IDs/financial data.
      boundary.settleLabOrdersBatch.mockResolvedValue({
        ok: false, reason, orderIds: [987_654_321], partyName: "FOREIGN_PRIVATE_LAB",
        quote: {
          ...writerSuccess().quote, amountMinor: 777_777_777,
          payable: { id: 987_654_320, remainingBeforeMinor: 777_777_777, secret: "FOREIGN_FINANCIAL_DETAIL" },
          party: { id: 987_654_319, outstandingBeforeMinor: 777_777_777, prepayment: true },
        },
      });
      const response = await post({
        currency: "USD", exchangeRate: 540, rateOverrideReason: "Synthetic explicit override",
        prepayment, prepaymentReason: "Synthetic explicit prepayment",
      });
      const body = await response.json();
      expect(response.status).toBe(409);
      expect(Object.keys(body).every((key) => ["code", "message", "quote", "orderIds"].includes(key))).toBe(true);
      if (body.orderIds !== undefined) {
        expect(Array.isArray(body.orderIds)).toBe(true);
        expect(body.orderIds.length).toBeLessThanOrEqual(2);
        expect(body.orderIds.every((id: unknown) => id === 11 || id === 12)).toBe(true);
      }
      expect(body.code).toBe(reason);
      expect(body.quote).toBeNull();
      expect(body.message).toEqual(expect.any(String));
      expect(body.message.trim().length).toBeGreaterThan(0);
      expect(body.message.length).toBeLessThanOrEqual(240);
      expect(JSON.stringify(body)).not.toMatch(/FOREIGN_|9876543|777777777|payable|partyName|outstanding|totalPaidMinor|settledCount/);
      expect(boundary.settleLabOrdersBatch).toHaveBeenCalledTimes(1);
      expect(boundary.recordAudit).not.toHaveBeenCalled();
    },
  );

  it.each([
    { reason: "not_lab", status: 404 }, { reason: "orders_invalid", status: 409 },
    { reason: "orders_cancelled", status: 409 }, { reason: "orders_already_paid", status: 409 },
    { reason: "no_shift", status: 409 }, { reason: "missing_rate", status: 409 },
    { reason: "exceeds_party_balance", status: 409 },
  ])("retains established $reason refusal status and suppresses every audit", async ({ reason, status }) => {
    boundary.settleLabOrdersBatch.mockResolvedValue({ ok: false, reason, orderIds: [11], quote: null });
    const response = await post({ prepayment: true, prepaymentReason: "Synthetic explicit reason" });
    const body = await response.json();
    expect(response.status).toBe(status);
    expect(body.code).toBe(reason);
    expect(body.message).toEqual(expect.any(String));
    expect(body.quote).toBeNull();
    expect(body).not.toHaveProperty("ok", true);
    expect(boundary.recordAudit).not.toHaveBeenCalled();
  });
});

describe("successful full-batch forwarding and audit compatibility", () => {
  it("forwards exact server-owned actor, rate and normalized text fields and preserves the success shape", async () => {
    const response = await post({
      monthLabel: "  2026-10  ", note: "  Synthetic batch note  ",
      createdBy: "spoofed-user", actorRole: "doctor", baseCurrency: "USD", rates: { YER: 999 },
      prepayment: false, prepaymentReason: "Unused caller reason", rateOverrideReason: "Unused caller reason",
      requestId: "unused-token",
    });
    expect(response.status).toBe(200);
    expect(boundary.ensureSchema).toHaveBeenCalledExactlyOnceWith();
    expect(boundary.getSettings).toHaveBeenCalledExactlyOnceWith();
    expect(boundary.ratesFromSettings).toHaveBeenCalledExactlyOnceWith(settings);
    expect(boundary.settleLabOrdersBatch).toHaveBeenCalledExactlyOnceWith({
      partyId: 7, orderIds: [11, 12], amountMinor: 20_000, currency: "YER", baseCurrency: "YER", exchangeRate: 1,
      note: "Synthetic batch note", monthLabel: "2026-10", createdBy: "synthetic-admin", actorRole: "admin",
      rates: serverRates, rateOverrideReason: null, prepaymentReason: null,
    });
    expect(boundary.ensureSchema.mock.invocationCallOrder[0]).toBeLessThan(boundary.getSettings.mock.invocationCallOrder[0]);
    expect(boundary.getSettings.mock.invocationCallOrder[0]).toBeLessThan(boundary.settleLabOrdersBatch.mock.invocationCallOrder[0]);
    expect(boundary.settleLabOrdersBatch.mock.invocationCallOrder[0]).toBeLessThan(boundary.recordAudit.mock.invocationCallOrder[0]);
    expect(boundary.recordAudit).toHaveBeenCalledExactlyOnceWith({
      action: "expense.create", actor: "synthetic-admin", actorRole: "admin", entity: "expense",
      entityId: 71, entityLabel: "SYN-0071",
      details: {
        type: "lab_batch_reconciliation", partyId: 7, partyName: "Synthetic selected lab", voucherNumber: "SYN-0071",
        settledOrdersCount: 2, orderIds: [11, 12], amountMinor: 20_000, currency: "YER", سعر_الدفع: 1, المكافئ: 20_000,
      },
    });
    expect(await response.json()).toEqual({
      ok: true, voucherNumber: "SYN-0071", expenseId: 71, settledCount: 2,
      totalPaidMinor: 20_000, currency: "YER",
      message: "تم بنجاح سداد وتسوية 2 أمر مختبر بسند صرف رقم SYN-0071.",
    });
    for (const read of [boundary.listParties, boundary.partyDueByCurrency, boundary.listLabOrders, boundary.listAppointmentsByDate, boundary.findUserByUsername]) {
      expect(read).not.toHaveBeenCalled();
    }
  });

  it.each([
    { override: false, prepayment: false }, { override: true, prepayment: false },
    { override: false, prepayment: true }, { override: true, prepayment: true },
  ])("keeps exactly applicable audit payloads for override=$override prepayment=$prepayment", async ({ override, prepayment }) => {
    const rate = override ? 540 : 535;
    const baseAmount = override ? 108_000 : 107_000;
    const overrideReason = "Synthetic rate reason";
    const prepaymentReason = "Synthetic credit exception";
    boundary.settleLabOrdersBatch.mockResolvedValue(writerSuccess({
      currency: "USD", exchangeRate: rate, baseAmountMinor: baseAmount,
      rateOverrideReason: override ? overrideReason : null, prepayment,
    }));
    const response = await post({
      currency: "USD", exchangeRate: rate, rateOverrideReason: `  ${overrideReason}  `,
      prepayment, prepaymentReason: `  ${prepaymentReason}  `,
    });
    expect(response.status).toBe(200);
    expect(boundary.settleLabOrdersBatch).toHaveBeenCalledExactlyOnceWith({
      partyId: 7, orderIds: [11, 12], amountMinor: 20_000, currency: "USD", baseCurrency: "YER", exchangeRate: rate,
      note: null, monthLabel: undefined, createdBy: "synthetic-admin", actorRole: "admin", rates: serverRates,
      rateOverrideReason: override ? overrideReason : null, prepaymentReason: prepayment ? prepaymentReason : null,
    });
    const expectedAudits: Record<string, unknown>[] = [{
      action: "expense.create", actor: "synthetic-admin", actorRole: "admin", entity: "expense", entityId: 71, entityLabel: "SYN-0071",
      details: {
        type: "lab_batch_reconciliation", partyId: 7, partyName: "Synthetic selected lab", voucherNumber: "SYN-0071",
        settledOrdersCount: 2, orderIds: [11, 12], amountMinor: 20_000, currency: "USD", سعر_الدفع: rate, المكافئ: baseAmount,
      },
    }];
    if (override) expectedAudits.push({
      action: "expense.rate_override", entity: "expense", entityId: 71, entityLabel: "SYN-0071",
      details: { العملة: "USD", سعر_الإعدادات: 535, السعر_المستعمل: rate, السبب: overrideReason },
      actor: "synthetic-admin", actorRole: "admin",
    });
    if (prepayment) expectedAudits.push({
      action: "expense.prepayment", entity: "expense", entityId: 71, entityLabel: "SYN-0071",
      details: { الجهة: 7, المبلغ: 20_000, العملة: "USD", المستحق_قبل: 4_000, السبب: prepaymentReason },
      actor: "synthetic-admin", actorRole: "admin",
    });
    expect(boundary.recordAudit.mock.calls).toEqual(expectedAudits.map((audit) => [audit]));
    expect(await response.json()).toEqual({
      ok: true, voucherNumber: "SYN-0071", expenseId: 71, settledCount: 2, totalPaidMinor: 20_000, currency: "USD",
      message: "تم بنجاح سداد وتسوية 2 أمر مختبر بسند صرف رقم SYN-0071.",
    });
  });

  it("trims and bounds both explicit reasons to the existing 300-character persistence contract", async () => {
    const reason = "r".repeat(320);
    boundary.settleLabOrdersBatch.mockResolvedValue(writerSuccess({
      currency: "USD", exchangeRate: 540, baseAmountMinor: 108_000, rateOverrideReason: reason.slice(0, 300), prepayment: true,
    }));
    expect((await post({
      currency: "USD", exchangeRate: 540, rateOverrideReason: `  ${reason}  `,
      prepayment: true, prepaymentReason: `  ${reason}  `,
    })).status).toBe(200);
    expect(boundary.settleLabOrdersBatch.mock.calls[0][0]).toMatchObject({
      rateOverrideReason: reason.slice(0, 300), prepaymentReason: reason.slice(0, 300),
    });
    expect(boundary.recordAudit.mock.calls[1][0].details.السبب).toBe(reason.slice(0, 300));
    expect(boundary.recordAudit.mock.calls[2][0].details.السبب).toBe(reason.slice(0, 300));
  });
});
