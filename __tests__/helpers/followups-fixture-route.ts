import type { readAppointmentFollowupQueue } from "../../lib/appointment-followup-db";
import { parseFollowupPage } from "../../lib/appointment-followup-page";

/** Explicit board (null) or exact synthetic patient scope. Never forward queue data. */
export function emptyFollowupsFixtureRead(url: URL, method: string, origin: string, expectedPatientId: number | null):
  Awaited<ReturnType<typeof readAppointmentFollowupQueue>> | null {
  if (url.origin !== origin || method !== "GET" || url.pathname !== "/api/appointment-followups"
    || [...url.searchParams.keys()].length !== (expectedPatientId === null ? 1 : 2) || url.searchParams.get("limit") !== "25") return null;
  const page = parseFollowupPage(url.searchParams);
  if (!page || page.limit !== 25 || page.patientId !== expectedPatientId || page.cursor !== null) return null;
  return { timeZone: "Asia/Aden", items: [], hasMore: false, nextCursor: null };
}
