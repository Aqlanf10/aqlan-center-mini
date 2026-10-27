import type { DbClient } from "./db";
type AuthorityClient = Pick<DbClient, "query">;

export interface StaffExecutionIdentity {
  realmId: string;
  executionEpochId: string;
}
export function bootstrapStaffIdentityInTransaction(client: AuthorityClient, reason: string): Promise<StaffExecutionIdentity>;
export function rotateStaffExecutionEpochInTransaction(client: AuthorityClient, reason: string): Promise<StaffExecutionIdentity>;
export function finalizeRestoredStaffIdentityInTransaction(client: AuthorityClient): Promise<StaffExecutionIdentity | null>;
export function rotateResetStaffIdentityInTransaction(client: AuthorityClient): Promise<StaffExecutionIdentity | null>;
