import { findUserByUsername, getParty, listParties } from "./db";
import { clinicalCapabilityOf } from "./clinical-identity";
import { getPrescriptionOwnerAuthority } from "./prescription-owner";

export async function prescriptionPrescriberOptions(session: { userId: number; username: string; role: string }) {
  const unavailable = { issuerId: null, canChooseAnyDoctor: false, doctors: [] };
  const user = await findUserByUsername(session.username);
  if (!user || !user.isActive || user.id !== session.userId || user.role !== session.role) return unavailable;
  const clinical = clinicalCapabilityOf({ role: user.role, doctorPartyId: user.partyId });
  if (!clinical.ok || clinical.partyId === null) return unavailable;
  const issuer = await getParty(clinical.partyId);
  if (!issuer || issuer.kind !== "doctor" || !issuer.isActive) return unavailable;
  const canChooseAnyDoctor = Boolean(await getPrescriptionOwnerAuthority(user));
  const doctors = (canChooseAnyDoctor ? await listParties("doctor") : [issuer])
    .filter(doctor => doctor.kind === "doctor" && doctor.isActive && doctor.name.trim())
    .map(doctor => ({ id: doctor.id, name: doctor.name }));
  return { issuerId: issuer.id, canChooseAnyDoctor, doctors };
}
