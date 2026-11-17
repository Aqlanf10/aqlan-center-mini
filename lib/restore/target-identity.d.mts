export interface RestoreIdentity { connectionString:string; host:string; port:string; database:string; user:string; hostKey:string; local:boolean }
export declare function assertNoAmbientPgOptions(...environments: Record<string,string|undefined>[]): void;
export declare function parseRestoreIdentity(raw:string, options?: {target?:boolean}): RestoreIdentity;
export declare function assertNoRuntimeTargetCollision(identity:RestoreIdentity, ...environments: Record<string,string|undefined>[]): void;
