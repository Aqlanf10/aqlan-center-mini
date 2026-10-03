import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionPayload } from "../lib/auth";
import { restrictedRouteAllowed } from "../lib/role-routes";
import { formatMoney, type Currency } from "../lib/money";
import type { TimelineEvent } from "../lib/workflow";

const mocks = vi.hoisted(() => ({
  session: vi.fn(), user: vi.fn(), owns: vi.fn(), ownedPatients: vi.fn(), todayVisit: vi.fn(), timeline: vi.fn(),
}));
const view = vi.hoisted(() => ({ cursor: 0, payload: null as unknown }));
vi.mock("../lib/session", () => ({ requireSession: mocks.session }));
vi.mock("../lib/db", () => ({
  patientTimeline: mocks.timeline, findUserByUsername: mocks.user,
  doctorOwnsPatient: mocks.owns, doctorOwnedPatientIds: mocks.ownedPatients, patientHasVisitToday: mocks.todayVisit,
}));
// Render actual component JSX with a validated resource snapshot. Lifecycle is
// separately exercised in patient-timeline-lifecycle.test.ts; no browser/HTTP claim.
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return {
    ...react,
    useState: (initial: unknown) => {
      const index = view.cursor++;
      return [index === 0 ? true : initial, () => {}];
    },
    useEffect: () => {},
  };
});
vi.mock("../components/patient/usePatientTimeline", async () => {
  const { readPatientTimeline } = await import("../lib/patient-timeline-read");
  return { usePatientTimeline: ({ readable }: { readable: boolean }) => {
    const payload = readable ? readPatientTimeline(view.payload, 91) : null;
    return { payload, error: payload ? null : "بيانات الخط الزمني غير مكتملة", reload: vi.fn() };
  } };
});
import { GET } from "../app/api/patients/[id]/timeline/route";
import { PatientTimeline } from "../components/patient/PatientTimeline";

const currencies: Currency[] = ["YER", "SAR", "USD"];
const fixture: TimelineEvent[] = currencies.flatMap((currency, index) => [{
  key: `invoice:${101 + index}`, kind: "invoice" as const,
  at: "2026-10-01T10:00:00.000Z", title: `فاتورة PRIVATE_INVOICE_${currency}`,
  detail: index === 2 ? "ملغاة" : null, amountMinor: 122667, currency,
  href: "/patients/91?tab=account",
}, {
  key: `payment:${201 + index}`, kind: "payment" as const,
  at: "2026-10-01T11:00:00.000Z", title: index === 2 ? "استرداد دفعة" : "دفعة",
  detail: "cash", amountMinor: 1250, currency, href: "/patients/91?tab=account",
}]);
const clinical: TimelineEvent = {
  key: "visit:301", kind: "visit", at: "2026-10-01T09:00:00.000Z",
  title: "Synthetic clinical event", detail: "Synthetic clinical detail",
  amountMinor: null, currency: null, href: "/visits/301/clinical",
  doctorName: "Synthetic doctor", specialties: ["rct"], caseTitle: "Synthetic clinical case",
};
fixture.push(clinical);

function session(role: string): SessionPayload {
  return { userId: 10, username: "synthetic-timeline-reader", role, partyId: 7, expiresAt: 0 };
}
const request = (id = "91") => GET(new Request(`http://test.invalid/api/patients/${id}/timeline`), {
  params: Promise.resolve({ id }),
});
function render(events: TimelineEvent[], base: Currency = "YER", sources = { plans: true, documents: true, financial: true, appointments: "all" as "all" | "scoped" | "hidden" }) {
  view.payload = { patientId: 91, events, sources, canSeeFinancial: sources.financial };
  view.cursor = 0;
  return renderToStaticMarkup(<PatientTimeline patientId={91} base={base} readable authorityKey="synthetic" />);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.session.mockResolvedValue(session("doctor"));
  mocks.user.mockResolvedValue({
    isActive: true, partyId: 7,
    permissions: { canViewAllPatients: false, canViewPatientPayments: true, canViewPlans: true, canViewXrays: true },
  });
  mocks.owns.mockResolvedValue(true);
  mocks.ownedPatients.mockResolvedValue(new Set([91]));
  mocks.todayVisit.mockResolvedValue(true);
  mocks.timeline.mockResolvedValue(fixture);
});
afterEach(() => { view.payload = null; view.cursor = 0; });

