import { createElement, type ComponentProps, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InvoiceSettlementStatus, PatientLedger } from "../components/PatientLedger";
import { CollectPaymentModal } from "../components/CollectPaymentModal";
import { LegacyBalanceArrangementPanel } from "../components/LegacyBalanceArrangementPanel";
import type { SessionInfo } from "../components/SessionProvider";
import { formatMoney, patientBalancesByCurrency, toCurrencyPaymentLikes } from "../lib/money";
import { planItemsProgress, planLedgerSummary, planProgress } from "../lib/plans";
import { legacyArrangementProgress } from "../lib/legacy-balance-arrangements";
import type { Invoice as DbInvoice, Payment as DbPayment, OpeningBalance as DbOpening } from "../lib/db";
import type { LegacyBalanceArrangementView as DbArrangement, LegacyOpeningPosition as DbLegacyOpening } from "../lib/legacy-balance-arrangements-db";

// Actual component/read handlers with synthetic React/session/GET boundaries.
// The markup tests render the very same invoice-status component used by Account.
const hooks = vi.hoisted(() => ({
  values: [] as unknown[], cursor: 0, changed: false, lateUpdates: 0,
  effects: new Map<number, { deps?: readonly unknown[]; cleanup?: () => void }>(),
  memos: new Map<number, { deps?: readonly unknown[]; value: unknown }>(),
  pending: [] as Array<() => void>, session: null as SessionInfo | null,
}));
vi.mock("../components/SessionProvider", () => ({ useSession: () => hooks.session }));
vi.mock("../components/ServiceSelect", () => ({ ServiceSelect: () => null }));
vi.mock("../components/CollectPaymentModal", () => ({ CollectPaymentModal: () => null }));
vi.mock("../components/InvoiceCorrection", () => ({ InvoiceCorrection: () => null }));
vi.mock("../components/ReceiptCorrection", () => ({ ReceiptCorrection: () => null }));
vi.mock("../components/LegacyBalanceArrangementPanel", () => ({ LegacyBalanceArrangementPanel: () => null }));
vi.mock("../components/LegacyMoneyGuidance", () => ({ OpeningBalanceGuidance: () => null }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const slot = (initial: unknown) => { const index = hooks.cursor++; if (!(index in hooks.values)) hooks.values[index] = initial; return index; };
  const same = (a?: readonly unknown[], b?: readonly unknown[]) => !!a && !!b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const memo = (factory: () => unknown, deps?: readonly unknown[]) => {
    const index = slot(undefined); const previous = hooks.memos.get(index);
    if (previous && same(previous.deps, deps)) return previous.value;
    const value = factory(); hooks.memos.set(index, { deps, value }); return value;
  };
  const effect = (callback: () => void | (() => void), deps?: readonly unknown[]) => {
    const index = slot(undefined); const previous = hooks.effects.get(index);
    if (previous && same(previous.deps, deps)) return;
    hooks.pending.push(() => { previous?.cleanup?.(); const cleanup = callback(); hooks.effects.set(index, { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined }); });
  };
  return { ...react,
    useState: (initial: unknown) => {
      const index = slot(typeof initial === "function" ? initial() : initial); const values = hooks.values;
      return [values[index], (value: unknown) => {
        if (values !== hooks.values) hooks.lateUpdates++;
        const next = typeof value === "function" ? value(values[index]) : value;
        if (values === hooks.values && !Object.is(next, values[index])) hooks.changed = true;
        values[index] = next;
      }];
    },
    useRef: (initial: unknown) => hooks.values[slot({ current: initial })],
    useCallback: (callback: unknown, deps?: readonly unknown[]) => memo(() => callback, deps),
    useMemo: memo, useEffect: effect,
  };
});

