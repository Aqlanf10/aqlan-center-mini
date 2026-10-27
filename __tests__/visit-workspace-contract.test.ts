import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Reviewed against 9860093a and the actual-handler regression suites on 2026-10-26.
// Later roster/return-context, explicit ortho entry and lab-command changes are
// intentional; the entire handlers are no longer identical to the older revision.
// Keep current complete boundaries pinned AND retain the unchanged original load
// admission, linked-price calculation and sign acceptance core separately below.
// Review map and runtime evidence: docs/review/visit-workspace-contract-2026-10-26.md.
const baseline = [
  {
    "label": "load",
    "start": "  const load = useCallback(",
    "end": "  useEffect(() => { void load(); }",
    "sha": "a2a4cefe641bb264e18e79fc89e18dcf84bbb9d51bf174474dce4e53ca3d81d2"
  },
  {
    "label": "send",
    "start": "  const send = useCallback(",
    "end": "  /** التوقيع",
    "sha": "42f400b505a7819daee0f87940273e85b234972b049b2c58cd9824ea94f6b3f4"
  },
  {
    "label": "sign",
    "start": "  const sign = useCallback(",
    "end": "  /** (VISIT-2) فتح ملف",
    "sha": "a993e7e04caa3463591135ef8e841d19c172a88005efd2806817066187e4e451"
  },
  {
    "label": "payload",
    "start": "  const payload = () => ",
    "end": "  /*\n   * «مخطَّط لليوم»",
    "sha": "51aca9ebc1b9fb237b8fb62470e0817e685b34767560180381616dfd91274445"
  },
  {
    "label": "addPlannedItem",
    "start": "  const addPlannedItem = (",
    "end": "  /* ملاحظة جلسةٍ",
    "sha": "4e4e248dcb8594590ae26312591e7ecfa9e43d19439440df250c4e509d59741a"
  }
];
const source = readFileSync("components/ClinicalVisit.tsx", "utf8");
const fingerprint = (text: string) => createHash("sha256").update(text).digest("hex");
function section(text: string, start: string, end: string) {
  const from = text.indexOf(start); expect(from).toBeGreaterThan(-1);
  const to = text.indexOf(end, from); expect(to).toBeGreaterThan(from);
  return text.slice(from, to);
}
function inOrder(text: string, fragments: string[]) {
  let previous = -1;
  for (const fragment of fragments) {
    const at = text.indexOf(fragment, previous + 1);
    expect(at, `Missing or reordered authority boundary: ${fragment}`).toBeGreaterThan(previous);
    previous = at;
  }
}