describe("unchanged timeline route gate with saved currencies", () => {
  it.each(["admin", "reception"])("preserves authorized %s currencies and exact event/clinical values", async (role) => {
    mocks.session.mockResolvedValue(session(role));
    const response = await request();
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toEqual({ patientId: 91, events: fixture, canSeeFinancial: true, sources: { plans: true, documents: true, financial: true, appointments: "all" } });
    expect(mocks.timeline).toHaveBeenCalledWith(91, 60, { plans: true, documents: true, financial: true, appointments: { kind: "all" } });
    expect(mocks.user).not.toHaveBeenCalled();
    const html = render(payload.events);
    for (const currency of currencies) {
      expect(html).toContain(formatMoney(122667, currency));
      expect(html).toContain(formatMoney(1250, currency));
    }
    expect(html).toContain(clinical.title);
    expect(html).toContain(clinical.detail);
    expect(html).not.toContain("المبلغ غير متاح");
  });

  it("keeps doctor money hidden even with canonical payment permission and valid currency data", async () => {
    const before = JSON.stringify(fixture);
    const response = await request();
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.canSeeFinancial).toBe(false);
    expect(mocks.owns).toHaveBeenCalledWith(7, 91);
    expect(payload.events.at(-1)).toEqual(clinical);
    const financial = payload.events.filter((event: TimelineEvent) => event.kind === "invoice" || event.kind === "payment");
    expect(financial).toHaveLength(0);
    expect(payload.events).toEqual([clinical]);
    expect(payload.sources.financial).toBe(false);
    const serialized = JSON.stringify(payload);
    for (const hidden of ["PRIVATE_INVOICE", "استرداد دفعة", "122667", "1250", "YER", "SAR", "USD", "cash", "tab=account", "invoice:", "payment:"]) {
      expect(serialized).not.toContain(hidden);
    }
    const html = render(payload.events, "YER", payload.sources);
    for (const currency of currencies) {
      expect(html).not.toContain(formatMoney(122667, currency));
      expect(html).not.toContain(formatMoney(1250, currency));
    }
    expect(html).not.toContain("المبلغ غير متاح");
    expect(html).toContain(clinical.title);
    expect(html).toContain(clinical.href);
    expect(JSON.stringify(fixture)).toBe(before);
  });

  it("omits denied money sources including unknown currency metadata", async () => {
    mocks.timeline.mockResolvedValue([{ ...fixture[0], currency: "UNKNOWN" }, clinical]);
    const payload = await (await request()).json();
    expect(payload.events).toEqual([clinical]);
    expect(JSON.stringify(payload)).not.toContain("UNKNOWN");
    expect(render(payload.events, "YER", payload.sources)).not.toContain("المبلغ غير متاح");
  });

  it("keeps an authenticated non-owning doctor outside the read", async () => {
    mocks.owns.mockResolvedValue(false);
    expect((await request()).status).toBe(403);
    expect(mocks.timeline).not.toHaveBeenCalled();
  });
  it("keeps missing sessions outside the read", async () => {
    mocks.session.mockResolvedValue(null);
    expect((await request()).status).toBe(401);
    expect(mocks.timeline).not.toHaveBeenCalled();
  });
  it("keeps malformed patient identifiers outside the read", async () => {
    expect((await request("invalid")).status).toBe(400);
    expect(mocks.timeline).not.toHaveBeenCalled();
  });
});

