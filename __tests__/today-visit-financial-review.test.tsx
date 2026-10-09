import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TodayVisitTab } from "../components/patient/TodayVisitTab";
import { formatMoney } from "../lib/money";

// Render the actual parent view with a current, already-restored read projection.
// No routes/database or asynchronous effects run in this focused presentation test.
const state = vi.hoisted(() => ({ cursor: 0, review: false as boolean | null, invoiceId: null as number | null,
  dues: 0, balance: 0, read: "verified" as "verified" | "loading" | "error" }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return { ...react,
    useState: (initial: unknown) => {
      const index = state.cursor++;
      const value = index === 8 ? { visitId: 10, financialReviewRequired: state.review, duesMinor: state.dues,
        remainingMinor: state.dues, invoiceCurrency: "YER", invoiceId: state.invoiceId, sessionsCompleted: 0,
        nextPlannedVisit: null, labOrdersCreated: 0, materialsDeducted: 0 }
        : index === 9 ? state.read : index === 4 || index === 5 ? (state.balance ? [{ currency: "YER", balanceMinor: state.balance }] : [])
          : typeof initial === "function" ? initial() : initial;
      return [value, () => undefined];
    },
    useRef: (initial: unknown) => ({ current: initial }), useCallback: (callback: unknown) => callback,
    useMemo: (make: () => unknown) => make(), useEffect: () => undefined,
  };
});
vi.mock("../components/ClinicalVisit", () => ({ ClinicalVisit: () => null }));
vi.mock("../components/CollectPaymentModal", () => ({ CollectPaymentModal: () => null }));
vi.mock("../components/patient/CheckoutExtras", () => ({ CheckoutExtras: () => null, isCheckoutWalkout: () => true }));
const render = () => {
  state.cursor = 0;
  return renderToStaticMarkup(TodayVisitTab({ patientId: 1, patientName: "Synthetic", summary: null,
    base: "YER", visits: [], canCollect: true, onVisitStarted: () => undefined, onChanged: () => undefined }));
};
beforeEach(() => { state.review = false; state.invoiceId = null; state.dues = 0; state.balance = 0; state.read = "verified"; });

describe("restored checkout review precedence", () => {
  it.each(["loading", "error"] as const)("does not infer zero while balances are %s", (read) => {
    state.read = read;
    const html = render();
    expect(html).not.toContain("لا مبلغ مطلوب لهذه الزيارة");
    expect(html).toContain("الرصيد غير متحقق");
  });

  it.each([true, null])("does not turn unresolved or unavailable coverage %s into a zero-owed claim", (review) => {
    state.review = review;
    const html = render();
    expect(html).toContain('data-testid="checkout-financial-review"');
    expect(html).not.toContain("لا مبلغ مطلوب لهذه الزيارة");
    expect(html).not.toContain("استحقاق اليوم</dt>");
    expect(html).toContain("التحقق من تغطية العمل ما زال مطلوبًا");
  });
  it("keeps separately established invoice and previous debt available for normal settlement", () => {
    state.review = true; state.invoiceId = 20; state.dues = 225500; state.balance = 50000;
    const html = render();
    expect(html).toContain(formatMoney(225500, "YER"));
    expect(html).toContain(formatMoney(50000, "YER"));
    expect(html).toContain("تحصيل وطباعة السند");
    expect(html).toContain("فاتورة اليوم المثبتة");
  });
  it("preserves verified no-additional-bill behavior when the canonical read has no review flag", () => {
    expect(render()).toContain("لا مبلغ مطلوب لهذه الزيارة");
  });
});
