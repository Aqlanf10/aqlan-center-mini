import type { ResolvedStaffAccess } from "./staff-capabilities";

/** Single server adapter contract for the shared canonical authority system.
 * A future implementation must return a freshly admitted opaque access object,
 * with the proved owner binding version and clinician link, from that system.
 * Never accept this structure from request JSON or infer it from a legacy role. */
export interface CanonicalOwnerAuthority {
  readonly access: ResolvedStaffAccess;
  readonly bindingVersion: string;
}

/** The release base has only the inert foundation, not WORK's canonical admission
 * runtime. Fail closed until its separately reviewed integration is available.
 * No environment/settings backdoor, bootstrap, live binding or WORK copy here. */
export async function loadCanonicalOwnerAuthority(_userId: number): Promise<CanonicalOwnerAuthority | null> {
  return null;
}
