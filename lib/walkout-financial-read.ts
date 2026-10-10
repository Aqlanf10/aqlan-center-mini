import { CURRENCIES, isCurrency, type Currency } from "./money";
import type { VisitWalkout } from "./db";

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const amount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v);
export type BalanceRow = { currency: Currency; balanceMinor: number };
export type FinancialReadState = "loading" | "error" | "verified";
function moneyMap(v: unknown): v is Record<Currency, number> {
  return record(v) && Object.keys(v).length === CURRENCIES.length
    && CURRENCIES.every((currency) => amount(v[currency]));
}
export function workflowBalanceRows(payload: unknown, patientId: number): BalanceRow[] {
  if (!record(payload) || !record(payload.patient) || payload.patient.id !== patientId
    || payload.canSeeFinancial !== true || !record(payload.financial) || !record(payload.financial.byCurrency)) {
    throw new Error("Unverified financial owner");
  }
  const map = payload.financial.byCurrency;
  if (Object.keys(map).length !== CURRENCIES.length || !CURRENCIES.every((currency) =>
    record(map[currency]) && amount(map[currency].balanceMinor))) throw new Error("Incomplete financial currencies");
  return CURRENCIES.map((currency) => ({ currency, balanceMinor: (map[currency] as { balanceMinor: number }).balanceMinor }))
    .filter((row) => row.balanceMinor !== 0);
}
/** Called only after the existing clinical walkout validator. No coercion or accounting calculation. */
export function hasWalkoutFinancials(value: unknown, patientId: number, visitId: number): value is VisitWalkout {
  if (!record(value) || value.patientId !== patientId || value.visitId !== visitId
    || typeof value.signedAt !== "string" || !Number.isFinite(Date.parse(value.signedAt))
    || typeof value.arrivedAt !== "string" || !Number.isFinite(Date.parse(value.arrivedAt))
    || !record(value.checkout) || !moneyMap(value.checkout.previous) || !moneyMap(value.checkout.current)
    || !amount(value.checkout.invoicePaidMinor) || !Array.isArray(value.balances)) return false;
  if (value.invoice !== null && (!record(value.invoice) || !amount(value.invoice.id) || value.invoice.id <= 0
    || !isCurrency(value.invoice.currency) || !amount(value.invoice.netMinor) || value.invoice.netMinor < 0
    || !amount(value.invoice.netMinor - value.checkout.invoicePaidMinor))) return false;
  const seen = new Set<Currency>();
  const current = value.checkout.current;
  for (const row of value.balances) {
    if (!record(row) || !isCurrency(row.currency) || seen.has(row.currency) || !amount(row.balanceMinor)
      || row.balanceMinor !== current[row.currency]) return false;
    seen.add(row.currency);
  }
  return CURRENCIES.every((currency) => current[currency] === 0 || seen.has(currency));
}
