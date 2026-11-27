import { createElement, isValidElement, type ComponentProps, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import ReportsPage from "../app/reports/page";
import { FilterBar } from "../components/reports/shared";
import { ReportView } from "../components/reports/ReportView";
import type { ReportResult } from "../lib/reports-types";

// Run actual page effects and the actual filter markup without browser/network.
// One synthetic hook owner per component; the test opens deferred responses explicitly.
const hooks = vi.hoisted(() => {
  const make = () => ({
    cursor: 0,
    slots: [] as unknown[],
    effects: new Map<number, { deps?: readonly unknown[]; cleanup?: () => void }>(),
    pending: [] as Array<() => void>,
  });
  return { make, owner: make() };
});
vi.mock("react", async original => {
  const react = await original<typeof import("react")>();
  const same = (a?: readonly unknown[], b?: readonly unknown[]) =>
    !!a && !!b && a.length === b.length && a.every((item, i) => Object.is(item, b[i]));
  const slot = (initial: () => unknown) => {
    const owner = hooks.owner, i = owner.cursor++;
    if (!(i in owner.slots)) owner.slots[i] = initial();
    return { owner, i };
  };
  const memo = (factory: () => unknown, deps?: readonly unknown[]) => {
    const { owner, i } = slot(() => undefined);
    const last = owner.slots[i] as { deps?: readonly unknown[]; value: unknown } | undefined;
    if (last && same(last.deps, deps)) return last.value;
    const value = factory();
    owner.slots[i] = { deps, value };
    return value;
  };
  return {
    ...react,
    useState: (initial: unknown) => {
      const { owner, i } = slot(() => typeof initial === "function" ? initial() : initial);
      return [owner.slots[i], (update: unknown) => {
        owner.slots[i] = typeof update === "function" ? update(owner.slots[i]) : update;
      }];
    },
    useRef: (initial: unknown) => {
      const { owner, i } = slot(() => ({ current: initial }));
      return owner.slots[i];
    },
    useMemo: memo,
    useCallback: (callback: unknown, deps?: readonly unknown[]) => memo(() => callback, deps),
    useEffect: (callback: () => void | (() => void), deps?: readonly unknown[]) => {
      const { owner, i } = slot(() => undefined), previous = owner.effects.get(i);
      if (previous && same(previous.deps, deps)) return;
      owner.pending.push(() => {
        previous?.cleanup?.();
        const cleanup = callback();
        owner.effects.set(i, { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined });
      });
    },
  };
});
vi.mock("../components/SessionProvider", () => ({ useSession: () => ({ username: "synthetic-report", role: "admin" }) }));
vi.mock("../components/SettingsProvider", () => ({ useClinicName: () => "مختبر اختباري", useSetting: () => "" }));
vi.mock("../lib/session", () => ({ requireSession: async () => ({ username: "synthetic-report", role: "admin" }) }));

const DAY = "2027-01-01";
const JUNE = { preset: "custom", from: "2026-06-01", to: "2026-06-30", currency: "SAR" } as const;
const JULY = { preset: "custom", from: "2026-07-01", to: "2026-07-31", currency: "USD" } as const;
const TODAY_CHOICES = { payees: [{ value: "a".repeat(64), label: "مستفيد اليوم الاصطناعي" }],
  categories: [{ value: "b".repeat(64), label: "بند اليوم الاصطناعي" }] };
const JUNE_CHOICES = { payees: [{ value: "c".repeat(64), label: "مستفيد يونيو الاصطناعي" }],
  categories: [{ value: "d".repeat(64), label: "بند يونيو الاصطناعي" }] };
const JULY_CHOICES = { payees: [{ value: "e".repeat(64), label: "مستفيد يوليو الاصطناعي" }],
  categories: [{ value: "f".repeat(64), label: "بند يوليو الاصطناعي" }] };
const EMPTY_CHOICES = { payees: [], categories: [] };
const recipient = TODAY_CHOICES.payees[0].value;
const category = TODAY_CHOICES.categories[0].value;
const urlRoot = "https://synthetic.invalid";
let page: ReturnType<typeof hooks.make>;
let form: ReturnType<typeof hooks.make>;
let requests: { params: URLSearchParams; resolve: (response: Response) => void }[];
let replaceUrl: ReturnType<typeof vi.fn>;
const ok = (from: string, to: string, expenseFilterOptions: ReportResult["expenseFilterOptions"], rows = [{ reference: "SYNTH-VOUCHER" }]) => Response.json({
  result: {
    report: "expense-payees", title: "تقرير اصطناعي", from, to, kpis: [], rows, expenseFilterOptions,
    periodLabel: "فترة اصطناعية", filtersLabel: "عملة اصطناعية", baseCurrency: "YER",
  },
  generatedAt: "2027-01-01T20:00:00Z", generatedBy: "synthetic-report",
});
const drain = () => new Promise(resolve => setTimeout(resolve, 0));
function walk(node: ReactNode, type: unknown): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(child => walk(child, type));
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [...(node.type === type ? [node] : []), ...walk(node.props.children as ReactNode, type)];
}
function renderPage() {
  hooks.owner = page;
  page.cursor = 0;
  const tree = ReportsPage();
  for (const effect of page.pending.splice(0)) effect();
  return tree;
}
const filter = () => walk(renderPage(), FilterBar)[0].props as unknown as ComponentProps<typeof FilterBar>;
const shownReport = () => walk(renderPage(), ReportView)[0]?.props as unknown as ComponentProps<typeof ReportView> | undefined;
const formMarkup = () => {
  const props = filter();
  hooks.owner = form;
  form.cursor = 0;
  return renderToStaticMarkup(createElement(FilterBar, props));
};
const selects = () => [...formMarkup().matchAll(/<select\b[^>]*>[\s\S]*?<\/select>/g)].slice(1).map(match => match[0]);
const disabledSelect = (select: string) => /^<select\b[^>]* disabled=""/.test(select);
const latest = () => requests[requests.length - 1];
const answer = async (response: Response) => {
  latest().resolve(response);
  await drain();
};
function open() {
  renderPage();
  expect(requests).toHaveLength(1);
  expect(latest().params.get("preset")).toBe("today");
}
beforeEach(() => {
  page = hooks.make();
  form = hooks.make();
  requests = [];
  replaceUrl = vi.fn();
  vi.stubGlobal("window", {
    location: new URL(urlRoot + "/reports?report=expense-payees&preset=today"),
    history: { replaceState: replaceUrl },
  });
  vi.stubGlobal("fetch", vi.fn((url: string, init: RequestInit) => {
    expect(init).toEqual({ cache: "no-store" });
    const parsed = new URL(url, urlRoot);
    expect(parsed.pathname).toBe("/api/reports");
    if (parsed.searchParams.get("report") === "options") return Promise.resolve(Response.json({}));
    expect(parsed.searchParams.get("report")).toBe("expense-payees");
    return new Promise<Response>(resolve => requests.push({ params: parsed.searchParams, resolve }));
  }));
});
afterEach(() => vi.unstubAllGlobals());

