import type { Client } from "pg";
export type SubstrateClient = Pick<Client, "query">;
export interface IdentityExpectation { generationId: string; registryRevision: string }
/** Storage projection only; NEVER authentication or an operation capability. */
export interface QuarantinedIdentitySnapshot extends IdentityExpectation {
 readonly realmId: string;
 readonly status: "quarantined";
 readonly authorizesSessions: false;
}
export interface IdentityBindingInput {
 userId: number;
 currentSubjectId: string | null;
 expected: IdentityExpectation;
}
export function initializeStaffIdentitySubstrate(source: SubstrateClient, schema?: string): Promise<Readonly<QuarantinedIdentitySnapshot>>;
export function readStaffIdentitySubstrate(source: SubstrateClient, schema?: string): Promise<Readonly<QuarantinedIdentitySnapshot>>;
export function bindStaffAccountIncarnation(source: SubstrateClient, input: IdentityBindingInput, schema?: string): Promise<Readonly<QuarantinedIdentitySnapshot & {userId: number; subjectId: string}>>;
export function retireStaffAccountIncarnation(source: SubstrateClient, input: IdentityBindingInput & {currentSubjectId: string}, schema?: string): Promise<Readonly<QuarantinedIdentitySnapshot>>;
export function advanceStaffIdentityTargetGeneration(source: SubstrateClient, input: {expected: IdentityExpectation; reason: "reset" | "restore"}, schema?: string): Promise<Readonly<QuarantinedIdentitySnapshot>>;
export function assertStaffIdentitySourceRestoreAllowed(sourcePayload: unknown): never;
