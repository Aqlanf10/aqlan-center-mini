import { expect, it } from "vitest";
import { createDisplayCallFreshness } from "../lib/display-call-freshness";
const iso = (millis: number) => new Date(Date.UTC(2026, 10, 20, 10) + millis).toISOString();
const call = (at: number | null, chair: number | null = 2) => ({ at: at === null ? null : iso(at), chair });

it("does not replay visible A after fresh B is suppressed and removed", () => {
  const machine = createDisplayCallFreshness();
  expect(machine.observe(iso(100), call(90, 1), true)).toBe(false);
  expect(machine.observe(iso(200), call(190, 1), false)).toBe(true);
  expect(machine.observe(iso(300), call(290, 2), false)).toBe(true);
  expect(machine.observe(iso(400), null, false)).toBe(false);
  expect(machine.observe(iso(500), call(190, 1), false)).toBe(false);
  expect(machine.observe(iso(600), call(590, 1), false)).toBe(true);
});
it("does not play a previously unseen hidden record when visibility expands", () => {
  const machine = createDisplayCallFreshness();
  expect(machine.observe(iso(100), null, true)).toBe(false);
  expect(machine.observe(iso(200), null, false)).toBe(false);
  expect(machine.observe(iso(300), call(180, 4), false)).toBe(false);
  expect(machine.observe(iso(400), call(390, 4), false)).toBe(true);
});
it("advances the baseline silently on first connect and reconnect, keeps older ages fenced", () => {
  const machine = createDisplayCallFreshness();
  expect(machine.observe(iso(100), null, true)).toBe(false);
  expect(machine.observe(iso(200), call(150), false)).toBe(true);
  expect(machine.observe(iso(500), call(400), true)).toBe(false);
  expect(machine.observe(iso(600), call(350), false)).toBe(false);
  expect(machine.observe(iso(700), call(690), false)).toBe(true);
});
it("rejects null timestamps, equal-time alternatives and regressing server clocks without moving the fence backwards", () => {
  const machine = createDisplayCallFreshness();
  expect(machine.observe(iso(100), null, true)).toBe(false);
  expect(machine.observe(iso(200), call(null), false)).toBe(false);
  expect(machine.observe(iso(250), call(230), false)).toBe(true);
  expect(machine.observe(iso(260), call(230, 1), false)).toBe(false);
  expect(machine.observe(iso(155), call(150), false)).toBe(false);
  expect(machine.observe(iso(300), call(290), false)).toBe(true);
});
