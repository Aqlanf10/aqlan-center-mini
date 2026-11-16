// Synthetic transport evidence only, never imported by product code. These are
// the two adjustment identities explicitly returned by this fixture's saves.
const proofs = new Map([
  [934101, "1".repeat(64)],
  [934102, "2".repeat(64)],
]);
export function patientOrthoBookingContext(url: URL, method: string, origin: string) {
  if (url.origin !== origin || method !== "GET" || url.pathname !== "/api/patients/939101/return-booking-context"
    || url.searchParams.size !== 2 || url.searchParams.get("kind") !== "ortho_adjustment") return null;
  const rawId = url.searchParams.get("sourceId");
  const id = Number(rawId);
  const fingerprint = proofs.get(id);
  if (!fingerprint || rawId !== String(id)) return null;
  return { ok: true, patientId: 939101, source: { kind: "ortho_adjustment", id },
    doctorId: 935101, doctorName: "Synthetic responsible doctor", fingerprint,
    settingsTarget: { kind: "ortho", id: 938101 } };
}