describe("actual timeline currency rendering", () => {
  it.each(currencies)("uses saved %s for unit scaling independently of the base prop", (currency) => {
    const event = { ...fixture[0], currency };
    const first = render([event], "YER");
    expect(first).toContain(formatMoney(event.amountMinor!, currency));
    expect(render([event], "SAR")).toBe(first);
    expect(render([event], "USD")).toBe(first);
    for (const other of currencies.filter((one) => one !== currency)) {
      expect(first).not.toContain(formatMoney(event.amountMinor!, other));
    }
  });

  it.each([null, undefined, "", "UNKNOWN", "usd", " SAR ", 1])(
    "does not format missing or malformed currency %s as the base", (currency) => {
      const event = { ...fixture[0], currency } as TimelineEvent;
      for (const base of currencies) {
        const html = render([event], base);
        expect(html).toContain("المبلغ غير متاح: العملة غير معروفة");
        expect(html).not.toContain("122667");
        for (const valid of currencies) expect(html).not.toContain(formatMoney(122667, valid));
      }
    },
  );

  it("does not add a payment plus sign when its monetary unit is unknown", () => {
    const html = render([{ ...fixture[1], currency: null }]);
    expect(html).toContain("المبلغ غير متاح: العملة غير معروفة");
    expect(html).not.toContain("+");
  });

  it.each(currencies)("still displays actual zero in %s, but renders no money for a clinical null amount", (currency) => {
    const html = render([{ ...fixture[0], amountMinor: 0, currency }, clinical]);
    expect(html).toContain(formatMoney(0, currency));
    expect(html).toContain(clinical.title);
    expect(html).toContain(clinical.href);
    expect(html).not.toContain("المبلغ غير متاح");
    expect(render([clinical])).not.toContain(formatMoney(0, currency));
  });
});

