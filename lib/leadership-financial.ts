import type { ExecutiveKpis, PeriodPreset } from "./executive";
import { periodRange } from "./executive";
import { isCurrency } from "./money";
import { isOperationalDay } from "./leadership-operations";
import { clinicDateString } from "./schedule";
import { CLINIC_ZONE_FALLBACK } from "./clinicZone";

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);
const count = (value: unknown) => integer(value) && value >= 0;
export const validLeadershipRange = (from: string, to: string) => isOperationalDay(from) && isOperationalDay(to) && from <= to;

/** Existing presets use local date fields. Anchor those fields to the clinic calendar,
 * without changing the shared period/financial engines. */
export function leadershipPeriodRange(preset: PeriodPreset, now = new Date(), timeZone = CLINIC_ZONE_FALLBACK) {
  const day = clinicDateString(now, timeZone);
  const [year, month, date] = day.split("-").map(Number);
  return periodRange(preset, new Date(year, month - 1, date, 12));
}

function currencyRows(value: unknown, amounts: string[], extra?: (row: Record<string, unknown>) => boolean, unique = true) {
  if (!Array.isArray(value)) return false;
  const seen = new Set<string>();
  return value.every(row => {
    if (!object(row) || !isCurrency(row.currency) || unique && seen.has(row.currency)
      || amounts.some(key => !integer(row[key])) || extra && !extra(row)) return false;
    seen.add(row.currency);
    return true;
  });
}

/** Transport validation only. No financial derivation, currency substitution or
 * zero defaults; malformed/mismatched reads never reach money formatting. */
export function decodeLeadershipFinancial(value: unknown, from: string, to: string): ExecutiveKpis | null {
  if (!validLeadershipRange(from, to) || !object(value) || value.from !== from || value.to !== to || !isCurrency(value.baseCurrency)
    || !currencyRows(value.cashMovements, ["collectedMinor", "paidOutMinor", "netMinor"])
    || !currencyRows(value.billingByCurrency, ["grossMinor", "discountMinor", "netMinor"])
    || !currencyRows(value.receivableByCurrency, ["dueMinor"])
    || !currencyRows(value.expensesByCurrency, ["totalMinor"], group => Array.isArray(group.rows) && group.rows.every(row =>
      object(row) && typeof row.code === "string" && typeof row.name === "string" && integer(row.amountMinor)))
    || value.payableByCurrency !== undefined && !currencyRows(value.payableByCurrency, ["dueMinor"])
    || !currencyRows(value.parties, ["dueMinor"], row => typeof row.kind === "string" && typeof row.label === "string", false)
    || !object(value.operational) || !object(value.occupancy)) return null;
  const operational = ["arrived", "done", "stillOpen", "noShow", "cancelled", "newPatients", "totalPatients", "orthoActive", "orthoTotal", "inventoryAlerts"];
  const occupancy = ["chairs", "activeDays", "occupiedMinutes", "capacityMinutes", "pct"];
  if (operational.some(key => !count((value.operational as Record<string, unknown>)[key]))
    || occupancy.some(key => !count((value.occupancy as Record<string, unknown>)[key]))) return null;
  return value as unknown as ExecutiveKpis;
}
