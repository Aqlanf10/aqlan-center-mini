import { CURRENCIES, isCurrency, type Currency } from "@/lib/money";
import type { PartyKind } from "@/lib/expenses";

export const PARTY_BALANCE_VIEW = "party-balances-v1";

export interface PartyBalanceIdentity { id: number; name: string; kind: PartyKind }
export interface PartyNativeBalance { currency: Currency; dueMinor: number }

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const validId = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

export function partyBalanceIdentities(catalog: readonly PartyBalanceIdentity[]): Map<number, PartyBalanceIdentity> {
  if (!Array.isArray(catalog)) throw new Error("Invalid party catalog");
  const identities = new Map<number, PartyBalanceIdentity>();
  for (const party of catalog) {
    if (!object(party) || !validId(party.id) || identities.has(party.id)
      || typeof party.name !== "string" || !party.name.trim()
      || (party.kind !== "lab" && party.kind !== "supplier" && party.kind !== "doctor")) {
      throw new Error("Invalid party catalog");
    }
    identities.set(party.id, party);
  }
  return identities;
}

/** Validate the read DTO, never reconstruct balances or convert currencies.
 * Catalog and balance reads may straddle an identity change: reject that entire
 * snapshot rather than silently assigning a missing/mismatched party zero. */
export function readPartyNativeBalances(
  value: unknown,
  catalog: readonly PartyBalanceIdentity[],
): Map<number, PartyNativeBalance[]> {
  if (!object(value) || value.view !== PARTY_BALANCE_VIEW || !Array.isArray(value.balancesByCurrency)
    || !Array.isArray(value.partyIdentities)
    || typeof value.observedAt !== "string" || !Number.isFinite(Date.parse(value.observedAt))
    // This version emits Date#toISOString UTC timestamps. Exact round-trip
    // also rejects impossible calendar dates that Date.parse normalizes.
    || new Date(value.observedAt).toISOString() !== value.observedAt || !Array.isArray(catalog)) {
    throw new Error("Invalid native party balance response");
  }
  const catalogIdentities = partyBalanceIdentities(catalog);
  const identities = partyBalanceIdentities(value.partyIdentities as PartyBalanceIdentity[]);
  const expected = [...catalogIdentities.values()].filter((party) => party.kind !== "doctor");
  if (identities.size !== expected.length) throw new Error("Native party balance coverage changed");
  for (const party of identities.values()) {
    const catalogParty = catalogIdentities.get(party.id);
    if (party.kind === "doctor" || !catalogParty || party.kind !== catalogParty.kind || party.name !== catalogParty.name) {
      throw new Error("Native party balance coverage changed");
    }
  }
  // The native identity set and balances share one server read. Establish zero
  // only after complete catalog coverage matches, including parties with no
  // activity, so crossed creation/deletion reads cannot fabricate a zero.
  const balances = new Map<number, PartyNativeBalance[]>();
  for (const party of identities.values()) {
    balances.set(party.id, []);
  }
  for (const row of value.balancesByCurrency) {
    if (!object(row) || !validId(row.partyId) || !isCurrency(row.currency)
      || typeof row.dueMinor !== "number" || !Number.isSafeInteger(row.dueMinor) || row.dueMinor === 0
      || (row.kind !== "lab" && row.kind !== "supplier")) {
      throw new Error("Invalid native party balance row");
    }
    const party = identities.get(row.partyId);
    const buckets = balances.get(row.partyId);
    if (!party || !buckets || party.name !== row.name || party.kind !== row.kind
      || buckets.some((bucket) => bucket.currency === row.currency)) {
      throw new Error("Native party balance identity changed or duplicated");
    }
    buckets.push({ currency: row.currency, dueMinor: row.dueMinor });
  }
  for (const buckets of balances.values()) {
    buckets.sort((a, b) => CURRENCIES.indexOf(a.currency) - CURRENCIES.indexOf(b.currency));
  }
  // Only a completely valid success can establish zero-net (empty) buckets.
  return balances;
}
