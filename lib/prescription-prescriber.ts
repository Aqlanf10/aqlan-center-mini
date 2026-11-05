import { findUserByUsername, getParty, listParties } from "./db";
import { clinicalCapabilityOf } from "./clinical-identity";
import type { PrescriberUnavailableReason } from "./prescription-prescriber-feedback";
import { getPrescriptionOwnerAuthority } from "./prescription-owner";

export async function prescriptionPrescriberOptions(session: { userId: number; username: string; role: string }) {
  const unavailable = (unavailableReason: PrescriberUnavailableReason) => ({ issuerId: null, canChooseAnyDoctor: false, doctors: [], unavailableReason });
  const user = await findUserByUsername(session.username);
  if (!user || !user.isActive || user.id !== session.userId || user.role !== session.role) return unavailable("session_unavailable");
  if (user.role !== "admin" && user.role !== "doctor") return unavailable("role_ineligible");
  const clinical = clinicalCapabilityOf({ role: user.role, doctorPartyId: user.partyId });
  if (!clinical.ok || clinical.partyId === null) return unavailable("doctor_link_missing");
  const issuer = await getParty(clinical.partyId);
  if (!issuer || issuer.kind !== "doctor" || issuer.id !== clinical.partyId) return unavailable("doctor_identity_invalid");
  if (!issuer.isActive) return unavailable("doctor_identity_inactive");
  if (typeof issuer.name !== "string" || !issuer.name.trim()) return unavailable("doctor_name_missing");
  const canChooseAnyDoctor = Boolean(await getPrescriptionOwnerAuthority(user));
  const doctors = (canChooseAnyDoctor ? await listParties("doctor") : [issuer])
    .filter(doctor => doctor.kind === "doctor" && doctor.isActive && doctor.name.trim())
    .map(doctor => ({ id: doctor.id, name: doctor.name }));
  return { issuerId: issuer.id, canChooseAnyDoctor, doctors };
}
