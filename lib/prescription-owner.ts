/** Server-only configuration boundary. Never infer ownership from role, username,
 * first user, a client payload, or staff-editable permissions/settings.
 * Missing binding fails closed; this code does not configure a live account. */
export function isConfiguredPrescriptionOwner(user: {
  id: number; username: string; role: string; isActive: boolean; partyId: number | null;
}): boolean {
  const rawId = process.env.PRESCRIPTION_OWNER_USER_ID ?? "";
  const version = process.env.PRESCRIPTION_OWNER_BINDING_VERSION ?? "";
  if (!/^[1-9]\d*$/.test(rawId) || !/^[A-Za-z0-9._:-]{1,128}$/.test(version)) return false;
  const ownerId = Number(rawId);
  return Number.isSafeInteger(ownerId) && user.id === ownerId && user.isActive === true
    && user.role === "admin" && Number.isSafeInteger(user.partyId) && user.partyId! > 0;
}