it("loads options once per explicit apply, binds them to the result's interval/currency and carries held selectors", async () => {
  open();
  expect(selects().every(disabledSelect)).toBe(true);
  await answer(ok(DAY, DAY, TODAY_CHOICES));
  expect(selects()[0]).toContain(TODAY_CHOICES.payees[0].label);
  expect(disabledSelect(selects()[0])).toBe(false);
  filter().onChange({ ...JUNE, expenseRecipient: recipient, expenseCategory: category });
  expect(requests).toHaveLength(1);
  expect(selects().every(disabledSelect)).toBe(true);
  expect(formMarkup()).toContain("تطبيق الفترة والعملة وتحديث الخيارات");
  expect(shownReport()?.result.from).toBe(DAY);
  filter().onApply();
  expect(requests).toHaveLength(2);
  expect(Object.fromEntries(latest().params)).toMatchObject({ ...JUNE, expenseRecipient: recipient, expenseCategory: category });
  expect(selects().every(disabledSelect)).toBe(true);
  expect(formMarkup()).toContain("جارٍ تحديث خيارات المصروفات");
  expect(formMarkup()).toMatch(/<button[^>]* disabled=""[^>]*>جارٍ تحديث خيارات المصروفات/);
  filter().onApply();
  expect(requests).toHaveLength(2);
  filter().onChange(JULY);
  await answer(ok(JUNE.from, JUNE.to, JUNE_CHOICES, []));
  expect(selects().every(disabledSelect)).toBe(true);
  expect(selects()[0]).not.toContain(JUNE_CHOICES.payees[0].label);
  expect(new URL(shownReport()!.printHref, urlRoot).searchParams.toString()).toContain("from=2026-06-01");
  expect(requests).toHaveLength(2);
  filter().onApply();
  expect(Object.fromEntries(latest().params)).toMatchObject({ ...JULY, expenseRecipient: recipient, expenseCategory: category });
  await answer(ok(JULY.from, JULY.to, JULY_CHOICES, []));
  expect(selects()[0]).toContain(JULY_CHOICES.payees[0].label);
  expect(selects()[0]).toContain("المستفيد المحدد غير موجود");
  expect(selects()[0]).toContain(recipient);
  expect(selects()[1]).toContain(category);
  expect(disabledSelect(selects()[0])).toBe(false);
  expect(formMarkup()).toContain(JULY.from);
  expect(shownReport()?.result.rows).toEqual([]);

  // The choices stay active until the operator explicitly changes both.
  filter().onChange({ expenseRecipient: null, expenseCategory: null });
  expect(requests).toHaveLength(3);
  expect(new URL(shownReport()!.printHref, urlRoot).searchParams.get("expenseRecipient")).toBe(recipient);
  filter().onApply();
  expect(Object.fromEntries(latest().params)).toMatchObject(JULY);
  expect(latest().params.has("expenseRecipient")).toBe(false);
  expect(latest().params.has("expenseCategory")).toBe(false);
  await answer(ok(JULY.from, JULY.to, JULY_CHOICES));
  expect(shownReport()?.result.rows).toEqual([{ reference: "SYNTH-VOUCHER" }]);
});

