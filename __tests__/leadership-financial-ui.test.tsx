import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { FinancialReadout } from "../components/leadership/ExecutiveFinancialOverview";
import { leadershipFinancialFixture as fixture } from "./fixtures/leadership-financial";
import { formatMoney } from "../lib/money";

it("renders native-currency cash movement without billing, debt or a mixed-currency profit",()=>{
 const feed=fixture(),before=structuredClone(feed),html=renderToStaticMarkup(<FinancialReadout feed={feed} view="cash"/>);
 for(const row of feed.cashMovements)for(const amount of [row.collectedMinor,row.paidOutMinor,row.netMinor])expect(html).toContain(formatMoney(amount,row.currency));
 expect(html).not.toContain(formatMoney(feed.billingByCurrency[0].grossMinor,"YER"));expect(html).toContain("ليس ربحًا");expect(html).toContain("ليس الرصيد الحالي");expect(feed).toEqual(before);
});
it("presents billing and expense values unchanged without duplicating a default total table",()=>{
 const feed=fixture(),html=renderToStaticMarkup(<FinancialReadout feed={feed} view="billing"/>);
 for(const row of feed.billingByCurrency)for(const amount of [row.grossMinor,row.discountMinor,row.netMinor])expect(html).toContain(formatMoney(amount,row.currency));
 expect(html).toContain("تفصيل بنود المصروفات");expect(html).toContain(formatMoney(6003,"SAR"));expect(html).not.toContain("<table");expect(html).toContain("لا إثبات تحصيل");
});
it("separates period-end patient receivables from current party balances and hides admin routes for the standalone view",()=>{
 const feed=fixture(),html=renderToStaticMarkup(<FinancialReadout feed={feed} view="debts"/>);
 expect(html).toContain("تراكمي حتى نهاية الفترة");expect(html).toContain("رصيد الجهات الحالي");expect(html).toContain("2026-07-31");
 expect(html).toContain(formatMoney(45003,"YER"));expect(html).toContain(formatMoney(11005,"USD"));expect(html).toContain(formatMoney(71006,"SAR"));expect(html).not.toContain('href="/finance');
 expect(renderToStaticMarkup(<FinancialReadout feed={feed} view="debts" showAdminLinks/>)).toContain('href="/finance/parties"');
});
it("does not render large zero-currency cards or a fabricated occupancy percentage without capacity",()=>{
 const feed=fixture();feed.cashMovements=[{currency:"YER",collectedMinor:0,paidOutMinor:0,netMinor:0}];
 const cash=renderToStaticMarkup(<FinancialReadout feed={feed} view="cash"/>);expect(cash).toContain("لا حركة نقدية مسجّلة");expect(cash).toContain("عملات بلا حركة");expect(cash).not.toContain("<article");
 const operational=renderToStaticMarkup(<FinancialReadout feed={feed} view="operations"/>);expect(operational).toContain("غير قابل للحساب");expect(operational).not.toContain("0%");expect(operational).toContain("ليست نسبة حضور الأطباء");
});
it("does not convert absent party-balance evidence to a base-currency zero",()=>{
 const feed=fixture();Reflect.deleteProperty(feed,"payableByCurrency");
 const html=renderToStaticMarkup(<FinancialReadout feed={feed} view="debts"/>);expect(html).toContain("بيانات ذمم الجهات غير متاحة");expect(html).not.toContain(formatMoney(0,"YER"));
});
