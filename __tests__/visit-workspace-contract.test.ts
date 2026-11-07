import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import signDeltas from "./fixtures/reviewed-contracts/visit-sign.json";
import { reverseReviewedDeltas } from "./helpers/reviewed-source-deltas";

// Historical authority: 055c399a plus #380's invoiceReferenceState reset,
// and the load slice's removal of the retired catalogue modal reset (CI1768).
// Sign admission then changed in a241e995 + 680b0fd8: owner-bound staged input,
// exact interval, and text validation. Reverse ONLY those exact reviewed hunks
// before asserting the unchanged historical hashes, including the original
// invoice-reset equivalence. All other source bytes remain protected.
// Review: docs/verification/reviewed-contract-guards-20261107.md.
const baseline = [
  {
    "label": "load",
    "start": "  const load = useCallback(",
    "end": "  useEffect(() => { void load(); }",
    "sha": "4e6e0ebbf2630871c822df5a72ef321dde0ee540bdb55bff87098cddc96ff982"
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
    "sha": "4e1cd839b93397762e4e96d0fa92467a877c6ea3864637a1d2e93ae353ca89f6"
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
const source = readFileSync("components/ClinicalVisit.tsx", "utf8");
describe("actual visit workspace retains its authoritative contracts", () => {
  it.each(baseline)("keeps $label identical except for exact reviewed admission deltas", ({ label, start, end, sha }) => {
    const from = source.indexOf(start); expect(from).toBeGreaterThan(-1);
    const to = source.indexOf(end, from); expect(to).toBeGreaterThan(from);
    const slice = source.slice(from, to);
    expect(createHash("sha256").update(label === "sign" ? reverseReviewedDeltas(slice, signDeltas) : slice).digest("hex")).toBe(sha);
  });
  it("retains the original invoice-verification-only delta after reviewed admission changes", () => {
    const from = source.indexOf("  const sign = useCallback(");
    const to = source.indexOf("  /** (VISIT-2) فتح ملف", from);
    const sign = reverseReviewedDeltas(source.slice(from, to), signDeltas);
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
