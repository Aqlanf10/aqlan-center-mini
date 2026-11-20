import { describe,it,expect,vi } from 'vitest';
import type { Pool } from 'pg';
import { createPatientNumberingPostgresBackend,withPatientNumberingMode } from '../lib/patient-numbering-postgres';
describe('unwired numbering bridge',()=>{
  it('defaults to no backend and preserves legacy callback exactly',async()=>{
    const backend=createPatientNumberingPostgresBackend();expect(backend).toBeNull();
    const legacy=vi.fn(async()=>({id:42,number:'P-900001'})),configured=vi.fn();
    expect(await withPatientNumberingMode(backend,legacy,configured)).toEqual({id:42,number:'P-900001'});
    expect(legacy).toHaveBeenCalledOnce();expect(configured).not.toHaveBeenCalled();
  });
  it('never falls back to legacy after configured backend failure',async()=>{
    const pool={connect:vi.fn().mockRejectedValue(new Error('synthetic unavailable'))} as unknown as Pool;
    const backend=createPatientNumberingPostgresBackend({pool,schema:'synthetic_numbering',owner:async()=>null});
    const legacy=vi.fn(async()=>null),configured=vi.fn();
    await expect(withPatientNumberingMode(backend,legacy,configured)).rejects.toThrow('synthetic unavailable');
    expect(legacy).not.toHaveBeenCalled();
  });
  it('constructs no connection and refuses untrusted SQL identifiers',()=>{
    const pool={connect:vi.fn()} as unknown as Pool;
    expect(()=>createPatientNumberingPostgresBackend({pool,schema:'public; DROP SCHEMA public',owner:async()=>null})).toThrow();
    expect(pool.connect).not.toHaveBeenCalled();
  });
});
