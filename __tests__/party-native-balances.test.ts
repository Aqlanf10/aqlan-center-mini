import { describe, expect, it } from "vitest";
import { PARTY_BALANCE_VIEW, readPartyNativeBalances, type PartyBalanceIdentity } from "@/lib/party-native-balances";

const catalog: PartyBalanceIdentity[] = [
  { id: 1, name: "مختبر تجريبي", kind: "lab" },
  { id: 2, name: "مورد تجريبي", kind: "supplier" },
  { id: 3, name: "طبيب تجريبي", kind: "doctor" },
];
const usd = { partyId: 1, name: catalog[0].name, kind: "lab", currency: "USD", dueMinor: 10000 };
const payload = (rows: unknown[] = [usd], identities: unknown[] = catalog.filter((party) => party.kind !== "doctor")) => ({
  view: PARTY_BALANCE_VIEW, observedAt: "2026-10-09T00:00:00.000Z", partyIdentities: identities, balancesByCurrency: rows,
});

describe("native party balance DTO admission", () => {
  it("preserves signed native buckets without offsetting different currencies", () => {
    const map = readPartyNativeBalances(payload([
      usd,
      { ...usd, currency: "SAR", dueMinor: -10000 },
      { ...usd, currency: "YER", dueMinor: 2500 },
    ]), catalog);
    expect(map.get(1)).toEqual([
      { currency: "YER", dueMinor: 2500 },
      { currency: "SAR", dueMinor: -10000 },
      { currency: "USD", dueMinor: 10000 },
    ]);
    expect(map.get(2)).toEqual([]);
    expect(map.has(3)).toBe(false);
  });

  it("admits explicit successful empty results as whole-party zero only", () => {
    expect([...readPartyNativeBalances(payload([]), catalog)]).toEqual([[1, []], [2, []]]);
    expect([...readPartyNativeBalances(payload([], []), [])]).toEqual([]);
    expect([...readPartyNativeBalances(payload([], []), [catalog[2]])]).toEqual([]);
  });

  it.each([
    null,
    {},
    { balances: [], baseCurrency: "YER" },
    { ...payload(), view: "party-balances-v2" },
    { ...payload(), observedAt: "2026" },
    { ...payload(), observedAt: "invalid" },
    { ...payload(), observedAt: "2026-10-09T00:00:00" },
    { ...payload([]), observedAt: "2026-02-30T00:00:00.000Z" },
    { ...payload([]), observedAt: "2026-02-29T00:00:00.000Z" },
    { ...payload([]), observedAt: "2024-02-30T00:00:00.000Z" },
    { ...payload(), observedAt: "2026-10-09T03:00:00.000+03:00" },
    { ...payload(), balancesByCurrency: null },
    { ...payload(), partyIdentities: undefined },
    { ...payload(), partyIdentities: null },
    { ...payload(), partyIdentities: {} },
    payload([], [catalog[0], catalog[1], catalog[1]]),
    payload([], [catalog[0], catalog[2]]),
    payload([], [{ ...catalog[0], name: " " }, catalog[1]]),
    payload([], [catalog[0], { ...catalog[1], kind: "other" }]),
    payload([usd, usd]),
    payload([{ ...usd, currency: "EUR" }]),
    payload([{ ...usd, dueMinor: "10000" }]),
    payload([{ ...usd, dueMinor: 0 }]),
    payload([{ ...usd, dueMinor: 0.5 }]),
    payload([{ ...usd, dueMinor: Number.MAX_SAFE_INTEGER + 1 }]),
    payload([{ ...usd, dueMinor: NaN }]),
    payload([{ ...usd, dueMinor: Infinity }]),
    payload([{ ...usd, partyId: 99 }]),
    payload([{ ...usd, partyId: -1 }]),
    payload([{ ...usd, name: "اسم آخر" }]),
    payload([{ ...usd, kind: "supplier" }]),
    payload([{ ...usd, partyId: 3, name: catalog[2].name, kind: "doctor" }]),
  ])("rejects the entire malformed or mismatched snapshot %#", (value) => {
    expect(() => readPartyNativeBalances(value, catalog)).toThrow();
  });

  it("rejects duplicate or malformed catalog identities even for an empty balance result", () => {
    expect(() => readPartyNativeBalances(payload([]), [catalog[0], catalog[0]])).toThrow();
    expect(() => readPartyNativeBalances(payload([]), [{ ...catalog[0], name: " " }])).toThrow();
    expect(() => readPartyNativeBalances(payload([]), [null as unknown as PartyBalanceIdentity])).toThrow();
  });

  it("rejects native coverage from before a zero-activity party was created and admits a matching retry", () => {
    // Party 2 exists in the newer catalog but has no financial buckets at all.
    expect(() => readPartyNativeBalances(payload([], [catalog[0]]), catalog)).toThrow();
    expect([...readPartyNativeBalances(payload([]), catalog)]).toEqual([[1, []], [2, []]]);
  });

  it("rejects native coverage from before a zero-activity party was deleted and admits a matching retry", () => {
    const afterDeletion = [catalog[0], catalog[2]];
    expect(() => readPartyNativeBalances(payload([]), afterDeletion)).toThrow();
    expect([...readPartyNativeBalances(payload([], [catalog[0]]), afterDeletion)]).toEqual([[1, []]]);
    expect(() => readPartyNativeBalances(payload([]), [])).toThrow();
    expect([...readPartyNativeBalances(payload([], []), [])]).toEqual([]);
  });

  it("rejects same-sized but incorrect identity coverage even when every balance is zero", () => {
    expect(() => readPartyNativeBalances(payload([], [catalog[0], { ...catalog[1], id: 99 }]), catalog)).toThrow();
    expect(() => readPartyNativeBalances(payload([], [catalog[0], { ...catalog[1], name: "اسم قديم" }]), catalog)).toThrow();
    expect(() => readPartyNativeBalances(payload([], [catalog[0], { ...catalog[1], kind: "lab" }]), catalog)).toThrow();
  });

  it("rejects balance rows outside the authoritative identity set", () => {
    expect(() => readPartyNativeBalances(payload([{ ...usd, partyId: 99 }]), catalog)).toThrow();
    expect(() => readPartyNativeBalances(payload([usd], []), [])).toThrow();
  });

  it("accepts a valid leap-day timestamp in the server's canonical UTC format", () => {
    expect([...readPartyNativeBalances({ ...payload([]), observedAt: "2024-02-29T00:00:00.000Z" }, catalog)])
      .toEqual([[1, []], [2, []]]);
  });

  it("admits safe negative boundaries without imposing base-currency arithmetic", () => {
    expect(readPartyNativeBalances(payload([{ ...usd, dueMinor: -Number.MAX_SAFE_INTEGER }]), catalog).get(1))
      .toEqual([{ currency: "USD", dueMinor: -Number.MAX_SAFE_INTEGER }]);
  });
});
