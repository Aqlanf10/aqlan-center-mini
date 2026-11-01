import { expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { canonicalCephCreateQuery } from "../lib/canonical-ceph-create-context";
import { isCanonicalCephCreateContext } from "../lib/canonical-ceph-create-projection";
const context = () => ({ projection: "ceph-create-context", patientId: 1, clinicTimeZone: "Asia/Aden", imagesBefore: null, nextImagesBefore: null, hasOpenDraft: false, images: [{ id: 2, title: "SYN image", takenOn: "2026-11-01", uploadedAt: "2026-11-01T00:00:00Z", previousStudies: 1 }], orthoCases: null, referenceSets: [{ key: "builtin_default", name: "SYN reference" }] });
it("explicit create query has a strict optional positive image cursor", () => {
 expect(canonicalCephCreateQuery("1", new URLSearchParams("create=1"))).toEqual({ patientId: 1, imagesBefore: null });
 expect(canonicalCephCreateQuery("1", new URLSearchParams("create=1&imagesBefore=20"))).toEqual({ patientId: 1, imagesBefore: 20 });
});
it.each(["", "create=0", "create=1&create=1", "create=1&imagesBefore=0", "create=1&imagesBefore=01", "create=1&imagesBefore=2147483648", "create=1&imagesBefore=1&imagesBefore=2", "create=1&includeImages=1", "imagesBefore=20", "create=1&patientId=2"])("rejects unrecognized/coercive context query %s", query => expect(() => canonicalCephCreateQuery("1", new URLSearchParams(query))).toThrow());
it("accepts exact minimal context and validates identity, cursor and zone", () => {
 expect(isCanonicalCephCreateContext(context(), 1, null)).toBe(true); expect(isCanonicalCephCreateContext(context(), 2, null)).toBe(false); expect(isCanonicalCephCreateContext(context(), 1, 3)).toBe(false);
 for (const zone of [undefined, null, "Bad/Zone"]) expect(isCanonicalCephCreateContext({ ...context(), clinicTimeZone: zone }, 1, null)).toBe(false);
});
it("private extras, malformed choices and hidden case coercion fail client validation", () => {
 const base=context();
 for (const bad of [{...base, storageKey:"SYN"},{...base,images:[{...base.images[0],note:"SYN private"}]},{...base,images:[{...base.images[0],id:"2"}]},{...base,images:[{...base.images[0],title:null}]},{...base,images:[{...base.images[0],previousStudies:-1}]},{...base,orthoCases:[{id:2,planId:5}]},{...base,referenceSets:[{key:"x",name:"X",values:{}}]},{...base,referenceSets:[base.referenceSets[0],base.referenceSets[0]]},{...base,nextImagesBefore:2}]) expect(isCanonicalCephCreateContext(bad,1,null)).toBe(false);
});
it("a full descending page has a truthful last-id cursor; repeats/order/oversize refuse", () => {
 const base=context(),images=Array.from({length:100},(_,i)=>({...base.images[0],id:200-i})),page={...base,images,nextImagesBefore:101};
 expect(isCanonicalCephCreateContext(page,1,null)).toBe(true);
 for(const bad of [{...page,nextImagesBefore:102},{...page,images:[...images,images[99]]},{...page,images:[...images].reverse()},{...page,images:[images[0],images[0],...images.slice(2)]}])expect(isCanonicalCephCreateContext(bad,1,null)).toBe(false);
});
