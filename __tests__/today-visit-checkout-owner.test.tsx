import { describe, expect, it, vi } from "vitest";
vi.mock("../components/ClinicalVisit", () => ({ ClinicalVisit: () => null }));
vi.mock("../components/CollectPaymentModal", () => ({ CollectPaymentModal: () => null }));
vi.mock("../components/patient/CheckoutExtras", () => ({ CheckoutExtras: () => null, isCheckoutWalkout: () => false }));
import { TodayVisitTab } from "../components/patient/TodayVisitTab";

const props = { patientId: 1, patientName: "مريض اصطناعي", summary: null, base: "YER" as const,
  visits: [], canCollect: true, onVisitStarted: () => {}, onChanged: () => {} };
describe("ordinary clinical draft and explicit checkout ownership", () => {
  it("never remounts the ordinary clinical editor merely because financial/workflow authority refreshes", () => {
    const before = TodayVisitTab(props), unavailable = TodayVisitTab({ ...props, canCollect: false }), recovered = TodayVisitTab(props);
    expect(before.key).toBe("1"); expect(unavailable.key).toBe(before.key); expect(recovered.key).toBe(before.key);
    expect(before.type).toBe(unavailable.type);
  });
  it("retires checkout-only ownership across visit or permission changes", () => {
    const selected = TodayVisitTab({ ...props, requestedCheckoutVisitId: 17 });
    expect(TodayVisitTab({ ...props, requestedCheckoutVisitId: 18 }).key).not.toBe(selected.key);
    expect(TodayVisitTab({ ...props, requestedCheckoutVisitId: 17, canCollect: false }).key).not.toBe(selected.key);
  });
});
