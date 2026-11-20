import { expect, it, vi } from "vitest";
import { clearNumberingReceipt, readPendingNumberingReceipt, rememberNumberingReceipt } from "../components/settings/patient-numbering-receipt-journal";
function tab(existing?: Map<string, string>) {
  const values = existing ?? new Map<string, string>();
  return { values, getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => { values.set(k, v); }, removeItem: (k: string) => { values.delete(k); } };
}
const id = "synthetic_pending_request_01", other = "synthetic_pending_request_02";
it("stores only the non-secret request reference, recovers after reload and permits only exact retry", () => {
  const first = tab();
  expect(rememberNumberingReceipt(first, id)).toBe("first");
  expect([...first.values.values()]).toEqual([id]);
  const reloaded = tab(first.values);
  expect(readPendingNumberingReceipt(reloaded)).toEqual({ ok: true, requestId: id });
  expect(rememberNumberingReceipt(reloaded, id)).toBe("retry");
  expect(rememberNumberingReceipt(reloaded, other)).toBe("hold");
  expect(clearNumberingReceipt(reloaded, other)).toBe(false);
  expect(clearNumberingReceipt(reloaded, id)).toBe(true);
  expect(readPendingNumberingReceipt(reloaded)).toEqual({ ok: true, requestId: null });
});
it("holds on unavailable or non-persistent browser storage", () => {
  expect(rememberNumberingReceipt(null, id)).toBe("hold");
  const store = tab(); store.setItem = vi.fn();
  expect(rememberNumberingReceipt(store, id)).toBe("hold");
  expect(rememberNumberingReceipt(store, "invalid")).toBe("hold");
});
it("cannot clear another in-flight ID or proceed with a corrupt notebook", () => {
  const store = tab(); rememberNumberingReceipt(store, id);
  const key = [...store.values.keys()][0];
  store.values.set(key, "corrupt");
  expect(readPendingNumberingReceipt(store)).toEqual({ ok: false });
  expect(rememberNumberingReceipt(store, other)).toBe("hold");
  expect(clearNumberingReceipt(store, id)).toBe(false);
});
