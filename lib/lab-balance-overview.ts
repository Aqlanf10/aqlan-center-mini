import { CURRENCIES, isCurrency, type Currency } from "@/lib/money";

export const LAB_BALANCE_VIEW = "lab-balances-v1";
export interface LabNetBucket { currency: Currency; netMinor: number }
export interface LabNetBalance {
  state: "ready";
  scope: "whole_party";
  byCurrency: LabNetBucket[];
}
export interface LabBalanceRow {
  partyId: number;
  partyName: string;
  preferredCurrency: Currency;
  phone: string | null;
  partyNetBalance: LabNetBalance;
}
export interface LabBalanceOverview {
  version: typeof LAB_BALANCE_VIEW;
  observedAt: string;
  labs: LabBalanceRow[];
}
export type LabBalanceReadState =
  | { phase: "ready"; data: LabBalanceOverview }
  | { phase: "loading" | "error" | "unavailable"; data: null };

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const validId = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const minor = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);
const name = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

/** DTO projection only: balances come exclusively from partyDueByCurrency /
 * partyBuckets. No costs, statuses, ledger reconstruction or FX conversion. */
export function projectLabBalanceOverview(catalog: unknown, canonicalRows: unknown, observedAt: string): LabBalanceOverview {
  if (!Array.isArray(catalog) || !Array.isArray(canonicalRows)) throw new Error("Lab balance source unavailable");
  const labs = new Map<number, LabBalanceRow>();
  for (const party of catalog) {
    if (!object(party) || party.kind !== "lab" || !validId(party.id) || labs.has(party.id)
      || !name(party.name) || !isCurrency(party.currency) || !(party.phone === null || typeof party.phone === "string")) {
      throw new Error("Invalid lab balance identity");
    }
    // Inactive catalog entries remain visible; preferred currency is metadata only.
    labs.set(party.id, { partyId: party.id, partyName: party.name, preferredCurrency: party.currency,
      phone: party.phone, partyNetBalance: { state: "ready", scope: "whole_party", byCurrency: [] } });
  }
  for (const row of canonicalRows) {
    if (!object(row) || (row.kind !== "lab" && row.kind !== "supplier")) throw new Error("Invalid canonical party balance");
    if (row.kind !== "lab") continue;
    if (!validId(row.partyId) || !isCurrency(row.currency) || !minor(row.dueMinor)) throw new Error("Invalid canonical lab balance");
    const lab = labs.get(row.partyId);
    // Separate canonical/catalog reads can observe a concurrent catalog change.
    // Fail unavailable rather than dropping a nonzero lab or guessing its identity.
    if (!lab || lab.partyNetBalance.byCurrency.some((bucket) => bucket.currency === row.currency)) {
      throw new Error("Lab balance catalog changed");
    }
    lab.partyNetBalance.byCurrency.push({ currency: row.currency, netMinor: row.dueMinor });
  }
  for (const lab of labs.values()) lab.partyNetBalance.byCurrency.sort((a, b) => CURRENCIES.indexOf(a.currency) - CURRENCIES.indexOf(b.currency));
  return readLabBalanceOverview({ version: LAB_BALANCE_VIEW, observedAt, labs: [...labs.values()] });
}

/** Explicit successful empty buckets mean zero. Missing/malformed JSON never does. */
export function readLabBalanceOverview(value: unknown): LabBalanceOverview {
  if (!object(value) || value.version !== LAB_BALANCE_VIEW || typeof value.observedAt !== "string"
    || !Number.isFinite(Date.parse(value.observedAt)) || !Array.isArray(value.labs)) throw new Error("Invalid lab balance overview");
  const ids = new Set<number>();
  const labs = value.labs.map((row: unknown): LabBalanceRow => {
    if (!object(row) || !validId(row.partyId) || ids.has(row.partyId) || !name(row.partyName)
      || !isCurrency(row.preferredCurrency) || !(row.phone === null || typeof row.phone === "string")
      || !object(row.partyNetBalance) || row.partyNetBalance.state !== "ready" || row.partyNetBalance.scope !== "whole_party"
      || !Array.isArray(row.partyNetBalance.byCurrency)) throw new Error("Invalid lab balance row");
    ids.add(row.partyId);
    const currencies = new Set<Currency>();
    const byCurrency = row.partyNetBalance.byCurrency.map((bucket: unknown): LabNetBucket => {
      if (!object(bucket) || !isCurrency(bucket.currency) || currencies.has(bucket.currency) || !minor(bucket.netMinor)) throw new Error("Invalid lab balance bucket");
      currencies.add(bucket.currency);
      return { currency: bucket.currency, netMinor: bucket.netMinor };
    });
    return { partyId: row.partyId, partyName: row.partyName, preferredCurrency: row.preferredCurrency,
      phone: row.phone, partyNetBalance: { state: "ready", scope: "whole_party", byCurrency } };
  });
  // Validate safe same-currency addition before admitting any ready snapshot.
  sumLabNetBalances(labs);
  return { version: LAB_BALANCE_VIEW, observedAt: value.observedAt, labs };
}

/** Same-currency addition, not a ledger formula. Keep zero-net buckets because
 * opposite signed balances across labs may cancel without clearing either lab. */
export function sumLabNetBalances(labs: readonly LabBalanceRow[]): LabNetBucket[] {
  const totals = new Map<Currency, number>();
  for (const lab of labs) for (const bucket of lab.partyNetBalance.byCurrency) {
    const total = (totals.get(bucket.currency) ?? 0) + bucket.netMinor;
    if (!Number.isSafeInteger(total)) throw new Error("Lab balance aggregate exceeds safe range");
    totals.set(bucket.currency, total);
  }
  return CURRENCIES.filter((currency) => totals.has(currency)).map((currency) => ({ currency, netMinor: totals.get(currency)! }));
}