type StatusProps = ComponentProps<typeof InvoiceSettlementStatus>;
const invoice = (overrides: Partial<StatusProps["invoice"]> = {}): StatusProps["invoice"] => ({
  id: 61, patientId: 201, invoiceNumber: "SYNTH-INV-61", status: "paid", totalMinor: 10000, discountMinor: 0,
  baseCurrency: "SAR", note: null, createdAt: "2026-10-04T10:00:00Z", items: [], ...overrides,
});
const recovery = (overrides: Record<string, unknown> = {}) => ({
  kind: "recoverable", purpose: "reversed-installment-recovery", patientId: 201, invoiceId: 61, planId: 21,
  originPaymentId: 101, creationAuditId: 501, currency: "SAR", rawInvoiceStatus: "paid",
  principalMinor: 10000, linkedNetPaidMinor: 0, remainingMinor: 10000, actualAccountDueMinor: 14000,
  suggestedCashMinor: 10000, accountCreditReview: false, reversalPaymentIds: [102], ...overrides,
});
const envelope = (row = recovery()) => ({ recoveries: [row], reviews: [] });
const renderStatus = (evidence: unknown = envelope(), changes: Partial<StatusProps> = {}) => renderToStaticMarkup(createElement(InvoiceSettlementStatus, {
  invoice: invoice(), patientId: 201, evidence, ready: true, ...changes,
}));
const remainderLabel = "متبقٍ مرتبط بالفاتورة بعد عكس السداد";
const unavailableLabel = "تعذّر التحقق من حالة السداد";
const reviewLabel = "حالة السداد تحتاج مراجعة";

