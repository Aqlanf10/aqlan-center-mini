export interface PasswordResetClient {query(sql:string,values?:unknown[]):Promise<{rows:any[]}>}
export interface PasswordResetInput {username:string;password:string;hashPassword(value:string):Promise<string>;verifyPassword(value:string,hash:string):Promise<boolean>}
/** Dedicated connection only; caller must close on any failure. */
export function resetLegacyPassword(client:PasswordResetClient,input:PasswordResetInput,schema?:string):Promise<void>;
