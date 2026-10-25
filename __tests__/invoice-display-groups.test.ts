import { describe, expect, it } from "vitest";
import {
  applyGroupedToothSelection, buildInvoiceDisplayGroups, patchDisplayGroupRows, removeDisplayGroupRows,
  replaceDisplayGroupService, selectionOfDisplayGroup, splitDisplayGroupRow,
  type InvoiceDisplayRowLike,
} from "../components/dental/invoice-display-groups";
import { applyToothSelection, emptyToothFields, toothPayload } from "../components/dental/invoice-tooth-selection";

type Row = InvoiceDisplayRowLike & { source?: string };
let sequence = 0;
const key = () => `display-test-${++sequence}`;
const row = (patch: Partial<Row> = {}): Row => ({
  key: key(), serviceId: "rct-service", doctorId: "doctor-1", price: "100", quantity: "1", priceReason: "",
  description: "Treatment", caseId: "", ...emptyToothFields("none"), ...patch,
});
const selection = (...teeth: number[]) => ({ teeth, surfaces: "", scope: null });
const rct = (...teeth: number[]) => applyGroupedToothSelection([row()], 0, "per_tooth_episode", selection(...teeth), key);
const bridge = (...teeth: number[]) => applyGroupedToothSelection([row({ serviceId: "bridge-service" })], 0, "multi_tooth_episode", selection(...teeth), key);

describe("editor-only invoice display projection", () => {
  it("groups an explicit four-tooth batch into quantity 4 and summed 400, retaining canonical children", () => {
    const children = rct(16, 13, 15, 14);
    const before = JSON.stringify(children);
    const groups = buildInvoiceDisplayGroups(children);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ indices: [0, 1, 2, 3], keys: children.map(one => one.key),
      teeth: [13, 14, 15, 16], quantity: 4, unitPrice: 100, total: 400, grouped: true });
    expect(children).toHaveLength(4);
    expect(children.every(one => one.quantity === "1" && one.episodeTeeth === null && one.groupId === null)).toBe(true);
    expect(JSON.stringify(children)).toBe(before);
    expect(children.map(one => toothPayload("per_tooth_episode", one))).toEqual([
      { toothCode: 13 }, { toothCode: 14 }, { toothCode: 15 }, { toothCode: 16 },
    ]);
  });

  it("does not guess display intent from similar independent or historical rows", () => {
    const independent = [row({ toothCode: 14 }), row({ toothCode: 15 })];
    expect(buildInvoiceDisplayGroups(independent)).toHaveLength(2);
    const clinicalOnly = applyToothSelection([row()], 0, "multi_tooth_episode", selection(14, 15), key);
    expect(clinicalOnly[0].groupId).toBeTruthy();
    expect(buildInvoiceDisplayGroups(clinicalOnly)).toHaveLength(2);
    const historical = [row({ toothCode: 14, episodeTeeth: [14, 15, 16], price: "300000" })];
    expect(buildInvoiceDisplayGroups(historical)[0]).toMatchObject({ grouped: false, quantity: 1, total: 300000 });
    expect(historical[0].episodeTeeth).toEqual([14, 15, 16]);
  });

  it.each([
    ["display identity", { displayGroupId: "other-batch" }],
    ["service", { serviceId: "other-service" }],
    ["doctor", { doctorId: "doctor-2" }],
    ["price", { price: "101" }],
    ["price reason", { priceReason: "Approved override" }],
    ["manual flag", { manual: true }],
    ["description", { description: "Different clinical description" }],
    ["surfaces", { surfaces: "MO" }],
    ["quantity", { quantity: "2" }],
    ["clinical group", { groupId: "other-episode" }],
    ["clinical episode", { episodeTeeth: [15, 16] }],
    ["scope", { scope: "upper" }],
  ] as const)("keeps incompatible %s separate", (_label, patch) => {
    const children = rct(14, 15);
    children[1] = { ...children[1], ...patch } as Row;
    expect(buildInvoiceDisplayGroups(children)).toHaveLength(2);
  });

  it("compares monetary value in the agreement currency, not formatting or the wrong precision", () => {
    const children = rct(14, 15);
    children[0].price = "1,250.10"; children[1].price = "١٢٥٠٫١٠";
    expect(buildInvoiceDisplayGroups(children, { currency: "SAR" })[0]).toMatchObject({ quantity: 2, unitPrice: 125010, total: 250020 });
    children[1].price = "1250.11";
    expect(buildInvoiceDisplayGroups(children, { currency: "SAR" })).toHaveLength(2);
    expect(buildInvoiceDisplayGroups(children, { priceValue: (_one, index) => index ? 200 : 100 })).toHaveLength(2);
  });

  it("preserves per-tooth case and item IDs while separating distinct selected plan/source provenance", () => {
    const children = rct(14, 15, 16);
    children.forEach((one, index) => Object.assign(one, { caseId: `case-${index}`, planItemId: 300 + index, source: index === 2 ? "plan:2" : "plan:1" }));
    const groups = buildInvoiceDisplayGroups(children, { provenance: one => one.source });
    expect(groups.map(group => group.keys)).toEqual([[children[0].key, children[1].key], [children[2].key]]);
    expect(groups[0].row.caseId).toBe("case-0");
    expect(children.map(one => one.planItemId)).toEqual([300, 301, 302]);
  });

  it("keeps only exactly matching invalid price drafts together and never invents a total", () => {
    const children = rct(14, 15);
    for (const raw of ["", ".", "not a price"]) {
      const edited = children.map(one => ({ ...one, price: raw }));
      expect(buildInvoiceDisplayGroups(edited)[0]).toMatchObject({ grouped: true, total: null, unitPrice: null });
      edited[1].price = `${raw} `;
      expect(buildInvoiceDisplayGroups(edited)).toHaveLength(2);
    }
    const independent = [row({ toothCode: 14, price: "" }), row({ toothCode: 15, price: "" })];
    expect(buildInvoiceDisplayGroups(independent)).toHaveLength(2);
  });

  it("keeps duplicate teeth visible and refuses unsafe combined monetary totals", () => {
    const children = rct(14, 15);
    expect(buildInvoiceDisplayGroups([children[0], { ...children[1], toothCode: 14 }])).toHaveLength(2);
    const huge = children.map(one => ({ ...one, price: String(Number.MAX_SAFE_INTEGER) }));
    expect(buildInvoiceDisplayGroups(huge)).toHaveLength(2);
    expect(buildInvoiceDisplayGroups([row({ quantity: "bad" })])[0].total).toBeNull();
  });

  it("keeps canonical indexes and order when display children are not adjacent", () => {
    const children = rct(14, 15);
    const unrelated = row({ serviceId: "unrelated" });
    const groups = buildInvoiceDisplayGroups([children[0], unrelated, children[1]]);
    expect(groups.map(group => group.indices)).toEqual([[0, 2], [1]]);
    expect(groups.map(group => group.key)).toEqual([children[0].key, unrelated.key]);
  });
});

