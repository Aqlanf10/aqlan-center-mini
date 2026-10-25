import { executiveKpis, type ExecutiveKpis } from "../../lib/executive";

/** Synthetic transport fixture for financial presentation; never clinic data. */
export const leadershipFinancialFixture=():ExecutiveKpis=>({
 ...executiveKpis({from:"2026-07-01",to:"2026-07-31",baseCurrency:"YER",billingByCurrency:[],receivableByCurrency:[],periodBalances:[],cumulativeBalances:[],parties:[],operational:{},occupancy:{chairs:2,activeDays:0,occupiedMinutes:0,capacityMinutes:0,pct:0}}),
 billingByCurrency:[{currency:"YER",grossMinor:130001,discountMinor:10000,netMinor:120001},{currency:"SAR",grossMinor:90001,discountMinor:20000,netMinor:70001}],
 cashMovements:[{currency:"YER",collectedMinor:80003,paidOutMinor:10002,netMinor:70001},{currency:"USD",collectedMinor:10005,paidOutMinor:2001,netMinor:8004}],
 expensesByCurrency:[{currency:"SAR",totalMinor:6003,rows:[{code:"5201",name:"مواد اصطناعية",amountMinor:6003}]}],
 receivableByCurrency:[{currency:"YER",dueMinor:45003},{currency:"USD",dueMinor:11005}],
 payableByCurrency:[{currency:"SAR",dueMinor:71006}],parties:[{kind:"lab",label:"معمل اصطناعي",currency:"SAR",dueMinor:71006}],
});
