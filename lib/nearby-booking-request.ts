/** Client-only transport contract. Tokens live only in this one rejected request. */
export interface NearbyBookingWarning {
  kind: "nearby_patient_appointments";
  confirmationToken: string;
  nearbyAppointments: { id: number; scheduledDate: string; scheduledTime: string; doctorName: string | null }[];
}
export function nearbyBookingWarning(payload: unknown): NearbyBookingWarning | null {
  if (!payload || typeof payload !== "object") return null;
  const outer = payload as Record<string, unknown>;
  const value = (outer.conflict && typeof outer.conflict === "object" ? outer.conflict : outer) as Record<string, unknown>;
  if (value.kind !== "nearby_patient_appointments" || typeof value.confirmationToken !== "string"
    || !value.confirmationToken || !Array.isArray(value.nearbyAppointments) || !value.nearbyAppointments.length) return null;
  if (!value.nearbyAppointments.every(item => item && typeof item === "object"
    && Number.isSafeInteger(item.id) && typeof item.scheduledDate === "string"
    && typeof item.scheduledTime === "string" && (item.doctorName === null || typeof item.doctorName === "string"))) return null;
  return value as unknown as NearbyBookingWarning;
}

export async function requestBookingWithConfirmation(
  url: string, init: RequestInit,
  confirm: (warning: NearbyBookingWarning) => Promise<boolean>,
  isCurrent: () => boolean,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  // Preserve the exact rejected JSON proposal; never rebuild it from edited state.
  const body = typeof init.body === "string" ? init.body : null;
  const response = await fetcher(url, init);
  if (response.status !== 409 || body === null || !isCurrent() || init.signal?.aborted) return response;
  const warning = nearbyBookingWarning(await response.clone().json().catch(() => null));
  if (!warning) return response;
  let proposal: Record<string, unknown>;
  try { proposal = JSON.parse(body); } catch { return response; }
  if (!proposal || typeof proposal !== "object" || Array.isArray(proposal)) return response;
  if (!isCurrent() || init.signal?.aborted) return response;
  if (!await confirm(warning) || !isCurrent() || init.signal?.aborted) return response;
  // A fresh server warning is returned normally, never auto-acknowledged in a loop.
  return fetcher(url, { ...init, body: JSON.stringify({ ...proposal,
    nearbyAppointmentConfirmation: warning.confirmationToken,
  }) });
}