describe("actual visit workspace retains its authoritative contracts", () => {
  it.each(baseline)("keeps $label byte-identical to its reviewed authority boundary", ({ start, end, sha }) => {
    const from = source.indexOf(start); expect(from).toBeGreaterThan(-1);
    const to = source.indexOf(end, from); expect(to).toBeGreaterThan(from);
    expect(createHash("sha256").update(source.slice(from, to)).digest("hex")).toBe(sha);
  });
  it("changes only the owner-guarded save failure presentation from the prior reviewed send boundary", () => {
    const send = section(source, "  const send = useCallback(", "  /** التوقيع");
    const localized = "if (currentOwner()) setError(clinicalSaveFailureMessage(reason));";
    const previous = 'if (currentOwner()) setError(reason instanceof Error ? reason.message : "تعذّر الاتصال بالخادم.");';
    expect(send.split(localized)).toHaveLength(2);
    // Independently extracted from 6c2f5a8, matching the already recorded pin.
    // Exact substitution must recover every other byte: no normalization or
    // omitted guard, mutation, payload, response, reload or finally boundary.
    expect(fingerprint(send.replace(localized, previous)))
      .toBe("c2e47037edac7e0e9b4fdf374b05a76830803bfb85fc7e1774b7e6e9c8cbb019");
  });
  it("retains the original validated sign acceptance and documentary reset byte-for-byte", () => {
    const sign = section(source, "  const sign = useCallback(", "  /** (VISIT-2) فتح ملف");
    const from = sign.indexOf("      const payload = await response.json();");
    const callback = sign.indexOf("      onSigned?.({", from);
    const to = sign.indexOf("      });", callback);
    expect(from).toBeGreaterThan(-1); expect(callback).toBeGreaterThan(from); expect(to).toBeGreaterThan(callback);
    // Independently extracted from 9860093a, not regenerated from the new handler:
    // response/identity validation, unknown outcome, signed-owner latch, documentary
    // reset, canonical reread, owner/attempt recheck, and checkout callback are unchanged.
    expect(fingerprint(sign.slice(from, to + "      });".length)))
      .toBe("503f874329a4b8c340d4e918fdad65478c4b0a4b7773f71472dc7bfb6ce9296a");
    expect(sign.split(", invoiceReferenceState: undefined")).toHaveLength(2);
  });
  it("retains the original read admission and plan-owned price calculation byte-for-byte", () => {
    expect(fingerprint(section(source, "  const load = useCallback(", "      const nextNotes = {")))
      .toBe("2f56edc6ed3cd57d73e25b479d8eea788780d41beae6449d2bef3405cebbea33");
    expect(fingerprint(section(source, "    // سعر الجلسة القادمة وفق قاعدة البند", "        // Plan staging has no canonical category")))
      .toBe("0cb9ec86483ed89c44b2887efd8c78ad19c4e09ce68784744f68e7ed2c4b63b2");
  });
  it("adds explicit lab and ortho admission without removing the current-owner sign guards", () => {
    const sign = section(source, "  const sign = useCallback(", "  /** (VISIT-2) فتح ملف");
    inOrder(sign, [
      "if (busy || labCommand.blocked || !ownsVisit || acceptedReadOwner.current !== owner || confirmedSignOwner.current === owner",
      'signReadSequence !== loadSequence.current || visit?.status === "signed"',
      "|| !currentOwner() || command.current?.owner === owner) return;",
      "if (!canEditWork && visit?.labWorkIntentRequired)",
      "const blocked = visitSignatureBlock(visit);",
      "if (blocked) { setError(blocked); return; }",
      "const checked = checkOrthoSessionDraft(",
      "if (!checked.ok) { setError(checked.message); return; }",
      'await labCommand.withMutationLock("ordinary",async()=>{',
      "if(!currentOwner()||acceptedReadOwner.current!==owner||command.current!==attempt)return;",
      "signPosted=true;",
      "const response = await fetch(",
    ]);
    expect(sign).toContain("if(signPosted)unknownOutcome();");
  });
  it("keeps assistant saves note-only and mutable work behind current role/read/lab guards", () => {
    const payload = section(source, "  const payload = () => ", "  /*\n   * «مخطَّط لليوم»");
    expect(payload.startsWith("  const payload = () => !canEditWork ? ({...notes}) : ({")).toBe(true);
    const add = section(source, "  const addPlannedItem = (", "  /* ملاحظة جلسةٍ");
    inOrder(add, ["if (busy || labCommand.blocked || !canEditWork || !currentOwner() || acceptedReadOwner.current !== owner || command.current?.owner === owner) return;", "updateDrafts("]);
    const send = section(source, "  const send = useCallback(", "  /** التوقيع");
    inOrder(send, ["!ownsVisit || acceptedReadOwner.current !== owner || !currentOwner() || command.current?.owner === owner",
      "confirmedSignOwner.current === owner", "labCommand.withMutationLock(",
      "if(!currentOwner()||acceptedReadOwner.current!==owner||command.current!==attempt)return false;",
      "validateClinicalLabOriginBody(body,categories);", "await labCommand.prepare(body)",
      "if (!currentOwner()) return false;", "const response = await fetch(",
      "if (!currentOwner() || command.current !== attempt) return false;"]);
  });
  it("uses one catalog action and one worklist, preserving tooth and plan callbacks", () => {
    expect(source.match(/<ServiceSelect/g)).toHaveLength(1);
    // No render, import, state, or owner-reset references may survive modal removal.
    expect(source).not.toMatch(/\b(?:QuickServicePicker|pickerOpen|setPickerOpen|servicePickerTrigger)\b/);
    expect(source.match(/aria-label="بنود عمل الزيارة"/g)).toHaveLength(1);
    expect(source).toContain("onChange={(_id, service) => { if (service) addFreeProcedure(service as Service); }}");
    expect(source).toContain("catalogCurrency={visitCurrency}");
    expect(source).toContain("disabled={busy || labCommand.blocked || !canEditWork}");
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
