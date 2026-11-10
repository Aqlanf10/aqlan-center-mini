import { describe, expect, it } from "vitest";
import { makeOrthoWorkupOwners } from "../components/OrthoWorkupOwners";

describe("existing child owners participate in workup navigation", () => {
  it("reads live mutation latches synchronously without a render or notification", () => {
    const registry = makeOrthoWorkupOwners();
    const state = { active: true, busy: false, dirty: false };
    registry.register(21, () => state);
    expect(registry.pending()).toBe(false);
    state.busy = true;
    expect(registry.pending(21)).toBe(true);
    state.busy = false;
    state.dirty = true;
    expect(registry.pending()).toBe(false);
    expect(registry.dirty(21)).toBe(true);
    state.active = false;
    expect(registry.dirty()).toBe(false);
  });

  it("separates case scope and removes only the exact registration on cleanup", () => {
    const registry = makeOrthoWorkupOwners();
    const state = { active: true, busy: true, dirty: true };
    const retireOld = registry.register(21, () => state);
    const retireNew = registry.register(21, () => state);
    const retireOther = registry.register(22, () => state);
    expect(registry.pending(23)).toBe(false);
    retireOld(); retireOld();
    expect(registry.pending(21)).toBe(true);
    retireNew();
    expect(registry.pending(21)).toBe(false);
    expect(registry.pending()).toBe(true);
    expect(registry.dirty(22)).toBe(true);
    retireOther();
    expect(registry.pending()).toBe(false);
    expect(registry.dirty()).toBe(false);
  });

  it("does not carry registrations between patient/authority registries or accept invalid cases", () => {
    const prior = makeOrthoWorkupOwners(), next = makeOrthoWorkupOwners();
    const state = { active: true, busy: true, dirty: true };
    prior.register(21, () => state);
    expect(next.pending(21)).toBe(false);
    for (const caseId of [0, -1, NaN, 1.5, 2147483648]) next.register(caseId, () => state)();
    expect(next.pending()).toBe(false);
    expect(next.dirty()).toBe(false);
  });
});
