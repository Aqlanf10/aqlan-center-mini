import { readPatientAppointmentsQuery, type PatientAppointmentsPage } from "../../lib/patient-appointments-contract";
import { clinicDateString } from "../../lib/schedule";

/** Call after the fixture's origin/method guard. Projection GETs have a different shape. */
export function isPatientFileFixtureRead(url: URL, patientId: number): boolean {
  return url.pathname === `/api/patients/${patientId}` && !url.searchParams.has("projection");
}

/** Mock-only owners have no database patient. Handle their empty first page without forwarding APIs. */
export function emptyPatientAppointmentsFixtureRead(url: URL, patientId: number, now = new Date()): PatientAppointmentsPage | null {
  if (url.pathname !== `/api/patients/${patientId}` || url.searchParams.getAll("projection").length !== 1
    || url.searchParams.get("projection") !== "appointments") return null;
  const params = new URLSearchParams(url.search);
  params.delete("projection");
  const query = readPatientAppointmentsQuery(params, patientId);
  // An empty fixture never advertises a next page; unexpected cursors remain rejected.
  if (!query || query.requestCursor !== null) return null;
  const timeZone = "Asia/Aden";
  return { patientId, view: query.view, requestCursor: null, today: clinicDateString(now, timeZone),
    timeZone, generatedAt: now.toISOString(), canRemind: true, appointments: [], nextCursor: null };
}
