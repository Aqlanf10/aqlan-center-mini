import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Full modern slices stay byte-pinned. Finite, count-checked literal reversals
// below also recover the prior reviewed load/sign bytes: direct React state
// mirrors and stable setter dependencies are the only newly approved deltas.
// This is change-isolation provenance, not semantic equivalence by hashing;
// clinical ownership, stale-read, signing and draft behavior have runtime tests.
// The prior #380 invoiceReferenceState presentation change remains separately
// isolated against the original 055c399a sign hash. The prior load baseline
// already includes removal of the retired catalogue-modal reset (CI1768).
const baseline = [
  {
    "label": "load",
    "start": "  const load = useCallback(",
    "end": "  useEffect(() => { void load(); }",
    "sha": "d585ede1681d8aac5b00a5d02038eade3bea35647eb99a30c1d687e4be24aad4"
  },
  {
    "label": "send",
    "start": "  const send = useCallback(",
    "end": "  /** التوقيع",
    "sha": "a6afc51765da78bf0631a43360ffed82c272328606f6202ef35d287b5ed0b22d"
  },
  {
    "label": "sign",
    "start": "  const sign = useCallback(",
    "end": "  /** (VISIT-2) فتح ملف",
    "sha": "ed66cf19fa7d3d24fb784ac4d181398e1c7b110c12f84be91323872b46dc4823"
  },
  {
    "label": "payload",
    "start": "  const payload = () => (",
    "end": "  /*\n   * «مخطَّط لليوم»",
    "sha": "e311cf68c9ceb5fb0305c20c5c07bc401ce06505dbb4515c5e84d3fa3e98afda"
  },
  {
    "label": "addPlannedItem",
    "start": "  const addPlannedItem = (",
    "end": "  /* ملاحظة جلسةٍ",
    "sha": "28ab4c344ef3a0bdb893778e4b0fe50405235e514251c0e8440d014a19905156"
  }
];
const historicalHashes = {
  load: "4e6e0ebbf2630871c822df5a72ef321dde0ee540bdb55bff87098cddc96ff982",
  sign: "4e1cd839b93397762e4e96d0fa92467a877c6ea3864637a1d2e93ae353ca89f6",
};
// Literal reviewed deltas only; do not generalize to whitespace, callback or
// arbitrary setter removal. Every approved insertion must occur exactly once.
const reviewedMirrorChanges = {
  load: [
    ['lastAutoTreatment.current = ""; setDisplayedAutoTreatment("");', 'lastAutoTreatment.current = "";'],
    ["lastAppliedOwner.current = owner; setAppliedOwner(owner);", "lastAppliedOwner.current = owner;"],
    ['if (loaded.status === "signed") { confirmedSignOwner.current = owner; setDisplayedSignOwner(owner); }', 'if (loaded.status === "signed") confirmedSignOwner.current = owner;'],
    ["[visitId, expectedPatientId, currentOwner, owner, setRxOpen, setPostOpOpen]", "[visitId, expectedPatientId, currentOwner, owner]"],
  ],
  sign: [["confirmedSignOwner.current = owner; setDisplayedSignOwner(owner);", "confirmedSignOwner.current = owner;"]],
} as const;
function restoreReviewedHistoricalSlice(slice: string, boundary: keyof typeof reviewedMirrorChanges) {
  for (const [current, previous] of reviewedMirrorChanges[boundary]) {
    expect(slice.split(current)).toHaveLength(2);
    slice = slice.replace(current, previous);
  }
  return slice;
}
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const source = readFileSync("components/ClinicalVisit.tsx", "utf8");
describe("actual visit workspace retains its authoritative contracts", () => {
  it.each(baseline)("keeps $label byte-identical to its reviewed authority boundary", ({ start, end, sha }) => {
    const from = source.indexOf(start); expect(from).toBeGreaterThan(-1);
    const to = source.indexOf(end, from); expect(to).toBeGreaterThan(from);
    expect(createHash("sha256").update(source.slice(from, to)).digest("hex")).toBe(sha);
  });
  it.each(["load", "sign"] as const)("recovers the historical %s authority bytes after only reviewed render-mirror changes", (label) => {
    const boundary = baseline.find(item => item.label === label)!;
    const from = source.indexOf(boundary.start), to = source.indexOf(boundary.end, from);
    expect(sha256(restoreReviewedHistoricalSlice(source.slice(from, to), label))).toBe(historicalHashes[label]);
  });
  it("binds presentation mirrors and stable dependencies to direct React state setters", () => {
    for (const declaration of [
      "const [appliedOwner, setAppliedOwner] = useState<typeof owner | null>(null);",
      "const [displayedSignOwner, setDisplayedSignOwner] = useState<typeof owner | null>(null);",
      'const [displayedAutoTreatment, setDisplayedAutoTreatment] = useState("");',
      "const [rxOpen, setRxOpen] = useState(false);",
      "const [postOpOpen, setPostOpOpen] = useState(false);",
    ]) expect(source.split(declaration)).toHaveLength(2);
  });
  it("does not hide missing, duplicate or unreviewed authority edits in the historical reconstruction", () => {
    const boundary = baseline.find(item => item.label === "load")!;
    const from = source.indexOf(boundary.start), to = source.indexOf(boundary.end, from);
    const load = source.slice(from, to), insertion = reviewedMirrorChanges.load[0][0];
    expect(() => restoreReviewedHistoricalSlice(load.replace(insertion, ""), "load")).toThrow();
    expect(() => restoreReviewedHistoricalSlice(load + insertion, "load")).toThrow();
    expect(load).toContain("currentOwner()");
    const changedAuthority = load.replace("currentOwner()", "true");
    expect(sha256(restoreReviewedHistoricalSlice(changedAuthority, "load"))).not.toBe(historicalHashes.load);
  });
  it("changes only optimistic documentary verification within the original sign authority", () => {
    const from = source.indexOf("  const sign = useCallback(");
    const to = source.indexOf("  /** (VISIT-2) فتح ملف", from);
    const sign = restoreReviewedHistoricalSlice(source.slice(from, to), "sign");
    const reviewedInsertion = ", invoiceReferenceState: undefined";
    expect(sign.split(reviewedInsertion)).toHaveLength(2);
    expect(createHash("sha256").update(sign.replace(reviewedInsertion, "")).digest("hex"))
      .toBe("ef28cfac2060d5b9e80e2e17a947a49287c3daf8c0c6efe5a6798504c45a698e");
  });
  it("uses one catalog action and one worklist, preserving tooth and plan callbacks", () => {
    expect(source.match(/<ServiceSelect/g)).toHaveLength(1);
    // No render, import, state, or owner-reset references may survive modal removal.
    expect(source).not.toMatch(/\b(?:QuickServicePicker|pickerOpen|setPickerOpen|servicePickerTrigger)\b/);
    expect(source.match(/aria-label="بنود عمل الزيارة"/g)).toHaveLength(1);
    expect(source).toContain("onChange={(_id, service) => { if (service) addFreeProcedure(service as Service); }}");
    expect(source).toContain("catalogCurrency={visitCurrency}");
    expect(source).toContain("disabled={busy || !canEditWork}");
    expect(source).toContain("onClick={() => addPlannedItem(item)}");
    expect(source).toContain("<ToothField value={draft.toothCode}");
    expect(source).toContain("disabled={draft.planItemId !== null}");
    expect(source).toContain("disabled={busy || Boolean(signatureBlock)}");
  });
  it("dismisses review presentation without releasing a pending command or its write locks", () => {
    expect(source).toContain("const dismissReview = () => { if (currentOwner()) setReviewOpen(false); };");
    expect(source.match(/onClick=\{dismissReview\}/g)).toHaveLength(2);
    expect(source).toContain("dismissReview();");
    expect(source).toContain('busy ? "إغلاق المراجعة — التوقيع قيد الانتظار" : "رجوع — أكمل العمل"');
    expect(source).toContain("إغلاق المراجعة لا يلغي الطلب");
    expect(source).toContain('<button onClick={() => void send(payload())} disabled={busy}');
  });
});