describe("bounded read projection source contract", () => {
  it("selects the saved invoice column and maps it without a fallback or arithmetic change", () => {
    const source = readFileSync("lib/db.ts", "utf8");
    const start = source.indexOf("export async function patientTimeline(");
    const end = source.indexOf("// ─── الأشعة والمستندات", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const timeline = source.slice(start, end);
    expect(timeline).toContain("SELECT id::text, invoice_number, total_minor, discount_minor, base_currency, status, created_at");
    const invoice = timeline.slice(timeline.indexOf("for (const row of invoices.rows)"), timeline.indexOf("for (const row of payments.rows)"));
    expect(invoice).toContain("amountMinor: Number(row.total_minor) - Number(row.discount_minor)");
    expect(invoice).toContain("currency: row.base_currency,");
    expect(invoice).not.toMatch(/COALESCE|requireCurrency|exchange_rate|\?\?|\|\|/);
    const payment = timeline.slice(timeline.indexOf("for (const row of payments.rows)"), timeline.indexOf("for (const row of labOrders.rows)"));
    expect(payment).toContain("amountMinor: Number(row.amount_minor)");
    expect(payment).toContain("currency: row.currency,");
  });
});

describe("timeline route source selection and truthful render", () => {
  it.each([false, true])("passes existing source grants to the single reader with plans=%s", async (plans) => {
    mocks.user.mockResolvedValue({ isActive: true, partyId: 7, permissions: {
      canViewAllPatients: true, canViewAllAppointments: false, canViewPlans: plans, canViewXrays: false, canViewPatientPayments: true,
    } });
    mocks.ownedPatients.mockResolvedValue(new Set());
    const payload = await (await request()).json();
    expect(mocks.timeline).toHaveBeenCalledWith(91, 60, { plans, documents: false, financial: false,
      appointments: { kind: "doctor", doctorPartyId: 7, ownedPatientIds: new Set() } });
    expect(payload.sources).toEqual({ plans, documents: false, financial: false, appointments: "scoped" });
    const html = render(payload.events, "YER", payload.sources);
    expect(html).toContain("المواعيد ضمن نطاق التقويم المتاح فقط");
    expect(html).not.toContain(">مالي<"); expect(html).not.toContain(">مستندات<");
    expect(html).not.toContain("تاريخ الرحلة كاملًا"); expect(html).not.toContain("tab=account");
  });
  it("omits denied plan/document sentinel metadata even from a defective mocked reader", async () => {
    mocks.user.mockResolvedValue({ isActive: true, partyId: 7, permissions: { canViewAllPatients: true } });
    const plan: TimelineEvent = { ...clinical, key: "plan:999", kind: "plan", title: "PLAN_SECRET", href: "/patients/91?tab=treatment" };
    const document: TimelineEvent = { ...clinical, key: "document:998", kind: "document", title: "FILE_SECRET", href: "/patients/91?tab=files" };
    mocks.timeline.mockResolvedValue([...fixture, plan, document]);
    const payload = await (await request()).json();
    expect(payload.events).toEqual([clinical]);
    for (const secret of ["PLAN_SECRET", "FILE_SECRET", "999", "998", "tab=files"]) expect(JSON.stringify(payload)).not.toContain(secret);
  });
  it("keeps doctor with all-calendar grant all-calendar but still denies timeline money", async () => {
    mocks.user.mockResolvedValue({ isActive: true, partyId: 7, permissions: { canViewAllPatients: true, canViewAllAppointments: true } });
    const payload = await (await request()).json();
    expect(payload.sources.appointments).toBe("all"); expect(payload.sources.financial).toBe(false);
  });
  it("fails calendar closed without a provider or all-calendar grant", async () => {
    mocks.session.mockResolvedValue({ ...session("doctor"), partyId: null });
    mocks.user.mockResolvedValue({ isActive: true, partyId: null, permissions: { canViewAllPatients: true } });
    const payload = await (await request()).json();
    expect(payload.sources.appointments).toBe("hidden");
  });
  it("keeps assistant proxy denial; direct handler unit grants no extra plan/document/money source", async () => {
    expect(restrictedRouteAllowed("assistant", "/api/patients/91/timeline", "GET")).toBe(false);
    mocks.session.mockResolvedValue(session("assistant"));
    const response = await request(); expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.sources).toEqual({ plans: false, documents: false, financial: false, appointments: "hidden" });
  });
  it.each(["cashier", "accountant"])("does not broaden admission for financial-only %s", async (role) => {
    mocks.session.mockResolvedValue(session(role));
    expect((await request()).status).toBe(403); expect(mocks.timeline).not.toHaveBeenCalled();
  });
  it("returns unavailable when the reader fails", async () => {
    mocks.timeline.mockRejectedValue(new Error("synthetic failure"));
    const response = await request(); expect(response.status).toBe(500);
    expect(await response.json()).not.toHaveProperty("events");
  });
  it("qualifies empty visible history and does not claim a complete record", () => {
    const html = render([], "YER", { plans: false, documents: false, financial: false, appointments: "scoped" });
    expect(html).toContain("لا أحداث متاحة في هذا الفلتر ضمن القراءة الحالية");
    expect(html).toContain("وليست سجلًا كاملًا");
    expect(html).not.toContain("تاريخ الرحلة كاملًا");
  });
  it("shows unavailable rather than empty or filters for legacy payloads", () => {
    view.payload = { events: [] }; view.cursor = 0;
    const html = renderToStaticMarkup(<PatientTimeline patientId={91} base="YER" />);
    expect(html).toContain("بيانات الخط الزمني غير مكتملة");
    expect(html).not.toContain("لا أحداث"); expect(html).not.toContain(">مالي<");
  });
});


describe("parent refresh recovery affordance", () => {
  it("offers the existing parent refresh after local invalidation instead of direct reauthorization", () => {
    view.payload = { patientId: 91, events: [], sources: { plans: false, documents: false, financial: false, appointments: "scoped" }, canSeeFinancial: false };
    view.cursor = 0;
    const refresh = vi.fn();
    const tree = PatientTimeline({ patientId: 91, base: "YER", readable: false, onRefresh: refresh });
    type Element = { type?: unknown; props?: { children?: unknown; onClick?: () => void; disabled?: boolean } };
    function find(value: unknown): Element | null {
      if (Array.isArray(value)) { for (const child of value) { const found = find(child); if (found) return found; } return null; }
      if (!value || typeof value !== "object") return null;
      const node = value as Element;
      if (node.type === "button" && node.props?.children === "تحديث ملف المريض") return node;
      return find(node.props?.children);
    }
    const button = find(tree); expect(button).not.toBeNull(); expect(button?.props?.disabled).toBe(false);
    button?.props?.onClick?.(); expect(refresh).toHaveBeenCalledTimes(1);
  });
});
