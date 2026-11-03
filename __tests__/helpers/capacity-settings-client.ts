import type { CapacityContext } from "@/lib/capacity-context";
import type { DbClient } from "@/lib/db";

/** Capacity-policy fixture; real lock contention is covered by native PG tests. */
export function capacitySettingsClient(context: CapacityContext): DbClient {
  let locked = false;
  const settings = {
    "clinic.day_start": context.shifts[0].start,
    "clinic.day_end": context.shifts[0].end,
    "clinic.shift2_start": context.shifts[1]?.start ?? "",
    "clinic.shift2_end": context.shifts[1]?.end ?? "",
    "clinic.chairs": String(context.chairs),
    "scheduling.near_capacity_percent": String(context.nearCapacityPercent),
    "scheduling.emergency_reserve_minutes": String(context.emergencyReserveMinutes),
    "scheduling.new_patient_daily_limit": String(context.newPatientDailyLimit),
  };
  return {
    query: async (sql: string) => {
      if (sql === "LOCK TABLE settings IN SHARE MODE NOWAIT") {
        locked = true;
        return { rows: [] };
      }
      if (sql === "SELECT key, value FROM settings" && locked) {
        return { rows: Object.entries(settings).map(([key, value]) => ({ key, value })) };
      }
      throw new Error(`Unexpected capacity fixture query: ${sql}`);
    },
  } as unknown as DbClient;
}