describe("grouped tooth selection keeps clinical identity intact", () => {
  it("reselects RCT teeth without duplicate children and retains each existing key/case/item", () => {
    const children = rct(14, 15, 16).map((one, index) => ({ ...one, caseId: `case-${index}`, planItemId: 700 + index }));
    const groups = buildInvoiceDisplayGroups(children);
    const edited = applyGroupedToothSelection(children, 1, "per_tooth_episode", selection(13, 15, 16), key, { memberKeys: groups[0].keys });
    expect(edited.map(one => one.toothCode)).toEqual([13, 15, 16]);
    expect(edited[1]).toMatchObject({ key: children[1].key, caseId: "case-1", planItemId: 701 });
    expect(edited[2]).toMatchObject({ key: children[2].key, caseId: "case-2", planItemId: 702 });
    expect(edited[0]).toMatchObject({ caseId: "", planItemId: null, price: "100", doctorId: "doctor-1" });
    expect(new Set(edited.map(one => one.key)).size).toBe(3);
    expect(edited.every(one => one.groupId === null && one.episodeTeeth === null && one.quantity === "1")).toBe(true);
    expect(buildInvoiceDisplayGroups(edited)).toHaveLength(1);
  });

  it("preserves the retained original key when a new lower-numbered tooth precedes it", () => {
    for (const mode of ["per_tooth_episode", "multi_tooth_episode"] as const) {
      const original = row({ toothCode: 16, caseId: "original-case", planItemId: 42 });
      const edited = applyGroupedToothSelection([original], 0, mode, selection(14, 16), key);
      expect(edited[1]).toMatchObject({ key: original.key, toothCode: 16, caseId: "original-case", planItemId: 42 });
      expect(edited[0]).toMatchObject({ toothCode: 14, caseId: "", planItemId: null });
      expect(edited[0].key).not.toBe(original.key);
    }
  });

  it("resets a previously typed quantity to one for every selected tooth, including singleton selections", () => {
    const original = row({ quantity: "7" });
    for (const mode of ["per_tooth_episode", "multi_tooth_episode"] as const) {
      const children = applyGroupedToothSelection([original], 0, mode, selection(14, 15), key);
      expect(children.map(one => one.quantity)).toEqual(["1", "1"]);
      expect(buildInvoiceDisplayGroups(children)[0].total).toBe(200);
      const singleton = applyGroupedToothSelection([original], 0, mode, selection(14), key);
      expect(singleton[0]).toMatchObject({ quantity: "1", displayGroupId: null });
    }
  });

  it("can clear an RCT group without retaining case/item linkage or clinical episode metadata", () => {
    const children = rct(14, 15).map(one => ({ ...one, caseId: "bound-case", planItemId: 7 }));
    const cleared = applyGroupedToothSelection(children, 0, "per_tooth_episode", selection(), key);
    expect(cleared).toHaveLength(1);
    expect(cleared[0]).toMatchObject({ toothCode: null, caseId: "", planItemId: null, episodeTeeth: null, groupId: null, displayGroupId: null });
  });

  it("preserves the true bridge episode while repricing and reselecting one compatible display subgroup", () => {
    let children = bridge(14, 15, 16).map((one, index) => ({ ...one, caseId: `case-${index}`, planItemId: 90 + index }));
    children = children.map(one => one.toothCode === 15 ? { ...one, price: "150", doctorId: "doctor-2" } : one);
    const subgroup = buildInvoiceDisplayGroups(children)[0];
    expect(subgroup.teeth).toEqual([14, 16]);
    const edited = applyGroupedToothSelection(children, 0, "multi_tooth_episode", selection(14, 17), key, { memberKeys: subgroup.keys });
    expect(edited.map(one => one.toothCode)).toEqual([14, 15, 17]);
    expect(edited.every(one => JSON.stringify(one.episodeTeeth) === "[14,15,17]")).toBe(true);
    expect(edited[1]).toMatchObject({ key: children[1].key, price: "150", doctorId: "doctor-2", caseId: "case-1", planItemId: 91,
      displayGroupId: children[1].displayGroupId });
    expect(edited[2]).toMatchObject({ price: "100", doctorId: "doctor-1", caseId: "", planItemId: null });
    expect(buildInvoiceDisplayGroups(edited).map(group => group.teeth)).toEqual([[14, 17], [15]]);
  });

  it("a split bridge child opens only its actual tooth and does not recapture the outside episode", () => {
    const original = bridge(14, 15, 16);
    const children = splitDisplayGroupRow(original, original[1].key);
    const singleton = buildInvoiceDisplayGroups(children).find(group => group.key === original[1].key)!;
    expect(selectionOfDisplayGroup(singleton).teeth).toEqual([15]);
    expect(children[1].episodeTeeth).toEqual([14, 15, 16]);
    const edited = applyGroupedToothSelection(children, 1, "multi_tooth_episode", selection(17), key, { memberKeys: singleton.keys });
    expect(edited.map(one => one.toothCode)).toEqual([14, 16, 17]);
    expect(edited[0].key).toBe(children[0].key);
    expect(edited[1].key).toBe(children[2].key);
    expect(edited.every(one => JSON.stringify(one.episodeTeeth) === "[14,16,17]")).toBe(true);
    expect(edited[2].displayGroupId).toBeNull();
    expect(buildInvoiceDisplayGroups(edited).map(group => group.teeth)).toEqual([[14, 16], [17]]);
  });

  it.each(["per_tooth_episode", "multi_tooth_episode"] as const)("a split %s row cannot steal another subgroup's tooth", mode => {
    const original = applyGroupedToothSelection([row()], 0, mode, selection(14, 15), key);
    const children = splitDisplayGroupRow(original, original[1].key);
    expect(applyGroupedToothSelection(children, 1, mode, selection(14, 15), key, { memberKeys: [children[1].key] })).toEqual(children);
  });

  it("preserves old single-tooth surface and region selection semantics", () => {
    const original = row({ displayGroupId: "stale-display" });
    const [filled] = applyGroupedToothSelection([original], 0, "tooth_surfaces", { teeth: [26], surfaces: "OM", scope: null }, key);
    expect(filled).toMatchObject({ toothCode: 26, surfaces: "MO", displayGroupId: null });
    const [regional] = applyGroupedToothSelection([original], 0, "region", { teeth: [], surfaces: "", scope: "upper" }, key);
    expect(regional).toMatchObject({ toothCode: null, scope: "upper", displayGroupId: null });
  });
});

