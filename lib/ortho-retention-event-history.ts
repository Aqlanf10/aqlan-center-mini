/** Pure reconstruction of validated documentary history; never infers clinical dates. */
import type { Checked } from "./ortho-case-journey-records";
import { checkRetentionEventCommand, type RetentionEvent, type RetentionEventArch } from "./ortho-retention-events";
export interface RetentionEventRecord {
  id: number; version: number; arch: RetentionEventArch; supersedesEntryId: number | null;
  archCorrectionReason: string | null; content: RetentionEvent;
}
export interface RetentionDeviceProjection {
  deviceId: number; deliveryRevisionId: number; lastEventId: number; arch: RetentionEventArch;
  delivery: Extract<RetentionEvent, { kind: "device_delivery" | "device_replacement" }>;
  replacedDeviceId: number | null;
  /** Unknown/conflicting clinical timing must never be represented as a verified interval. */
  currentState: "in_use" | "not_in_use" | "lost" | "removed" | "replaced" | "unknown" | "ambiguous";
  stateEventId: number | null; intervalStart: string | null; intervalEnd: string | null;
  ambiguityReasons: string[];
}
function fail(code: string): never { throw new Error(code); }
const positive = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n > 0;
export function projectRetentionEventHistory(records: readonly RetentionEventRecord[]): Checked<{ devices: RetentionDeviceProjection[]; currentEvents: RetentionEventRecord[] }> {
  try {
    const ordered = [...records].sort((a, b) => a.version - b.version), seen = new Map<number, RetentionEventRecord>();
    const successors = new Map<number, number>(), documentaryRoot = new Map<number, number>();
    const replacementSuccessors = new Map<number, number>();
    const deviceHeads = new Map<number, number>(), currentDelivery = new Map<number, RetentionEventRecord>();
    for (let index = 0; index < ordered.length; index++) {
      const r = ordered[index];
      if (!positive(r.id) || seen.has(r.id) || r.version !== index + 1) fail("invalid_retention_lineage");
      const checked = checkRetentionEventCommand({ schemaVersion: 1, clientRequestId: "history_read_only", expectedHeadId: null, reason: "history",
        arch: r.arch, supersedesEntryId: r.supersedesEntryId, archCorrectionReason: r.archCorrectionReason, content: r.content });
      if (!checked.ok) fail(checked.code);
      const original = r.supersedesEntryId === null ? undefined : seen.get(r.supersedesEntryId);
      if (r.supersedesEntryId !== null && (!original || successors.has(r.supersedesEntryId) || original.content.kind !== r.content.kind)) fail("invalid_event_correction");
      if (original && (original.arch !== r.arch) !== (r.archCorrectionReason !== null)) fail("arch_correction_reason_mismatch");
      const root = original ? documentaryRoot.get(original.id)! : r.id;
      const target = "device" in r.content ? r.content.device : r.content.kind === "device_replacement" ? r.content.replaces : null;
      const originalTarget = original ? ("device" in original.content ? original.content.device : original.content.kind === "device_replacement" ? original.content.replaces : null) : null;
      if (original && (originalTarget?.deviceId ?? null) !== (target?.deviceId ?? null)) fail("correction_retargets_device");
      if (r.content.kind === "device_replacement") {
        const priorReplacement = replacementSuccessors.get(r.content.replaces.deviceId);
        if (priorReplacement !== undefined && priorReplacement !== root) fail("device_already_replaced");
        replacementSuccessors.set(r.content.replaces.deviceId, root);
      }
      if (target) {
        const delivery = currentDelivery.get(target.deviceId);
        // Membership in this map proves an earlier case-version root, independently of serial ID order.
        if (!delivery || delivery.version >= r.version || delivery.arch !== r.arch || deviceHeads.get(target.deviceId) !== target.expectedDeviceRevisionId) fail("device_reference_changed");
        deviceHeads.set(target.deviceId, r.id);
      }
      if (r.content.kind === "device_delivery" || r.content.kind === "device_replacement") {
        // A correction retains the original physical ID; replacement is a new root.
        if (!original && currentDelivery.has(root)) fail("duplicate_device");
        currentDelivery.set(root, r); deviceHeads.set(root, r.id);
      }
      if (original) successors.set(original.id, r.id);
      documentaryRoot.set(r.id, root); seen.set(r.id, r);
    }
    const currentEvents = ordered.filter(r => !successors.has(r.id));
    const devices: RetentionDeviceProjection[] = [];
    for (const [deviceId, deliveryRow] of currentDelivery) {
      if (deliveryRow.content.kind !== "device_delivery" && deliveryRow.content.kind !== "device_replacement") fail("invalid_device_root");
      const delivery = deliveryRow.content;
      const device: RetentionDeviceProjection = { deviceId, deliveryRevisionId: deliveryRow.id, lastEventId: deviceHeads.get(deviceId)!, arch: deliveryRow.arch, delivery,
        replacedDeviceId: delivery.kind === "device_replacement" ? delivery.replaces.deviceId : null,
        currentState: "unknown", stateEventId: null, intervalStart: delivery.occurrence.occurredOn, intervalEnd: null, ambiguityReasons: [] };
      const events = currentEvents.filter(r => r.content.kind === "device_status_change" && r.content.device.deviceId === deviceId
        || r.content.kind === "device_replacement" && r.content.replaces.deviceId === deviceId);
      const related = currentEvents.filter(r => ("device" in r.content && r.content.device?.deviceId === deviceId)
        || (r.content.kind === "device_replacement" && r.content.replaces.deviceId === deviceId));
      // Correcting delivery facts does not silently rewrite earlier authored reviews/statuses.
      if (related.some(r => r.arch !== deliveryRow.arch)) device.ambiguityReasons.push("dependent_event_arch_mismatch");
      if (delivery.occurrence.occurredOn === null) device.ambiguityReasons.push("delivery_date_unknown");
      // A delivery is evidence of delivery only; no default wearing/adherence state.
      const dated = events.filter(r => r.content.occurrence.occurredOn !== null);
      if (dated.length !== events.length) device.ambiguityReasons.push("status_date_unknown");
      if (dated.some(r => delivery.occurrence.occurredOn !== null && r.content.occurrence.occurredOn! < delivery.occurrence.occurredOn)) device.ambiguityReasons.push("status_precedes_delivery");
      const dates = new Set(dated.map(r => r.content.occurrence.occurredOn));
      if (dates.size !== dated.length) device.ambiguityReasons.push("same_day_order_unknown");
      const replacement = dated.find(r => r.content.kind === "device_replacement");
      if (replacement && dated.some(r => r.content.kind === "device_status_change"
        && r.content.occurrence.occurredOn! > replacement.content.occurrence.occurredOn!)) {
        device.ambiguityReasons.push("status_after_replacement");
      }
      if (device.ambiguityReasons.length) device.currentState = "ambiguous";
      else if (dated.length) {
        const last = [...dated].sort((a, b) => a.content.occurrence.occurredOn!.localeCompare(b.content.occurrence.occurredOn!)).at(-1)!;
        device.stateEventId = last.id;
        if (last.content.kind === "device_replacement") { device.currentState = "replaced"; device.intervalEnd = last.content.occurrence.occurredOn; }
        else if (last.content.kind === "device_status_change") { device.currentState = last.content.status; if (last.content.status !== "in_use" && last.content.status !== "unknown") device.intervalEnd = last.content.occurrence.occurredOn; }
      }
      devices.push(device);
    }
    return { ok: true, value: { devices, currentEvents } };
  } catch (e) { return { ok: false, code: e instanceof Error ? e.message : "invalid_retention_history" }; }
}
