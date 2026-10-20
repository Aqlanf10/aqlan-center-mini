import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { partyStatementTotals, type PartyCurrencyTotals, type StatementExpenseLike } from "../lib/party-statement";
import { CURRENCIES, formatMoney } from "../lib/money";

const runtime = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, effect: null as null | (() => void),
  session: vi.fn(), statement: vi.fn(), getParty: vi.fn(), fetch: vi.fn() }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  use: () => ({ id: "1" }),
  useState: (initial: unknown) => {
    const index = runtime.cursor++;
    if (!(index in runtime.values)) runtime.values[index] = initial;
    return [runtime.values[index], (value: unknown) => { runtime.values[index] = value; }];
  },
  useCallback: (callback: unknown) => callback,
  useEffect: (effect: () => void) => { runtime.effect ??= effect; },
}));
vi.mock("@/lib/db", () => ({ getSettingsSafe: async () => ({}), partyStatement: runtime.statement, getParty: runtime.getParty }));
vi.mock("@/lib/session", () => ({ requireSession: runtime.session }));
vi.mock("@/components/SessionProvider", () => ({ useSession: () => ({ username: "test", role: "admin" }) }));
vi.mock("@/components/PrintHeader", () => ({ PrintHeader: () => null, PrintFooter: () => null }));
vi.mock("@/components/PrintButton", () => ({ PrintButton: () => null }));
vi.mock("@/components/finance/PayBillForm", () => ({ default: () => null }));
import StatementPage from "../app/finance/parties/[id]/page";
import StatementPrintPage from "../app/print/party/[id]/page";

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const params = { params: Promise.resolve({ id: "1" }) };
function configure(totals: PartyCurrencyTotals[], payments: StatementExpenseLike[] = []) {
  const expenses = payments.map((payment, index) => ({ ...payment, id: index + 1, voucherNumber: `SYN-${index + 1}`,
    category: "lab", createdAt: "2026-10-20T12:00:00.000Z", reversalOfId: payment.amountMinor < 0 ? 99 : null,
    payableCurrency: null, payableSettledMinor: null, note: null }));
  const statement = { payables: [], expenses, advances: [], totals };
  runtime.statement.mockResolvedValue(statement);
  runtime.fetch.mockResolvedValue({ ok: true, json: async () => ({ ...statement, party: { name: "Synthetic supplier" }, baseCurrency: "YER" }) });
}
async function loadedScreen() {
  runtime.cursor = 0; StatementPage(params); runtime.effect!();
  for (let i = 0; i < 20; i++) await Promise.resolve();
  runtime.cursor = 0;
  return renderToStaticMarkup(StatementPage(params));
}
function screenTree() { runtime.cursor = 0; return StatementPage(params); }
function nodes(tree: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (!tree || typeof tree !== "object" || !("props" in tree)) return [];
  const element = tree as ReactElement<Record<string, unknown>>;
  return [element, ...nodes(element.props.children as ReactNode)];
}
beforeEach(() => {
  vi.clearAllMocks();
  runtime.values = []; runtime.cursor = 0; runtime.effect = null;
  runtime.session.mockResolvedValue({ username: "test", role: "admin" });
  runtime.getParty.mockResolvedValue({ id: 1, name: "Synthetic supplier", kind: "supplier", phone: null });
  const totals = partyStatementTotals(
    [{ amountMinor: 30_000, settledMinor: 0, remainingMinor: 30_000, currency: "YER" }],
    [{ amountMinor: 20_000, currency: "YER", payableId: null, payableExists: false, allocatedPaidMinor: 0 }],
  );
  configure(totals);
  vi.stubGlobal("fetch", runtime.fetch);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("actual party statement screen and print settlement totals", () => {
  it("screen subtracts on-account payments from its summary without changing invoice remainders", async () => {
    const html = await loadedScreen();
    const summary = text(html.match(/<section[^>]*>([\s\S]*?)<\/section>/)![1]);
    expect(summary).toContain("علينا 10,000");
    expect(summary).toContain("على الحساب 20,000");
    expect(summary).not.toContain("علينا 30,000");
    expect(runtime.fetch).toHaveBeenCalledWith("/api/payables?partyId=1", { cache: "no-store" });
  });

  it("printed net agrees with the screen's native-currency balance", async () => {
    const content = text(renderToStaticMarkup(await StatementPrintPage(params)));
    expect(content).toMatch(/المتبقي علينا\s+10,000/);
    expect(content).not.toMatch(/المتبقي علينا\s+30,000/);
  });

  it.each(CURRENCIES)("screen and print preserve partial allocations and minor units for %s", async (currency) => {
    configure(partyStatementTotals(
      [{ currency, amountMinor: 30_000, settledMinor: 10_000, remainingMinor: 20_000 }],
      [{ currency, amountMinor: 20_000, payableId: null, payableExists: false, allocatedPaidMinor: 10_000 }],
    ));
    expect(text(await loadedScreen())).toContain(`علينا ${formatMoney(10_000, currency)}`);
    expect(text(renderToStaticMarkup(await StatementPrintPage(params)))).toContain(`المتبقي علينا ${formatMoney(10_000, currency)}`);
  });

  it("separates debt and credit currency buckets instead of cross-currency netting", async () => {
    configure(partyStatementTotals(
      [{ currency: "USD", amountMinor: 10_000, settledMinor: 0, remainingMinor: 10_000 }],
      [{ currency: "YER", amountMinor: 26_750, payableId: null, payableExists: false, allocatedPaidMinor: 0 }],
    ));
    const screen = text(await loadedScreen());
    expect(screen).toContain(`لنا عند الجهة ${formatMoney(26_750, "YER")}`);
    expect(screen).toContain(`علينا ${formatMoney(10_000, "USD")}`);
    const print = text(renderToStaticMarkup(await StatementPrintPage(params)));
    expect(print).toContain(`رصيد لنا عند الجهة ${formatMoney(26_750, "YER")}`);
    expect(print).toContain(`المتبقي علينا ${formatMoney(10_000, "USD")}`);
  });

  it("does not relabel a fully allocated batch as an advance on screen or print", async () => {
    const expenses = [{ currency: "YER", amountMinor: 20_000, payableId: null, payableExists: false, allocatedPaidMinor: 20_000 }] as const;
    configure(partyStatementTotals(
      [{ currency: "YER", amountMinor: 20_000, settledMinor: 20_000, remainingMinor: 0 }],
      expenses,
    ), [...expenses]);
    expect(text(await loadedScreen())).toContain("الحساب مسدّد");
    expect(text(await loadedScreen())).not.toContain("على الحساب");
    const print = text(renderToStaticMarkup(await StatementPrintPage(params)));
    expect(print).not.toContain("على الحساب");
    expect(print).toContain("تسوية التزامات");
  });

  it.each(CURRENCIES)("prints only the actual unallocated part of a partial %s voucher", async (currency) => {
    const expenses = [{ currency, amountMinor: 20_000, payableId: null, payableExists: false, allocatedPaidMinor: 10_000 }];
    configure(partyStatementTotals([], expenses), expenses);
    const print = text(renderToStaticMarkup(await StatementPrintPage(params)));
    expect(print).toContain(`منه على الحساب ${formatMoney(10_000, currency)}`);
  });

  it("does not reclassify direct settlements or reversal voucher rows as on-account", async () => {
    const expenses = [
      { currency: "YER", amountMinor: 10_000, payableId: 1, payableExists: true, allocatedPaidMinor: 0 },
      { currency: "YER", amountMinor: -10_000, payableId: null, payableExists: false, allocatedPaidMinor: -10_000 },
    ] as const;
    configure(partyStatementTotals([], expenses), [...expenses]);
    const html = renderToStaticMarkup(await StatementPrintPage(params));
    const voucherRows = html.match(/<table[^>]*>[\s\S]*?<\/table>/g)![1];
    expect(text(voucherRows)).not.toContain("على الحساب");
    expect(text(voucherRows)).toContain("إبطال سند");
  });

  it("withholds the settled claim during initial loading", () => {
    const content = text(renderToStaticMarkup(StatementPage(params)));
    expect(content).toContain("جارٍ تحميل رصيد الجهة");
    expect(content).not.toContain("الحساب مسدّد");
  });

  it.each([undefined, null, [{}]])("withholds balance and empty claims for missing/malformed totals %#", async (totals) => {
    runtime.fetch.mockResolvedValue({ ok: true, json: async () => ({ payables: [], expenses: [], totals }) });
    const content = text(await loadedScreen());
    expect(content).toContain("رصيد الجهة غير متاح");
    expect(content).not.toContain("الحساب مسدّد");
    expect(content).not.toContain("لا التزامات مسجّلة");
  });

  it("hides stale debt when a later read fails", async () => {
    expect(text(await loadedScreen())).toContain("علينا 10,000");
    runtime.fetch.mockResolvedValue({ ok: false, json: async () => ({ message: "Synthetic read failure" }) });
    const content = text(await loadedScreen());
    expect(content).toContain("Synthetic read failure");
    expect(content).not.toContain("علينا 10,000");
    expect(content).not.toContain("الحساب مسدّد");
  });

  it("preserves a valid statement after a failed new-bill save and cancel", async () => {
    await loadedScreen();
    const add = nodes(screenTree()).find((node) => node.type === "button" && String(node.props.children).includes("سجّل التزامًا"))!;
    (add.props.onClick as () => void)();
    const form = nodes(screenTree()).find((node) => node.type === "form")!;
    runtime.fetch.mockResolvedValue({ ok: false, json: async () => ({ message: "Synthetic save validation failure" }) });
    await (form.props.onSubmit as (event: { preventDefault: () => void }) => Promise<void>)({ preventDefault: () => {} });
    expect(text(renderToStaticMarkup(screenTree()))).toContain("علينا 10,000");
    expect(text(renderToStaticMarkup(screenTree()))).toContain("Synthetic save validation failure");
    const cancel = nodes(screenTree()).find((node) => node.type === "button" && node.props.children === "إلغاء")!;
    (cancel.props.onClick as () => void)();
    expect(text(renderToStaticMarkup(screenTree()))).toContain("علينا 10,000");
    expect(text(renderToStaticMarkup(screenTree()))).not.toContain("رصيد الجهة غير متاح");
  });

  it("admits the successful truly empty statement as settled", async () => {
    configure([]);
    expect(text(await loadedScreen())).toContain("الحساب مسدّد");
  });
});
