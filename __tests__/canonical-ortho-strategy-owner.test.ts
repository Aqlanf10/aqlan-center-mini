import { describe, expect, it, vi } from "vitest";
import { makeCanonicalStrategyOwner } from "../lib/canonical-ortho-strategy-owner";
function fixture() {
  let allowed = true;
  const denied = vi.fn(() => { allowed = false; owner.retire(); });
  const owner = makeCanonicalStrategyOwner({ authorized: () => allowed, deny: denied });
  return { owner, life: owner.lifetime, denied, allow: (value: boolean) => { allowed = value; } };
}
describe("canonical strategy adapter to existing mutation transitions", () => {
  it("retains exact in-memory draft through a parent read without replacing its identity", () => {
    const { owner, life } = fixture(), identity = life.identity;
    life.settle("document", "baseline"); life.change("document", "exact frozen bytes"); owner.invalidateRead();
    expect(life.identity).toBe(identity); expect(life.values.document).toBe("exact frozen bytes"); expect(life.dirty).toBe(true);
    expect(owner.canLeave(() => false)).toBe(false); expect(owner.canLeave(() => true)).toBe(true);
  });
  it("a real pending command cannot be duplicated, changed, settled or left", () => {
    const { owner, life } = fixture(); life.settle("document", "exact"); const op = life.begin()!;
    expect(op.current()).toBe(true); expect(life.begin()).toBeNull(); life.change("document", "changed"); life.settle("document", "");
    expect(life.values.document).toBe("exact"); expect(owner.canLeave(() => true)).toBe(false); expect(owner.needsUnloadWarning()).toBe(true);
    op.finish(); expect(life.busy).toBe(false); expect(life.uncertain).toBe(false);
  });
  it("refresh retires a late success; only explicit identical retry can reconcile it", () => {
    const { owner, life } = fixture(); life.settle("document", "exact"); const op = life.begin()!; owner.invalidateRead();
    expect(op.current()).toBe(false); expect(life.uncertain).toBe(true); expect(life.beginRetry!()).toBeNull(); op.finish();
    expect(life.values.document).toBe("exact"); expect(life.begin()).toBeNull();
    const retry = life.beginRetry!()!; expect(retry.current()).toBe(true); retry.finish(); life.settle("document", "");
    expect(life.uncertain).toBe(false); expect(life.values.document).toBe("");
  });
  it("lost response preserves exact bytes and freezes editing until explicit retry", () => {
    const { life } = fixture(); life.settle("document", "frozen"); const op = life.begin()!; op.markUncertain(); op.finish();
    life.change("document", "bad"); life.settle("document", ""); expect(life.values.document).toBe("frozen");
    const retry = life.beginRetry!()!; retry.markUncertain(); retry.finish(); expect(life.uncertain).toBe(true);
  });
  it("failed retry admission keeps the original uncertainty", () => {
    const { life, allow } = fixture(); const op = life.begin()!; op.markUncertain(); op.finish(); allow(false);
    expect(life.beginRetry!()).toBeNull(); expect(life.uncertain).toBe(true);
  });
  it.each([401, 403])("denial%d retires private bytes, callbacks and future commands", status => {
    const { owner, life, denied } = fixture(); life.settle("document", "private"); const op = life.begin()!;
    expect(op.checkHeaders(new Response(null, { status }))).toBe(false); expect(denied).toHaveBeenCalledTimes(1);
    expect(life.active()).toBe(false); expect(life.values.document).toBe(""); op.finish(); life.change("document", "private again");
    expect(life.values.document).toBe(""); expect(life.begin()).toBeNull(); owner.retire();
  });
  it("a late response from an invalidated read cannot deny a new view", () => {
    const { owner, life, denied } = fixture(); const op = life.begin()!; owner.invalidateRead();
    expect(op.checkHeaders(new Response(null, { status: 403 }))).toBe(false); expect(denied).not.toHaveBeenCalled(); op.finish();
  });
  it("retirement is permanent and clears clinical text; no storage API is used", () => {
    const { owner, life } = fixture(); life.change("document", "private"); owner.retire();
    expect(life.values.document).toBe(""); expect(life.active()).toBe(false); expect(life.begin()).toBeNull();
  });
  it("notifies mounted views and advances only explicit refresh reads", () => {
    const { owner, life } = fixture(), listener = vi.fn(); const stop = owner.subscribe(listener);
    life.settle("document", "baseline"); expect(listener).toHaveBeenCalledTimes(1); expect(life.readVersion).toBe(0);
    life.refresh(); expect(life.readVersion).toBe(1); stop(); life.refresh(); expect(listener).toHaveBeenCalledTimes(2);
  });
});
it.each([false,true])("retiring an unresolved owner releases navigation without resurrecting private bytes (busy=%s)",busy=>{
  const {owner,life}=fixture();life.settle("document","private receipt");const op=life.begin()!;op.markUncertain();if(!busy)op.finish();owner.retire();
  expect(owner.canLeave(()=>false)).toBe(true);expect(owner.needsUnloadWarning()).toBe(false);expect(life.values.document).toBe("");
  op.finish();expect(life.values.document).toBe("");expect(owner.canLeave(()=>false)).toBe(true);
});
