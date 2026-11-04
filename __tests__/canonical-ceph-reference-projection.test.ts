import { expect, it } from "vitest";
import { isCanonicalCephReferenceCatalog, type CanonicalCephReferenceCatalog } from "../lib/canonical-ceph-reference-projection";

const saved = (): CanonicalCephReferenceCatalog => ({ projection: "ceph-reference-catalog", sets: [{
  key: "SYN-key", name: "SYN saved reference", population: null, ageMin: null, ageMax: null, sex: null,
  version: "SYN-v2", values: { SYN_OLD: { mean: 123.123456, sd: 0.125 } },
}] });
it("accepts stored precision, unknown historical codes, empty values and an honest empty catalogue", () => {
  const body = saved(); expect(isCanonicalCephReferenceCatalog(body)).toBe(true);
  expect(body.sets[0].values.SYN_OLD.mean).toBe(123.123456);
  body.sets[0].values = {}; expect(isCanonicalCephReferenceCatalog(body)).toBe(true);
  body.sets = []; expect(isCanonicalCephReferenceCatalog(body)).toBe(true);
});
it.each([null, {}, "legacy", { ...saved(), projection: "legacy" }, { ...saved(), sets: null }])("refuses a wrong envelope: %j", body => {
  expect(isCanonicalCephReferenceCatalog(body)).toBe(false);
});
it.each([
  { key: "" }, { name: " " }, { version: null }, { population: 4 }, { ageMin: -1 }, { ageMax: 1.5 },
  { ageMin: 18, ageMax: 10 }, { sex: "unknown" }, { values: [] }, { values: null },
  { values: { A: { mean: NaN, sd: 1 } } }, { values: { A: { mean: Infinity, sd: 1 } } },
  { values: { A: { mean: 2, sd: 0 } } }, { values: { A: { mean: 2, sd: Infinity } } },
  { values: { "": { mean: 2, sd: 1 } } },
])("refuses malformed stored reference fields: %j", patch => {
  const body = saved(); Object.assign(body.sets[0], patch); expect(isCanonicalCephReferenceCatalog(body)).toBe(false);
});
it("refuses duplicate sets and complete catalogues exceeding the supported bounds without truncation", () => {
  const body = saved(); body.sets.push({ ...body.sets[0] }); expect(isCanonicalCephReferenceCatalog(body)).toBe(false);
  body.sets = Array.from({ length: 201 }, (_, i) => ({ ...saved().sets[0], key: `SYN-${i}` }));
  expect(isCanonicalCephReferenceCatalog(body)).toBe(false);
  body.sets = saved().sets; body.sets[0].values = Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`SYN-${i}`, { mean: 1, sd: 1 }]));
  expect(isCanonicalCephReferenceCatalog(body)).toBe(false);
});