beforeEach(() => {
  hooks.values = []; hooks.cursor = 0; hooks.changed = false; hooks.lateUpdates = 0;
  hooks.effects.clear(); hooks.memos.clear(); hooks.pending = [];
  hooks.session = { username: "synthetic-admin-a", role: "admin" };
  patientId = 201; key = null; fetchMock.mockReset();
  read = async () => response(payload());
  readServices = async () => response([]);
  fetchMock.mockImplementation((url: string, options?: RequestInit) => {
    if (options?.method && options.method !== "GET") throw new Error("Unexpected mutation");
    if (url === "/api/services") return readServices();
    if (/^\/api\/patients\/\d+\/ledger$/.test(url)) return read();
    throw new Error(`Unexpected read ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  retire();
  expect(fetchMock.mock.calls.every(([, options]) => !options?.method || options.method === "GET")).toBe(true);
  vi.unstubAllGlobals();
});

describe("actual invoice settlement status markup", () => {
  it("contains evidence-bearing status in one inline block without changing ordinary status layout", () => {
    for (const evidence of [envelope(), { recoveries: [], reviews: [{ invoiceId: 61, planId: 21, reason: "review" }] }, null]) {
      expect(renderStatus(evidence)).toContain('class="inline-block max-w-full align-top"');
    }
    expect(renderStatus(envelope(), { ready: false })).toContain('class="inline-block max-w-full align-top"');
    for (const html of [renderStatus({ recoveries: [], reviews: [] }), renderStatus(null, { invoice: invoice({ status: "cancelled" }) })]) {
      expect(html).not.toContain("inline-block");
    }
  });
  it.each([10000, 4000, 1500])("renders only the canonical %i-minor linked remainder and retains recorded status", (remainingMinor) => {
    const data = envelope(recovery({ remainingMinor, linkedNetPaidMinor: 10000 - remainingMinor, suggestedCashMinor: remainingMinor }));
    const before = structuredClone(data); const html = renderStatus(data);
    expect(html).toContain(remainderLabel); expect(html).toContain(formatMoney(remainingMinor, "SAR"));
    expect(html).toContain("الحالة المسجلة: مسدّدة"); expect(html).toContain("رصيد الحساب بعملته هو المرجع للمستحق الحالي");
    expect(html).not.toContain("<button"); expect(data).toEqual(before);
  });
  it.each([3000, 0, -2000])("does not describe linked remainder as collectible when account due is %i", (due) => {
    const html = renderStatus(envelope(recovery({ actualAccountDueMinor: due, suggestedCashMinor: Math.max(0, due), accountCreditReview: true })));
    expect(html).toContain(formatMoney(10000, "SAR"));
    expect(html).toContain("المتبقي المرتبط بالفاتورة ليس مبلغًا للتحصيل؛ راجع رصيد الحساب بعملته");
    expect(html).not.toContain("<button"); expect(html).not.toContain("تحصيل قسط");
  });
  it.each(["missing_creation_provenance", "historical_plan_attribution_gap", "future_review_reason"])("renders %s conservatively without inventing an amount", (reason) => {
    const html = renderStatus({ recoveries: [], reviews: [{ invoiceId: 61, planId: 21, reason }] });
    expect(html).toContain(reviewLabel); expect(html).toContain("الحالة المسجلة: مسدّدة");
    expect(html).not.toContain(remainderLabel); expect(html).not.toContain(formatMoney(10000, "SAR")); expect(html).not.toContain(reason);
  });
  it("cancelled status wins over stale recovery, review and malformed evidence", () => {
    for (const evidence of [envelope(), { recoveries: [], reviews: [{ invoiceId: 61, planId: 21, reason: "review" }] }, null]) {
      const html = renderStatus(evidence, { invoice: invoice({ status: "cancelled" }), ready: false });
      expect(html).toContain("ملغاة"); expect(html).not.toContain("الحالة المسجلة");
      expect(html).not.toContain(remainderLabel); expect(html).not.toContain(reviewLabel); expect(html).not.toContain(unavailableLabel);
    }
  });
  it.each(["open", "paid"] as const)("absent evidence preserves %s manual/corrected behavior without inferring settlement", (status) => {
    for (const evidence of [undefined, { recoveries: [], reviews: [] }, envelope(recovery({ invoiceId: 999 }))]) {
      const html = renderStatus(evidence, { invoice: invoice({ status }), evidence });
      expect(html).toContain(status === "paid" ? "مسدّدة" : "مفتوحة");
      expect(html).not.toContain("الحالة المسجلة"); expect(html).not.toContain(remainderLabel); expect(html).not.toContain(reviewLabel);
    }
  });
  it("does not assume a reopened issued invoice is paid", () => {
    const html = renderStatus(envelope(recovery({ rawInvoiceStatus: "open" })), { invoice: invoice({ status: "open" }) });
    expect(html).toContain("الحالة المسجلة: مفتوحة"); expect(html).toContain(remainderLabel); expect(html).not.toContain("مسدّدة");
  });
  it("refuses equal but unknown raw/displayed invoice statuses", () => {
    const html = renderStatus(envelope(recovery({ rawInvoiceStatus: "future-status" })), {
      invoice: invoice({ status: "future-status" as StatusProps["invoice"]["status"] }),
    });
    expect(html).toContain(unavailableLabel); expect(html).not.toContain(remainderLabel);
  });
  it.each([null, {}, { recoveries: [] }, { recoveries: {}, reviews: [] }, { recoveries: [null], reviews: [] }, { recoveries: [], reviews: [{ reason: "lost identity" }] }])("does not turn malformed envelope %j into settled/zero", (data) => {
    const html = renderStatus(data); expect(html).toContain(unavailableLabel);
    expect(html).toContain("الحالة المسجلة: مسدّدة"); expect(html).not.toContain(remainderLabel); expect(html).not.toContain(formatMoney(0, "SAR"));
  });
  it.each([
    { kind: "future-kind" }, { purpose: "ordinary" }, { patientId: 202 }, { currency: "USD" }, { currency: "BAD" },
    { rawInvoiceStatus: "open" }, { principalMinor: 11000 }, { principalMinor: Number.MAX_SAFE_INTEGER + 1 },
    { linkedNetPaidMinor: -1 }, { remainingMinor: 0 }, { remainingMinor: -1 }, { remainingMinor: 1.5 },
    { linkedNetPaidMinor: 1 }, { actualAccountDueMinor: 1.5 }, { actualAccountDueMinor: Number.NaN },
    { suggestedCashMinor: 10001 }, { suggestedCashMinor: -1 }, { accountCreditReview: true },
    { accountCreditReview: "false" }, { reversalPaymentIds: [] }, { reversalPaymentIds: [102, 102] },
    { reversalPaymentIds: [0] }, { planId: null }, { originPaymentId: 0 }, { creationAuditId: 0 },
  ])("refuses mismatched or unsafe projection %j", (changes) => {
    const html = renderStatus(envelope(recovery(changes))); expect(html).toContain(unavailableLabel);
    expect(html).not.toContain(remainderLabel); expect(html).not.toContain(formatMoney(10000, "SAR"));
  });
  it.each([{ patientId: 202 }, { patientId: undefined }, { totalMinor: -1 }, { discountMinor: -1 }])("requires a valid patient-owned displayed invoice %j", (changes) => {
    expect(renderStatus(envelope(), { invoice: invoice(changes) })).toContain(unavailableLabel);
  });
  it.each([
    { recoveries: [recovery(), recovery()], reviews: [] },
    { recoveries: [recovery()], reviews: [{ invoiceId: 61, planId: 21, reason: "review" }] },
    { recoveries: [], reviews: [{ invoiceId: 61, planId: 21, reason: "review" }, { invoiceId: 61, planId: 21, reason: "review" }] },
    { recoveries: [], reviews: [{ invoiceId: 61, planId: "21", reason: "review" }] },
    { recoveries: [], reviews: [{ invoiceId: 61, planId: 21, reason: "" }] },
  ])("does not choose among conflicting/malformed matching evidence %j", (data) => {
    const html = renderStatus(data); expect(html).toContain(unavailableLabel); expect(html).not.toContain(remainderLabel); expect(html).not.toContain(reviewLabel);
  });
  it("loading/error readiness withdraws the amount instead of reusing the previous proof", () => {
    const html = renderStatus(envelope(), { ready: false }); expect(html).toContain(unavailableLabel); expect(html).not.toContain(remainderLabel);
  });
});

type Element = ReactElement<Record<string, unknown>>;
let patientId = 201;
let key: string | null = null;
const fetchMock = vi.fn();
const response = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
type MockResponse = ReturnType<typeof response>;
let read: () => Promise<MockResponse>;
let readServices: () => Promise<MockResponse>;
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
const payload = (overrides: Record<string, unknown> = {}) => ({
  invoices: [invoice(), invoice({ id: 62, invoiceNumber: "SYNTH-INV-62", totalMinor: 4000 }), invoice({ id: 77, invoiceNumber: "SYNTH-INV-77", totalMinor: 500 })],
  payments: [], opening: null, openings: [], plans: [], baseCurrency: "YER",
  balance: { billedMinor: 0, collectedMinor: 0, openingMinor: 0, dueMinor: 0 },
  balances: { YER: { billedMinor: 0, collectedMinor: 0, openingMinor: 0, dueMinor: 0 }, SAR: { billedMinor: 14500, collectedMinor: 500, openingMinor: 0, dueMinor: 14000 }, USD: { billedMinor: 0, collectedMinor: 0, openingMinor: 0, dueMinor: 0 } },
  installmentRecovery: { recoveries: [recovery(), recovery({ invoiceId: 62, principalMinor: 4000, remainingMinor: 4000, suggestedCashMinor: 4000 })], reviews: [] },
  ...overrides,
});
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as Element; return [element, ...elements(element.props.children as ReactNode)];
}
function text(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  return node && typeof node === "object" && "props" in node ? text((node as Element).props.children as ReactNode) : "";
}
function retire() { hooks.effects.forEach((effect) => effect.cleanup?.()); hooks.effects.clear(); }
function resetOwner() { retire(); hooks.values = []; hooks.memos.clear(); hooks.pending = []; }
function render(): ReactNode {
  let tree: ReactNode; let rounds = 0;
  do {
    if (++rounds > 20) throw new Error("Ledger lifecycle did not settle");
    hooks.cursor = 0; hooks.changed = false;
    const wrapper = PatientLedger({ patientId }) as Element;
    if (typeof wrapper.type !== "function") { if (key !== null) resetOwner(); key = null; return wrapper; }
    if (wrapper.key !== key) { resetOwner(); key = wrapper.key; }
    hooks.cursor = 0; tree = (wrapper.type as (props: Record<string, unknown>) => ReactNode)(wrapper.props);
    hooks.pending.splice(0).forEach((effect) => effect());
  } while (hooks.changed);
  return tree;
}
const find = (type: unknown) => elements(render()).find((node) => node.type === type);
const statusRows = () => elements(render()).filter((node) => node.type === InvoiceSettlementStatus);
function statusHtml(id = 61) {
  const row = statusRows().find((node) => (node.props.invoice as StatusProps["invoice"]).id === id);
  return row ? renderToStaticMarkup(createElement(InvoiceSettlementStatus, row.props as StatusProps)) : "";
}
function refresh() {
  const panel = find(LegacyBalanceArrangementPanel); expect(panel).toBeDefined();
  (panel!.props.onChanged as () => void)();
}
async function flush() { for (let pass = 0; pass < 5; pass++) { for (let i = 0; i < 15; i++) await Promise.resolve(); render(); } }
async function mount() { render(); await flush(); }
const ledgerReads = () => fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/ledger"));

describe("actual PatientLedger canonical response integration and ownership", () => {
  it("renders the existing server projection while retaining 145/5/140 account truth and collection filtering", async () => {
    await mount();
    expect(statusHtml(61)).toContain(formatMoney(10000, "SAR")); expect(statusHtml(62)).toContain(formatMoney(4000, "SAR"));
    expect(statusHtml(77)).toContain("مسدّدة"); expect(statusHtml(77)).not.toContain(remainderLabel);
    for (const amount of [14500, 500, 14000]) expect(text(render())).toContain(formatMoney(amount, "SAR"));
    expect(find(CollectPaymentModal)?.props.invoices).toEqual([]); expect(ledgerReads()).toHaveLength(1);
    expect(ledgerReads()[0][1]).toMatchObject({ cache: "no-store", signal: expect.any(AbortSignal) });
  });
  it("leaves genuine open invoice targets unchanged even with a recovery badge", async () => {
    read = async () => response(payload({ invoices: [invoice({ status: "open" })], installmentRecovery: envelope(recovery({ rawInvoiceStatus: "open" })) }));
    await mount(); expect(statusHtml()).toContain(remainderLabel);
    expect(find(CollectPaymentModal)?.props.invoices).toEqual([{ id: 61, invoiceNumber: "SYNTH-INV-61", totalMinor: 10000, discountMinor: 0, baseCurrency: "SAR" }]);
  });
  it("does not derive invoice settlement from ledger payment rows or absence of the projection", async () => {
    read = async () => response(payload({ installmentRecovery: undefined })); await mount();
    expect(statusHtml()).not.toContain(remainderLabel); expect(statusHtml()).toContain("مسدّدة");
  });
  it("does not join canonical evidence to duplicate displayed invoice IDs", async () => {
    read = async () => response(payload({ invoices: [invoice(), invoice()] })); await mount();
    expect(statusHtml()).toContain(unavailableLabel); expect(statusHtml()).not.toContain(remainderLabel);
  });
  it.each([401, 403, 503])("withdraws proof on refresh HTTP %i without waiting for the denied body", async (status) => {
    await mount(); const pending = deferred<unknown>(); const json = vi.fn(() => pending.promise);
    read = async () => ({ ...response(null, status), json }); refresh();
    expect(statusHtml()).toContain(unavailableLabel); expect(statusHtml()).not.toContain(remainderLabel);
    await flush(); expect(json).not.toHaveBeenCalled(); expect(statusHtml()).not.toContain(remainderLabel);
    if (status === 401 || status === 403) {
      expect(statusRows()).toHaveLength(0); expect(text(render())).toContain("غير مصرّح لك بعرض حساب المريض");
      expect(text(render())).not.toContain("لا فواتير");
    }
  });
  it("a stalled service catalogue cannot delay retiring denied ledger data", async () => {
    await mount(); const catalogue = deferred<MockResponse>(); readServices = () => catalogue.promise;
    const body = deferred<unknown>(); const json = vi.fn(() => body.promise);
    read = async () => ({ ...response(null, 403), json }); refresh(); await flush();
    expect(json).not.toHaveBeenCalled(); expect(statusRows()).toHaveLength(0);
    expect(text(render())).toContain("غير مصرّح لك بعرض حساب المريض");
    catalogue.resolve(response([])); await flush(); expect(statusRows()).toHaveLength(0);
  });
  it.each(["network", "json", "shape"])("does not retain canonical money after %s failure", async (failure) => {
    await mount();
    read = () => failure === "network" ? Promise.reject(new Error("Synthetic network"))
      : Promise.resolve(failure === "json" ? { ...response(null), json: async () => { throw new Error("Synthetic JSON"); } } : response({}));
    refresh(); await flush(); expect(statusHtml()).toContain(unavailableLabel); expect(statusHtml()).not.toContain(remainderLabel);
    const alerts = elements(render()).filter((node) => node.props.role === "alert");
    expect(alerts).toHaveLength(1); expect(alerts[0].props["aria-label"]).toBe("خطأ حساب المريض");
  });
  it("ignores superseded headers and delayed JSON after a newer same-owner read", async () => {
    await mount(); const old = deferred<MockResponse>(); read = () => old.promise; refresh();
    const signal = ledgerReads().at(-1)![1].signal as AbortSignal;
    read = async () => response(payload({ installmentRecovery: envelope(recovery({ remainingMinor: 1500, linkedNetPaidMinor: 8500, suggestedCashMinor: 1500 })) }));
    refresh(); await flush(); expect(signal.aborted).toBe(true);
    old.resolve(response(payload())); await flush(); expect(statusHtml()).toContain(formatMoney(1500, "SAR")); expect(statusHtml()).not.toContain(formatMoney(10000, "SAR"));
    const json = deferred<unknown>(); read = async () => ({ ...response(null), json: () => json.promise }); refresh(); await flush();
    read = async () => response(payload({ installmentRecovery: { recoveries: [], reviews: [{ invoiceId: 61, planId: 21, reason: "review" }] } }));
    refresh(); await flush(); json.resolve(payload()); await flush(); expect(statusHtml()).toContain(reviewLabel); expect(statusHtml()).not.toContain(remainderLabel);
  });
  it("retires A→B→A patient owners and never accepts an older A completion", async () => {
    const oldA = deferred<MockResponse>(); read = () => oldA.promise; await mount();
    const oldSignal = ledgerReads()[0][1].signal as AbortSignal;
    patientId = 202; read = async () => response(payload({ invoices: [invoice({ patientId: 202 })], installmentRecovery: envelope(recovery({ patientId: 202 })) })); await mount();
    expect(statusHtml()).toContain(remainderLabel); expect(oldSignal.aborted).toBe(true);
    patientId = 201; const newA = deferred<MockResponse>(); read = () => newA.promise; render();
    oldA.resolve(response(payload())); await flush(); expect(statusRows()).toHaveLength(0);
    newA.resolve(response(payload())); await flush(); expect(statusHtml()).toContain(remainderLabel); expect(hooks.lateUpdates).toBe(0);
  });
  it.each(["principal", "permissions", "logout"])("retires displayed proof immediately on %s change", async (change) => {
    await mount(); const next = deferred<MockResponse>(); read = () => next.promise;
    hooks.session = change === "logout" ? null : change === "principal" ? { username: "synthetic-admin-b", role: "admin" }
      : { username: "synthetic-admin-a", role: "doctor", permissions: { canViewPatientPayments: false } as NonNullable<SessionInfo["permissions"]> };
    render(); expect(statusRows()).toHaveLength(0); expect(statusHtml()).not.toContain(remainderLabel);
    if (change === "logout") expect(text(render())).toContain("غير مصرّح لك بعرض حساب المريض");
  });
  it("a late unmounted read cannot publish financial state", async () => {
    const pending = deferred<MockResponse>(); read = () => pending.promise; await mount();
    const signal = ledgerReads()[0][1].signal as AbortSignal; resetOwner(); key = null;
    pending.resolve(response(payload())); for (let i = 0; i < 50; i++) await Promise.resolve();
    expect(signal.aborted).toBe(true); expect(hooks.lateUpdates).toBe(0);
  });
});


/** Mirror the current db.ts toInvoice/toPayment/toOpeningBalance DTOs (including
 * nullable references and extra fields), and call the same pure summary/money
 * mappers as the ledger route. No database module executes: its imports are types. */
function mappedPayload() {
  const original: DbInvoice = {
    id: 61, patientId: 201, patientName: "Synthetic corrected account", invoiceNumber: "MAPPED-ORIGINAL",
    status: "cancelled", totalMinor: 10000, discountMinor: 0, baseCurrency: "SAR", note: null,
    createdAt: "2026-10-04T10:00:00.000Z",
    items: [{ id: 611, serviceId: null, doctorId: null, description: "Original item", quantity: 1, unitPriceMinor: 10000, totalMinor: 10000 }],
  };
  const corrected: DbInvoice = { ...original, id: 62, invoiceNumber: "MAPPED-CORRECTED", status: "paid", totalMinor: 4000,
    note: "تصحيح للفاتورة MAPPED-ORIGINAL", items: [{ ...original.items[0], id: 621, unitPriceMinor: 4000, totalMinor: 4000 }] };
  const receipt: DbPayment = {
    id: 101, receiptNumber: "MAPPED-RECEIPT", patientId: 201, patientName: original.patientName,
    invoiceId: original.id, planId: null, openingCurrency: null, shiftId: 1, kind: "payment", amountMinor: 7000,
    currency: "SAR", exchangeRate: 140, baseAmountMinor: 9800, baseCurrency: "YER", method: "cash", note: null,
    createdBy: null, createdAt: "2026-10-04T10:10:00.000Z",
  };
  const refund: DbPayment = { ...receipt, id: 102, receiptNumber: "MAPPED-REFUND", kind: "refund", amountMinor: 1000, baseAmountMinor: 1400 };
  const opening: DbOpening = { patientId: 201, patientName: original.patientName, phone: null, currency: "YER",
    amountMinor: -2000, asOfDate: "2026-10-01", note: null, createdBy: null, updatedAt: "2026-10-04T10:00:00.000Z" };
  const invoices = [original, corrected]; const payments = [receipt, refund];
  const balances = patientBalancesByCurrency(invoices, toCurrencyPaymentLikes(201, payments,
    new Map(invoices.map((item) => [item.id, { patientId: item.patientId, currency: item.baseCurrency }]))), { YER: opening.amountMinor });
  const agreement = { totalMinor: 10000, status: "active" as const,
    installments: [{ number: 1, dueDate: "2026-11-01", amountMinor: 10000 }] };
  const itemPlan = { totalMinor: 0, status: "completed" as const, installments: [] };
  const plans = [
    planLedgerSummary({ ...agreement, id: 21, title: "Mapped installment plan", baseCurrency: "SAR", consentAt: null,
      progress: planProgress(agreement, -500, "2026-10-04"), itemsProgress: planItemsProgress([]) }),
    planLedgerSummary({ ...itemPlan, id: 22, title: "Mapped item plan", consentAt: "2026-10-01",
      progress: planProgress(itemPlan, 0, "2026-10-04"), itemsProgress: planItemsProgress([]) }),
  ];
  const legacyOpeningPositions: DbLegacyOpening[] = [{ currency: "USD", openingMinor: 1000, settledMinor: -500, remainingMinor: 1500 }];
  const arrangement: DbArrangement = { id: 301, patientId: 201, currency: "USD", cadence: "per_visit", installmentMinor: 250,
    startingDueMinor: 1500, firstDueDate: null, note: null, createdBy: "synthetic-admin", createdAt: "2026-10-04T10:00:00.000Z",
    cancelledBy: null, cancelledAt: null, cancelReason: null,
    progress: legacyArrangementProgress({ startingDueMinor: 1500, installmentMinor: 250, cadence: "per_visit", firstDueDate: null,
      currentOpeningDueMinor: 1500, paidSinceStartMinor: 0, today: "2026-10-04" }),
  };
  return { invoices, payments, opening, openings: [opening], baseCurrency: "YER", balance: balances.YER, balances, plans,
    receiptRemaining: { "101": 6000 }, openingAccess: { add: true, edit: true },
    legacyBalanceArrangements: [arrangement], legacyOpeningPositions, legacyArrangementAccess: { manage: true },
    installmentRecovery: { recoveries: [], reviews: [] },
  };
}

describe("actual Ledger wire compatibility", () => {
  it("accepts current mapped DTO/null/negative/corrected shapes and preserves server money and legacy summaries", async () => {
    const data = mappedPayload(); const before = structuredClone(data); read = async () => response(data); await mount();
    expect(data).toEqual(before); expect(statusHtml(61)).toContain("ملغاة"); expect(statusHtml(62)).toContain("مسدّدة");
    expect(statusHtml(62)).not.toContain(remainderLabel); expect(find(CollectPaymentModal)?.props.invoices).toEqual([]);
    expect(text(render())).toContain("للمريض 20.00 ر.س"); expect(text(render())).toContain("للمريض 2,000 ر.ي");
    expect(text(render())).toContain(formatMoney(-500, "SAR"));
    expect(find(LegacyBalanceArrangementPanel)?.props.arrangements).toEqual(data.legacyBalanceArrangements);
    expect(find(LegacyBalanceArrangementPanel)?.props.openingPositions).toEqual(data.legacyOpeningPositions);
    expect(find(CollectPaymentModal)?.props.plans).toEqual([{ id: 21, title: "Mapped installment plan", baseCurrency: "SAR" }]);
  });
  it("preserves declared optional legacy wire fields and treats malformed recovery evidence independently", async () => {
    const source = mappedPayload();
    const data = { invoices: source.invoices.map(({ patientId: _owner, ...item }) => { void _owner; return item; }),
      payments: source.payments.map(({ planId: _plan, openingCurrency: _currency, ...item }) => { void _plan; void _currency; return item; }),
      opening: { patientId: 201, amountMinor: -2000, asOfDate: "2026-10-01", note: null },
      baseCurrency: "YER", balance: source.balance,
      plans: source.plans.map(({ baseCurrency: _currency, ...plan }) => { void _currency; return plan; }),
      installmentRecovery: null,
    };
    read = async () => response(data); await mount();
    expect(statusRows()).toHaveLength(2); expect(statusHtml(62)).toContain(unavailableLabel);
    expect(text(render())).toContain("للمريض 2,000 ر.ي"); expect(text(render())).not.toContain("تعذّر التحقق من بيانات حساب المريض");
  });
  it.each([
    "missing-opening", "invoice-array", "invoice-status", "invoice-note", "invoice-date", "invoice-item",
    "item-quantity", "invoice-money", "invoice-owner", "payment-row", "payment-date", "payment-currency",
    "payment-money", "payment-reference", "plan-installments", "plan-items", "plan-consent", "currency-buckets",
    "missing-balance-value", "nonfinite-balance", "opening-note", "opening-access", "receipt-map", "legacy-progress",
    "legacy-opening", "legacy-access",
  ])("rejects malformed consumed %s wire fields instead of casting or inventing defaults", async (which) => {
    const data = mappedPayload(); let changed: Record<string, unknown> = data;
    if (which === "missing-opening") changed = { ...data, opening: undefined };
    if (which === "invoice-array") changed = { ...data, invoices: null };
    if (which === "invoice-status") changed = { ...data, invoices: [{ ...data.invoices[0], status: "future" }] };
    if (which === "invoice-note") changed = { ...data, invoices: [{ ...data.invoices[0], note: undefined }] };
    if (which === "invoice-date") changed = { ...data, invoices: [{ ...data.invoices[0], createdAt: null }] };
    if (which === "invoice-item") changed = { ...data, invoices: [{ ...data.invoices[0], items: [{}] }] };
    if (which === "item-quantity") changed = { ...data, invoices: [{ ...data.invoices[0], items: [{ ...data.invoices[0].items[0], quantity: "1" }] }] };
    if (which === "invoice-money") changed = { ...data, invoices: [{ ...data.invoices[0], totalMinor: "10000" }] };
    if (which === "invoice-owner") changed = { ...data, invoices: [{ ...data.invoices[0], patientId: "201" }] };
    if (which === "payment-row") changed = { ...data, payments: [null] };
    if (which === "payment-date") changed = { ...data, payments: [{ ...data.payments[0], createdAt: null }] };
    if (which === "payment-currency") changed = { ...data, payments: [{ ...data.payments[0], currency: "BAD" }] };
    if (which === "payment-money") changed = { ...data, payments: [{ ...data.payments[0], amountMinor: 1.5 }] };
    if (which === "payment-reference") changed = { ...data, payments: [{ ...data.payments[0], invoiceId: "61" }] };
    if (which === "plan-installments") changed = { ...data, plans: [{ ...data.plans[0], installments: {} }] };
    if (which === "plan-items") changed = { ...data, plans: [{ ...data.plans[1], items: {} }] };
    if (which === "plan-consent") changed = { ...data, plans: [{ ...data.plans[0], consented: 0 }] };
    if (which === "currency-buckets") changed = { ...data, balances: { YER: data.balances.YER } };
    if (which === "missing-balance-value") changed = { ...data, balance: { ...data.balance, dueMinor: undefined } };
    if (which === "nonfinite-balance") changed = { ...data, balance: { ...data.balance, dueMinor: Infinity } };
    if (which === "opening-note") changed = { ...data, openings: [{ ...data.opening, note: false }] };
    if (which === "opening-access") changed = { ...data, openingAccess: { add: "yes", edit: true } };
    if (which === "receipt-map") changed = { ...data, receiptRemaining: { "101": "6000" } };
    if (which === "legacy-progress") changed = { ...data, legacyBalanceArrangements: [{ ...data.legacyBalanceArrangements[0], progress: { ...data.legacyBalanceArrangements[0].progress, completed: 0 } }] };
    if (which === "legacy-opening") changed = { ...data, legacyOpeningPositions: [{ ...data.legacyOpeningPositions[0], remainingMinor: "1500" }] };
    if (which === "legacy-access") changed = { ...data, legacyArrangementAccess: { manage: 1 } };
    const before = structuredClone(changed); read = async () => response(changed); await mount();
    expect(changed).toEqual(before); expect(statusRows()).toHaveLength(0);
    expect(text(render())).toContain("تعذّر التحقق من بيانات حساب المريض");
    expect(text(render())).not.toContain("لا فواتير"); expect(find(CollectPaymentModal)).toBeUndefined();
  });
});
