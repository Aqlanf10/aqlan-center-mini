import { projectRetentionEventHistory, type RetentionEventRecord } from "./ortho-retention-event-history";
import type { FollowupCase } from "./ortho-followup";

/** Use only recorded recall instructions. Corrections replace facts, while
 * a newer instruction for the same arch/device supersedes its earlier recall.
 * Never derive retention recall from the last active-treatment adjustment. */
export function projectRetentionRecall(raw: unknown): NonNullable<FollowupCase["retentionRecall"]> {
  if (!Array.isArray(raw) || raw.length > 5000) return { state: "invalid", dueDate: null };
  const history = projectRetentionEventHistory(raw as RetentionEventRecord[]);
  if (!history.ok) return { state: "invalid", dueDate: null };
  const latest = new Map<string, RetentionEventRecord>();
  for (const row of [...history.value.currentEvents].sort((a, b) => a.version - b.version)) {
    if (row.content.kind === "followup_intent") latest.set(`${row.arch}:${row.content.device?.deviceId ?? "arch"}`, row);
  }
  const dates: string[] = [];
  for (const row of latest.values()) {
    const event = row.content;
    if (event.kind !== "followup_intent") continue;
    if (event.dueOn) dates.push(event.dueOn);
    else if (event.intervalDays !== null && event.occurrence.occurredOn) {
      const date = new Date(`${event.occurrence.occurredOn}T12:00:00Z`);
      date.setUTCDate(date.getUTCDate() + event.intervalDays);
      dates.push(date.toISOString().slice(0, 10));
    }
  }
  return { state: latest.size ? "recorded" : "not_recorded", dueDate: dates.sort()[0] ?? null };
}
