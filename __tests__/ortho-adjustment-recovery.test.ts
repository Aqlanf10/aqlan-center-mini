import { describe, expect, it } from "vitest";
import { recordedSessionMatchesRequest } from "../lib/ortho-session-match";
import {
  clearRefusedAdjustmentDraft, createAdjustmentCommand, completeAdjustmentCommand, discardRefusedAdjustmentCommand,
  readAdjustmentCommand, readRefusedAdjustmentDraft, cachedReceiptProvenance, refusedDraftStorageKey, writeRefusedAdjustmentDraft,
} from "../lib/ortho-adjustment-command";

// Reviews on #483 6872647524 and 6873798343: one provenance rule for the server replay and the screen's
// cached acknowledgement; refused values survive a reload; photos are never stored in the browser.
const scope = { patientId: 19, caseId: 41, authority: "user:7" };
const bodyB = { doneOn: "2026-11-14", upperWire: "019×025 SS", lowerWire: "014 NiTi", elastics: "none", elasticNote: "", done: "SYN B", nextWeeks: 8,
  auxiliaries: ["tad", "other"], auxiliaryOther: "SYN Pendulum" };
const sessionA = { id: 81, doneOn: "2026-11-14", phase: null, upperWire: "016 NiTi", lowerWire: null, elastics: "class_ii", elasticNote: "SYN A",
  done: "SYN A", nextWeeks: 4, note: null, auxiliaries: ["tpa"], auxiliaryOther: null };
const sessionLikeB = { ...sessionA, upperWire: "019×025 SS", lowerWire: "014 NiTi", elastics: "none", elasticNote: null, done: "SYN B", nextWeeks: 8,
  auxiliaries: ["tad", "other"], auxiliaryOther: "SYN Pendulum" };
function storage() {
  const map = new Map<string, string>();
  return { map, getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => { map.set(key, value); }, removeItem: (key: string) => { map.delete(key); } };
}
const acknowledged = (store: ReturnType<typeof storage>, id: number) => {
  const command = createAdjustmentCommand(store, scope, bodyB);
  return completeAdjustmentCommand(store, command, { id, patientId: 19, caseId: 41, requestKey: command.key, visitId: 5, attachedToToday: true });
};

describe("shared provenance rule", () => {
  it("matches only the values the request carries, with the writer's normalization", () => {
    expect(recordedSessionMatchesRequest(sessionLikeB, { ...bodyB, phase: null, note: null })).toBe(true);
    expect(recordedSessionMatchesRequest(sessionA, { ...bodyB, phase: null, note: null })).toBe(false);
    // A blank wire kept the case wire and is not compared; "remove" must have removed it.
    expect(recordedSessionMatchesRequest(sessionLikeB, { ...bodyB, upperWire: "  " })).toBe(true);
    expect(recordedSessionMatchesRequest(sessionLikeB, { ...bodyB, upperWire: "", upperWireAction: "remove" })).toBe(false);
    // Different date, interval, auxiliaries or "other" name are mismatches; "not recorded" differs from "none".
    for (const change of [{ doneOn: "2026-11-13" }, { nextWeeks: 6 }, { auxiliaries: ["tad"] }, { auxiliaryOther: "SYN other" }, { auxiliaries: [] }]) {
      expect(recordedSessionMatchesRequest(sessionLikeB, { ...bodyB, ...change }), JSON.stringify(change)).toBe(false);
    }
    expect(recordedSessionMatchesRequest({ ...sessionLikeB, auxiliaries: null, auxiliaryOther: null }, { ...bodyB, auxiliaries: undefined, auxiliaryOther: undefined })).toBe(true);
    // A read projection presenting an empty recorded note as "" is the same recorded value.
    expect(recordedSessionMatchesRequest({ ...sessionLikeB, elasticNote: "" }, bodyB)).toBe(true);
    // phase and note are judged only when the caller knows them (the server); the screen never sends them.
    expect(recordedSessionMatchesRequest({ ...sessionLikeB, phase: "aligning" }, bodyB)).toBe(true);
    expect(recordedSessionMatchesRequest({ ...sessionLikeB, phase: "aligning" }, { ...bodyB, phase: null })).toBe(false);
  });
});

describe("cached acknowledgement", () => {
  it("distinguishes an unambiguous mismatch from a session not loaded yet", () => {
    expect(cachedReceiptProvenance(acknowledged(storage(), 81), [sessionA])).toBe("mismatch");
    expect(cachedReceiptProvenance(acknowledged(storage(), 81), [{ ...sessionLikeB, id: 81 }])).toBe("match");
    expect(cachedReceiptProvenance(acknowledged(storage(), 82), [{ ...sessionLikeB, id: 81 }])).toBe("unknown");
  });
  it("drops a cached receipt only when the caller proved it unverified", () => {
    const store = storage(); const command = acknowledged(store, 81);
    expect(() => discardRefusedAdjustmentCommand(store, command)).toThrow();
    expect(readAdjustmentCommand(store, scope)?.receipt?.id).toBe(81);
    discardRefusedAdjustmentCommand(store, command, { unverifiedReceipt: true });
    expect(readAdjustmentCommand(store, scope)).toBeNull();
  });
});

describe("refused values for a reload", () => {
  it("round-trips the body and a photo count, never files", () => {
    const store = storage();
    writeRefusedAdjustmentDraft(store, { version: 1, scope, body: JSON.stringify(bodyB), code: "adjustment_visit_already_recorded", existingAdjustmentId: 81, photoCount: 2 });
    const stored = store.map.get(refusedDraftStorageKey(scope))!;
    expect(stored).not.toMatch(/blob:|data:image|base64/);
    expect(readRefusedAdjustmentDraft(store, scope)).toMatchObject({ existingAdjustmentId: 81, photoCount: 2 });
    expect(readRefusedAdjustmentDraft(store, { ...scope, authority: "user:8" })).toBeNull();
    clearRefusedAdjustmentDraft(store, scope);
    expect(readRefusedAdjustmentDraft(store, scope)).toBeNull();
  });
  it("ignores a corrupt or tampered record instead of restoring it", () => {
    const store = storage();
    store.setItem(refusedDraftStorageKey(scope), "{");
    expect(readRefusedAdjustmentDraft(store, scope)).toBeNull();
    store.setItem(refusedDraftStorageKey(scope), JSON.stringify({ version: 1, scope, body: JSON.stringify({ ...bodyB, extra: 1 }), code: "x", existingAdjustmentId: null, photoCount: 0 }));
    expect(readRefusedAdjustmentDraft(store, scope)).toBeNull();
    expect(() => writeRefusedAdjustmentDraft(store, { version: 1, scope, body: "{}", code: "x", existingAdjustmentId: null, photoCount: 0 })).toThrow();
  });
});