describe("display group financial edits, splitting and removal", () => {
  it("updates price and doctor for only selected compatible children", () => {
    const children = rct(14, 15, 16);
    children[2].doctorId = "doctor-2";
    const group = buildInvoiceDisplayGroups(children)[0];
    const edited = patchDisplayGroupRows(children, group.keys, { price: "200", doctorId: "doctor-3" });
    expect(edited.map(one => [one.price, one.doctorId])).toEqual([["200", "doctor-3"], ["200", "doctor-3"], ["100", "doctor-2"]]);
    expect(edited.map(one => [one.key, one.caseId, one.toothCode])).toEqual(children.map(one => [one.key, one.caseId, one.toothCode]));
    // Old rendered keys are not permission to overwrite a child that has since diverged.
    expect(patchDisplayGroupRows(children, children.map(one => one.key), { price: "300" })[2].price).toBe("100");
  });

  it("keeps the explicit batch together through clearing and replacing the unit price", () => {
    let children = rct(14, 15, 16);
    for (const price of ["", ".", "2", "250"]) {
      const [group] = buildInvoiceDisplayGroups(children);
      expect(group.keys).toHaveLength(3);
      children = patchDisplayGroupRows(children, group.keys, { price });
      expect(children.map(one => one.price)).toEqual([price, price, price]);
    }
    expect(buildInvoiceDisplayGroups(children)[0].total).toBe(750);
  });

  it("does not mutate other children after explicit split, price/doctor edits and RCT reselection", () => {
    let children = rct(14, 15, 16);
    const original = children.map(one => ({ ...one }));
    children = splitDisplayGroupRow(children, children[1].key);
    const singleton = buildInvoiceDisplayGroups(children).find(group => group.key === children[1].key)!;
    children = patchDisplayGroupRows(children, singleton.keys, { price: "225", doctorId: "doctor-2" });
    children = applyGroupedToothSelection(children, 1, "per_tooth_episode", selection(15, 17), key, { memberKeys: singleton.keys });
    expect(children.find(one => one.toothCode === 14)).toEqual(original[0]);
    expect(children.find(one => one.toothCode === 16)).toEqual(original[2]);
    expect(children.filter(one => [15, 17].includes(one.toothCode!)).map(one => [one.price, one.doctorId])).toEqual([["225", "doctor-2"], ["225", "doctor-2"]]);
    expect(buildInvoiceDisplayGroups(children).map(group => group.teeth)).toEqual([[14, 16], [15, 17]]);
  });

  it("uses currency and source compatibility during mutations, not only the initial render", () => {
    const children = rct(14, 15, 16).map(one => ({ ...one, price: "100.10", source: "plan:1" }));
    children[1].price = "100.11"; children[2].source = "plan:2";
    const context = { currency: "SAR" as const, provenance: (one: Row) => one.source };
    const edited = patchDisplayGroupRows(children, children.map(one => one.key), { doctorId: "doctor-3" }, context);
    expect(edited.map(one => one.doctorId)).toEqual(["doctor-3", "doctor-1", "doctor-1"]);
  });

  it("removes only the selected bridge subgroup and updates outside clinical episode membership", () => {
    const children = bridge(14, 15, 16);
    children[1].price = "150";
    const group = buildInvoiceDisplayGroups(children)[0];
    const remaining = removeDisplayGroupRows(children, group.keys);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toMatchObject({ key: children[1].key, toothCode: 15, price: "150", episodeTeeth: [15], groupId: null });
  });

  it("replaces a selected service group with one reset row without damaging other clinical children", () => {
    const children = bridge(14, 15, 16).map(one => ({ ...one, caseId: "bridge-case", planItemId: 17 }));
    children[1].price = "150";
    const group = buildInvoiceDisplayGroups(children)[0];
    const edited = replaceDisplayGroupService(children, group.keys, { serviceId: "new-service", price: "200" }, "per_tooth_episode");
    expect(edited).toHaveLength(2);
    expect(edited[0]).toMatchObject({ key: children[0].key, serviceId: "new-service", price: "200", toothCode: null,
      episodeTeeth: null, groupId: null, displayGroupId: null, caseId: "", planItemId: null, quantity: "1" });
    expect(edited[1]).toMatchObject({ key: children[1].key, serviceId: "bridge-service", price: "150", toothCode: 15,
      episodeTeeth: [15], groupId: null, caseId: "bridge-case", planItemId: 17 });
  });

  it("preserves an ordinary standalone financial/manual quantity during service replacement", () => {
    const original = row({ serviceId: "consultation", quantity: "3", toothCode: null, manual: true });
    const edited = replaceDisplayGroupService([original], [original.key], { serviceId: "xray", manual: false }, "none");
    expect(edited).toHaveLength(1);
    expect(edited[0]).toMatchObject({ key: original.key, serviceId: "xray", quantity: "3", manual: false });
  });
});
