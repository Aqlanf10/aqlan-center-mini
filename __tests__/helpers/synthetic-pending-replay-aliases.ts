/** No alternative URL may redirect a CI-only pending-replay witness. */
export function validatePendingReplayAliases(env:Readonly<Record<string,string|undefined>>):void{
  const expected='postgresql://ci:ci@127.0.0.1:55472/aqlan_p1_test?sslmode=disable';
  for(const key of ['POSTGRES_URL','POSTGRES_PRISMA_URL','POSTGRES_URL_NON_POOLING','SOURCE_DATABASE_URL'] as const){
    if(env[key]!==undefined && env[key]!==expected)throw new Error('SYNTHETIC_PENDING_REPLAY_ALIAS_MISMATCH');
  }
}