it("distinguishes failure (retain applied report) from verified emptiness and retires old option labels on denial", async () => {
  open();
  await answer(ok(DAY, DAY, TODAY_CHOICES));
  filter().onChange({ ...JUNE, expenseRecipient: recipient });
  filter().onApply();
  await answer(Response.json({ message: "synthetic outage" }, { status: 503 }));
  expect(formMarkup()).toContain("إعادة محاولة تحميل خيارات المصروفات");
  expect(formMarkup()).not.toContain("لا توجد سندات صرف مسجّلة في هذه الفترة");
  expect(selects().every(disabledSelect)).toBe(true);
  expect(shownReport()?.result.from).toBe(DAY);
  expect(new URL(shownReport()!.printHref, urlRoot).searchParams.get("expenseRecipient")).toBeNull();
  filter().onApply();
  expect(latest().params.get("expenseRecipient")).toBe(recipient);
  await answer(ok(JUNE.from, JUNE.to, EMPTY_CHOICES, []));
  expect(formMarkup()).toContain("لا توجد سندات صرف مسجّلة في هذه الفترة.");
  expect(formMarkup()).not.toContain("إعادة محاولة تحميل");
  expect(disabledSelect(selects()[0])).toBe(false);
  expect(selects()[0]).toContain(recipient);

  filter().onChange({ preset: "today", currency: "all" });
  filter().onApply();
  await answer(ok(DAY, DAY, TODAY_CHOICES));
  expect(formMarkup()).toContain(TODAY_CHOICES.payees[0].label);
  filter().onApply();
  await answer(new Response("denied", { status: 403 }));
  expect(formMarkup()).not.toContain(TODAY_CHOICES.payees[0].label);
  expect(selects()[0]).toContain(recipient);
  expect(shownReport()).toBeUndefined();
});

it("applies changed selectors to the dates that furnished choices but keeps the relative saved view", async () => {
  open();
  await answer(ok(DAY, DAY, TODAY_CHOICES));
  filter().onChange({ expenseRecipient: recipient, expenseCategory: category });
  filter().onApply();
  expect(Object.fromEntries(latest().params)).toMatchObject({
    preset: "custom", from: DAY, to: DAY, expenseRecipient: recipient, expenseCategory: category,
  });
  await answer(ok(DAY, DAY, TODAY_CHOICES));
  expect(replaceUrl.mock.lastCall?.[2]).toContain("preset=today");
  const print = new URL(shownReport()!.printHref, urlRoot).searchParams;
  expect(print.get("preset")).toBe("custom");
  expect(print.get("from")).toBe(DAY);
  expect(print.get("expenseCategory")).toBe(category);
  filter().onApply();
  expect(latest().params.get("preset")).toBe("today");
});

it("does not show an old or malformed option set as a successful interval", async () => {
  open();
  await answer(ok(DAY, DAY, TODAY_CHOICES));
  filter().onChange(JUNE);
  filter().onApply();
  await answer(ok(JULY.from, JULY.to, JULY_CHOICES));
  expect(formMarkup()).toContain("إعادة محاولة تحميل");
  expect(formMarkup()).not.toContain(JULY_CHOICES.payees[0].label);
  expect(shownReport()?.result.from).toBe(DAY);

  filter().onApply();
  await answer(ok(JUNE.from, JUNE.to, undefined));
  expect(formMarkup()).toContain("إعادة محاولة تحميل");
  expect(formMarkup()).not.toContain("لا توجد سندات صرف");
  filter().onApply();
  await answer(ok(JUNE.from, JUNE.to, JUNE_CHOICES));
  expect(selects()[0]).toContain(JUNE_CHOICES.payees[0].label);
  expect(shownReport()?.result.from).toBe(JUNE.from);
});

