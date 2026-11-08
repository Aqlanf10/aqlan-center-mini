import { projectRetentionEventHistory, type RetentionEventRecord } from "./ortho-retention-event-history";
import type { OccurrenceEvidence } from "./ortho-case-occurrence";
import type { RetentionEventArch } from "./ortho-retention-events";

export interface RetentionRecallIntent {
  eventId: number;
  arch: RetentionEventArch;
  deviceId: number | null;
  scope: string;
  occurrence: OccurrenceEvidence;
  dueOn: string | null;
  intervalDays: number | null;
  intervalDueDate: string | null;
  dueDate: string | null;
  ambiguityReasons: string[];
}
/** Recorded instructions only. This is not appointment/scheduling status. */
export interface RetentionRecallProjection {
  state: "invalid" | "not_recorded" | "recorded" | "ambiguous";
  /** Earliest recorded due date, only when every instruction can be resolved. */
  dueDate: string | null;
  intents: RetentionRecallIntent[];
}

function projectIntent(row: RetentionEventRecord): RetentionRecallIntent {
  const event = row.content;
  if (event.kind !== "followup_intent") throw new Error("invalid_recall_intent");
  const reasons: string[] = [];
  let intervalDate: string | null = null;
  if (event.intervalDays !== null) {
    if (event.occurrence.occurredOn === null) reasons.push("interval_anchor_unknown");
    else {
      const date = new Date(`${event.occurrence.occurredOn}T00:00:00.000Z`);
      date.setUTCDate(date.getUTCDate() + event.intervalDays);
      const formatted = date.toISOString().slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(formatted)) reasons.push("interval_date_out_of_range");
      else intervalDate = formatted;
    }
  }
  if (event.dueOn !== null && intervalDate !== null && event.dueOn !== intervalDate) reasons.push("conflicting_timing");
  if (event.dueOn !== null && event.occurrence.occurredOn !== null && event.dueOn < event.occurrence.occurredOn) reasons.push("due_precedes_instruction");
  if (row.arch === "legacy_unknown") reasons.push("arch_unknown");
  return { eventId: row.id, arch: row.arch, deviceId: event.device?.deviceId ?? null, scope: event.scope,
    occurrence: { ...event.occurrence }, dueOn: event.dueOn, intervalDays: event.intervalDays, intervalDueDate: intervalDate,
    dueDate: reasons.length ? null : event.dueOn ?? intervalDate, ambiguityReasons: reasons };
}

/** Only explicit corrections replace an instruction. Authored version and clinical
 * dates alone cannot establish cancellation of earlier instructions. Free-text
 * scope is preserved, never interpreted as evidence of independent appointments.
 * Never derives recall from adjustments, delivery, review or replacement. */
export function projectRetentionRecall(raw: unknown): RetentionRecallProjection {
  const history = projectRetentionEventHistory(raw);
  if (!history.ok) return { state: "invalid", dueDate: null, intents: [] };
  const intents = history.value.currentEvents.filter(row => row.content.kind === "followup_intent").map(projectIntent);
  for (const intent of intents) {
    const overlaps = intents.some(other => other !== intent && (other.arch === intent.arch || other.arch === "legacy_unknown" || intent.arch === "legacy_unknown")
      && (other.deviceId === null || intent.deviceId === null || other.deviceId === intent.deviceId));
    if (overlaps) intent.ambiguityReasons.push("overlapping_instructions");
    if (intent.deviceId !== null) {
      const device = history.value.devices.find(d => d.deviceId === intent.deviceId)!;
      if (["removed", "lost", "not_in_use", "ambiguous"].includes(device.currentState)) intent.ambiguityReasons.push("device_state_requires_reconciliation");
      if (device.arch !== intent.arch) intent.ambiguityReasons.push("device_arch_changed");
      if (history.value.devices.some(d => d.replacedDeviceId === intent.deviceId)) intent.ambiguityReasons.push("device_replaced_requires_reconciliation");
    }
    // Linkage ambiguity invalidates the resolved date, not the authored timing evidence.
    if (intent.ambiguityReasons.length) intent.dueDate = null;
  }
  if (!intents.length) return { state: "not_recorded", dueDate: null, intents };
  if (intents.some(intent => intent.ambiguityReasons.length || intent.dueDate === null)) return { state: "ambiguous", dueDate: null, intents };
  return { state: "recorded", dueDate: intents.map(intent => intent.dueDate!).sort()[0], intents };
}