describe("visit picker and reference ownership lint regressions", () => {
  it("updates the latest close callback only after commit without resetting focus lifetime", () => {
    const picker = readFileSync("components/QuickServicePicker.tsx", "utf8");
    expect(picker).toMatch(/useLayoutEffect\(\(\) => \{ closeRef\.current = onClose; \}, \[onClose\]\)/);
    expect(picker.match(/closeRef\.current = onClose/g)).toHaveLength(1);
    expect(picker).toContain("closeRef.current()");
    // The original mount-scoped timer/listener cleanup and focus return remain.
    expect(picker).toContain('window.clearTimeout(timer); window.removeEventListener("keydown", onKey);');
    expect(picker).toContain("if (previous?.isConnected) previous.focus();");
  });
  it("gives the presentation token explicit dependencies while retaining identity-based retirement", () => {
    const today = readFileSync("components/patient/TodayVisitTab.tsx", "utf8");
    expect(today).toContain("visitId: openVisit?.id ?? null, requestedCheckoutVisitId,");
    expect(today).toContain("}), [openVisit?.id, requestedCheckoutVisitId]);");
    expect(today).toMatch(/useLayoutEffect\(\(\) => \{\s*livePreviousReferenceOwner\.current = previousReferenceOwner;\s*\}, \[previousReferenceOwner\]\)/);
    expect(today.match(/livePreviousReferenceOwner\.current = previousReferenceOwner/g)).toHaveLength(1);
    expect(today).toContain("livePreviousReferenceOwner.current !== previousReferenceOwner");
    expect(today).toContain("previousReference?.owner === previousReferenceOwner");
  });
});