it("carries the real recorded-name and party selectors through applied screen, official print and CSV", async () => {
  vi.stubEnv("USE_LOCAL_DB", "true");
  vi.stubEnv("DATABASE_URL", "");
  vi.stubEnv("RAILWAY_PROJECT_ID", "");
  vi.stubEnv("CLINIC_TIME_ZONE", "Asia/Aden");
  // Start the WASM database on its Node path, not the synthetic window below.
  const clientWindow = window;
  vi.stubGlobal("window", undefined);
  const db = await import("../lib/db");
  try {
    const { GET: report } = await import("../app/api/reports/route");
    const { default: PrintPage } = await import("../app/print/report/page");
    const { normalizeSavedReportQuery } = await import("../lib/saved-reports");
    await db.ensureSchema();
    const q = (sql: string, values: unknown[] = []) => db.getPool().query(sql, values);
    await q("SET TIME ZONE 'Asia/Aden'");
    const shift = (await q("INSERT INTO cashier_shifts(opened_by) VALUES('synthetic composed report') RETURNING id")).rows[0].id;
    const account = (await q("INSERT INTO parties(kind,name) VALUES('supplier','جهة اصطناعية باسم محدث') RETURNING id")).rows[0].id;
    const recorded = "اسم مؤجر مسجّل اصطناعي";
    const categoryLabel = "إيجار موثّق اصطناعي";
    const namesake = (await q("INSERT INTO parties(kind,name) VALUES('supplier',$1) RETURNING id", [recorded])).rows[0].id;
    await q("INSERT INTO expense_categories(key,name) VALUES('composed_rent',$1)", [categoryLabel]);
    const add = (reference: string, category: string, party: number | null, payee: string | null, currency: string, amount: number,
      date = "2026-06-01T21:10:00Z", memo: string | null = null) => q(
      "INSERT INTO expenses(voucher_number,shift_id,category,party_id,payee_text,currency,amount_minor,exchange_rate,base_amount_minor,base_currency,created_at,note)"
      + " VALUES($1,$2,$3,$4,$5,$6,$7,1,$7,$6,$8::timestamptz,$9)",
      [reference, shift, category, party, payee, currency, amount, date, memo],
    );
    const linked = "SYN-COMPOSED-LINKED", legacy = "SYN-COMPOSED-LEGACY";
    const excluded = ["SYN-COMPOSED-NAMESAKE", "SYN-COMPOSED-MEMO", "SYN-COMPOSED-OUTSIDE"];
    await add(linked, "composed_rent", account, recorded, "YER", 800);
    await add(legacy, categoryLabel, null, " " + recorded + " ", "SAR", 300);
    await add(excluded[0], "composed_rent", namesake, null, "YER", 111);
    await add(excluded[1], "composed_rent", null, null, "YER", 222, undefined, recorded);
    await add(excluded[2], "composed_rent", null, recorded, "SAR", 333, "2026-05-31T20:59:59Z");

    async function actualRead() {
      const response = await report(new Request(urlRoot + "/api/reports?" + latest().params.toString()));
      expect(response.status).toBe(200);
      await answer(response);
      return shownReport()!;
    }
    async function assertSurfaces(wanted: string[], omitted: string[]) {
      const props = shownReport()!;
      const print = new URL(props.printHref, urlRoot);
      expect(print.searchParams.get("from")).toBe(JUNE.from);
      expect(print.searchParams.get("to")).toBe(JUNE.to);
      expect(print.searchParams.get("expenseRecipient")).toBe(latest().params.get("expenseRecipient"));
      expect(print.searchParams.get("expenseCategory")).toBe(latest().params.get("expenseCategory"));
      expect(print.searchParams.get("currency")).toBe(latest().params.get("currency"));
      const printElement = await PrintPage({ searchParams: Promise.resolve(Object.fromEntries(print.searchParams)) });
      hooks.owner = hooks.make();
      const screen = renderToStaticMarkup(createElement(ReportView, props));
      hooks.owner = hooks.make();
      const official = renderToStaticMarkup(printElement);
      hooks.owner = hooks.make();
      const csvAction = walk(ReportView(props), "button").find(element =>
        Array.isArray(element.props.children) && element.props.children.includes("CSV"));
      expect(csvAction).toBeDefined();
      const anchor = { download: "", click: vi.fn(), remove: vi.fn() };
      vi.stubGlobal("document", { createElement: () => anchor, body: { appendChild: vi.fn() } });
      const createObjectUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:synthetic-expense");
      const revokeObjectUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
      let csv: string;
      try {
        (csvAction!.props.onClick as () => void)();
        expect(anchor.download).toBe("expense-payees.csv");
        expect(anchor.click).toHaveBeenCalledOnce();
        expect(createObjectUrl).toHaveBeenCalledOnce();
        csv = await (createObjectUrl.mock.calls[0][0] as Blob).text();
      } finally {
        createObjectUrl.mockRestore();
        revokeObjectUrl.mockRestore();
      }
      for (const output of [screen, official, csv]) {
        for (const reference of wanted) expect(output).toContain(reference);
        for (const reference of omitted) expect(output).not.toContain(reference);
      }
    }
    vi.stubGlobal("window", clientWindow);
    open();
    await actualRead();
    filter().onChange({ ...JUNE, currency: "all" });
    expect(selects().every(disabledSelect)).toBe(true);
    filter().onApply();
    const options = (await actualRead()).result.expenseFilterOptions!;
    const recordedOption = options.payees.find(option => option.label.startsWith(recorded + " (مطابقة"))!;
    const partyOption = options.payees.find(option => option.label.endsWith("(#" + account + ")"))!;
    const categoryOption = options.categories.find(option => option.label === categoryLabel)!;
    // Precomputed from the deployed sha256("payee\\0text:" + exact trimmed
    // recorded name). A saved pre-upgrade URL must never gain linked rows.
    const oldTextToken = "dfd93d782e2e38085819c75ca8c2ee2cb52824df42bc2380438b6a128d6f75a2";
    const unlinked = options.payees.find(option => option.value === oldTextToken);
    const legacySaved = normalizeSavedReportQuery("expense-payees", new URLSearchParams({
      report: "expense-payees", preset: JUNE.preset, from: JUNE.from, to: JUNE.to,
      expenseRecipient: oldTextToken, expenseCategory: categoryOption.value,
    }).toString());
    vi.stubGlobal("window", { ...clientWindow, location: new URL(urlRoot + "/reports?" + legacySaved.queryString) });
    page = hooks.make();
    form = hooks.make();
    renderPage();
    expect(latest().params.get("expenseRecipient")).toBe(oldTextToken);
    expect((await actualRead()).result.rows?.map(row => row.reference)).toEqual([legacy]);
    await assertSurfaces([legacy], [linked, ...excluded]);
    expect(unlinked?.label).toContain("غير مرتبطة بجهة");
    expect(recordedOption.value).not.toBe(oldTextToken);
    expect(recordedOption.value).not.toBe(partyOption.value);
    expect(selects()[0]).toContain(recordedOption.label);
    expect(selects()[0]).toContain(partyOption.label);

    filter().onChange({ expenseRecipient: recordedOption.value, expenseCategory: categoryOption.value });
    filter().onApply();
    const byName = (await actualRead()).result;
    expect(byName.rows?.map(row => [row.reference, row.currency, row.amount])).toEqual([[legacy, "SAR", 300], [linked, "YER", 800]]);
    await assertSurfaces([legacy, linked], excluded);

    filter().onChange({ currency: "SAR" });
    filter().onApply();
    const sar = (await actualRead()).result;
    expect(sar.expenseFilterOptions).toEqual(options);
    expect(sar.rows?.map(row => row.reference)).toEqual([legacy]);
    expect(formMarkup()).toContain("اختيار العملة يصفّي السندات فقط");
    await assertSurfaces([legacy], [linked, ...excluded]);

    filter().onChange({ expenseRecipient: partyOption.value });
    filter().onApply();
    const empty = (await actualRead()).result;
    expect(empty.expenseFilterOptions).toEqual(options);
    expect(empty.rows).toEqual([]);
    expect(formMarkup()).toContain("لا توجد سندات تطابق العملة والفلاتر");
    expect(formMarkup()).not.toContain("لا توجد سندات صرف مسجّلة في هذه الفترة");
    expect(selects()[0]).toContain(partyOption.label);
    filter().onChange({ currency: "YER" });
    filter().onApply();
    expect((await actualRead()).result.rows?.map(row => row.reference)).toEqual([linked]);
    await assertSurfaces([linked], [legacy, ...excluded]);
  } finally {
    await db.resetPoolForTesting();
    vi.unstubAllEnvs();
  }
}, 90_000);
