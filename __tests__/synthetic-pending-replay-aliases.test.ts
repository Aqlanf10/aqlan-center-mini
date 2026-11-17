import { expect, it } from 'vitest';
import { validatePendingReplayAliases } from './helpers/synthetic-pending-replay-aliases';

const ci='postgresql://ci:ci@127.0.0.1:55472/aqlan_p1_test?sslmode=disable';
const keys=['POSTGRES_URL','POSTGRES_PRISMA_URL','POSTGRES_URL_NON_POOLING','SOURCE_DATABASE_URL'] as const;
it('accepts absent aliases and exact copies of the dedicated CI service only',()=>{
  expect(()=>validatePendingReplayAliases({})).not.toThrow();
  expect(()=>validatePendingReplayAliases(Object.fromEntries(keys.map(key=>[key,ci])))).not.toThrow();
  for(const key of keys){
    for(const bad of ['',` ${ci}`,ci.replace('55472','55473'),ci.replace('aqlan_p1_test','synthetic_other'),ci.replace('ci:ci','other:other'),ci.replace('sslmode=disable','sslmode=require')]){
      expect(()=>validatePendingReplayAliases({[key]:bad})).toThrow('SYNTHETIC_PENDING_REPLAY_ALIAS_MISMATCH');
    }
  }
});
