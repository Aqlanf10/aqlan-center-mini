import type { ClientConfig } from 'pg';
import { sslForConnection } from '../db-tls';
import { assertNoAmbientPgOptions, parseRestoreIdentity } from './target-identity.mjs';
import { assertNoScopedRestoreCollision, snapshotRestoreEnvironment } from './target-scope';

export interface RestoreClientSnapshot { readonly targetUrl:string; readonly config:ClientConfig }
const issued = new WeakMap<object, readonly Readonly<Record<string,string | undefined>>[]>();

/** Snapshot validated effective identity and TLS before any administrative reset. */
export function createRestoreClientSnapshot(url:string, ...environments: Record<string,string | undefined>[]): RestoreClientSnapshot {
  assertNoAmbientPgOptions(process.env, ...environments);
  const identity=parseRestoreIdentity(url,{target:true});
  let ssl: ReturnType<typeof sslForConnection>;
  try { ssl=sslForConnection(identity.connectionString); }
  catch { throw new Error('RESTORE_TLS_CONFIGURATION_INVALID'); }
  if ((ssl === false && !identity.local) || (ssl !== false && (ssl.rejectUnauthorized !== true || !ssl.ca || (Array.isArray(ssl.ca) && ssl.ca.length === 0))))
    throw new Error('RESTORE_TLS_VERIFICATION_REQUIRED: a trusted CA is mandatory for remote restores.');
  const tls=ssl === false ? false : Object.freeze({ ...ssl, ...(ssl.ca ? {ca:Object.freeze([...ssl.ca]) as unknown as string[]} : {}), ...(identity.local ? {} : {servername:identity.host}) });
  const config:ClientConfig=Object.freeze({connectionString:identity.connectionString,ssl:tls});
  const result=Object.freeze({targetUrl:identity.connectionString,config});
  issued.set(result, environments.map(snapshotRestoreEnvironment)); return result;
}

/** Reject ambient pg overrides immediately before constructing either Client. */
export function restoreConfigFromSnapshot(snapshot:RestoreClientSnapshot, url:string):ClientConfig {
  const environments=issued.get(snapshot);
  if (!environments || snapshot.targetUrl !== url) throw new Error('RESTORE_TARGET_SNAPSHOT_INVALID');
  assertNoAmbientPgOptions(process.env, ...environments);
  assertNoScopedRestoreCollision(parseRestoreIdentity(snapshot.targetUrl, { target:true }), process.env, ...environments);
  return snapshot.config;
}
export function restoreClientConfigFor(url:string):ClientConfig {
  const snapshot=createRestoreClientSnapshot(url);
  return restoreConfigFromSnapshot(snapshot,snapshot.targetUrl);
}
