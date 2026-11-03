import { expect, it } from "vitest";
import { canonicalRadiologyRequest, decodeRadiologySnapshot, parseRadiologyRequest } from "../lib/radiology-request";
const key = "11111111-1111-4111-8111-111111111111";
const draft = { patientId: 7, visitId: 9, centerId: "22222222-2222-1222-8222-222222222222", examination: "بانوراما", region: "الفكين", notes: "تعليمات\nمحددة" };
const snapshot = { ...draft, version: 1, doctorId: 5, patientName: "مريض", doctorName: "طبيب", centerName: "مركز", centerAddress: "عنوان", clinicName: "عيادة", clinicAddress: "", clinicPhone: "", timeZone: "Asia/Aden" };
it("accepts catalog UUID versions1–8 while command key remains v4 only", () => {
  for (const version of "12345678") expect(parseRadiologyRequest({ ...draft, centerId: `22222222-2222-${version}222-8222-222222222222`, commandKey: key }).draft.centerId).toContain(`-${version}222-`);
  expect(() => parseRadiologyRequest({ ...draft, commandKey: draft.centerId })).toThrow();
});
it("normalizes human text and binds every semantic request field in canonical payload", () => {
  const parsed = parseRadiologyRequest({ ...draft, examination: ` ${draft.examination} `, commandKey: key });
  expect(parsed).toEqual({ key, draft }); expect(canonicalRadiologyRequest(parsed.draft)).toEqual([1, 7, 9, draft.centerId, draft.examination, draft.region, draft.notes]);
});
it.each([{ patientId: 0 }, { patientId: 2147483648 }, { visitId: "9" }, { examination: "" }, { region: "x".repeat(201) }, { notes: "x".repeat(2001) }, { notes: "bad\u202e" }, { actor: "spoof" }])("rejects unsafe command data %j", patch => {
  expect(() => parseRadiologyRequest({ ...draft, commandKey: key, ...patch })).toThrow();
});
it("decodes versioned snapshots without leaking unexpected stored properties", () => {
  expect(decodeRadiologySnapshot({ ...snapshot, secret: "not public" }, 7, 9, 5)).toEqual(snapshot);
});
it.each([{ version: undefined }, { version: 2 }, { patientId: 8 }, { visitId: null }, { doctorId: 6 }, { patientName: "" }, { doctorName: "x".repeat(501) }, { centerAddress: "x".repeat(401) }, { clinicPhone: "bad\u0085" }, { timeZone: "Not/AZone" }])("fails closed for malformed stored snapshot %j", patch => {
  expect(() => decodeRadiologySnapshot({ ...snapshot, ...patch }, 7, 9, 5)).toThrow();
});
