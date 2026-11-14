import { createHash } from "node:crypto";
import type { ElasticClass, OrthoPhase } from "./ortho";

export interface CommandInput {
  caseId: number; visitId: number | null; doneOn: string; phase: OrthoPhase | null;
  upperWire: string | null; lowerWire: string | null; elastics: ElasticClass;
  elasticNote: string | null; done: string | null; nextWeeks: number; note: string | null;
  recordedBy: string; actorRole?: string | null;
  upperWireAction?: "remove"; lowerWireAction?: "remove";
  auxiliaries?: readonly string[] | null; auxiliaryOther?: string | null;
}
/** The durable request fingerprint (v1 plus optional later fields). Exported for synthetic upgrade
 * fixtures that must reproduce receipts written by earlier versions; the writer is the only producer. */
export function adjustmentRequestHash(actorId: number, patientId: number, input: CommandInput, doneOn: string): string {
  return createHash("sha256").update(JSON.stringify({ version: 1, actorId: actorId,
    patientId: patientId, caseId: input.caseId, visitId: input.visitId, doneOn, phase: input.phase,
    upperWire: input.upperWire, lowerWire: input.lowerWire, elastics: input.elastics, elasticNote: input.elasticNote,
    done: input.done, nextWeeks: input.nextWeeks, note: input.note,
    // Explicit removal is newer than the v1 fingerprint; it is hashed only when present,
    // so every earlier request keeps its exact hash and a toggled removal is a different body.
    ...(input.upperWireAction === "remove" ? { upperWireAction: "remove" } : {}),
    ...(input.lowerWireAction === "remove" ? { lowerWireAction: "remove" } : {}),
    // 0132 auxiliaries follow the same rule: hashed only when recorded (an empty list included), so a
    // request without them keeps its earlier hash and "none" differs from "not recorded".
    ...(input.auxiliaries == null ? {} : { auxiliaries: [...input.auxiliaries], auxiliaryOther: input.auxiliaryOther ?? null }) })).digest("hex");
}
