import { describe, expect, it } from 'vitest';
import { registryMutations } from './helpers/standalone-registry-mutations.mjs';
import { prepareBackupSql } from '../lib/restore/sql.mjs';

const checksum='5603226d149a9be0635d4e99eeaff606d5cc881ce1552b56bf7fbad203044c99';
const record=`INSERT INTO schema_migrations ("version", "name", "checksum", "applied_at", "adopted") VALUES ('0079', 'ortho_followup_coverage', '${checksum}', '2025-03-04T05:06:07.123456+00:00', FALSE);`;
const baseline='b'.repeat(64);
const files=[{version:'0001',name:'baseline_schema',checksum:baseline},{version:'0079',name:'ortho_followup_coverage',checksum}];
const prepare=(row:string)=>prepareBackupSql(`BEGIN;\n${row}\nCOMMIT;`,{inspectHistorical0079:true,migrationFiles:files});

describe('synthetic HTTP witness mutations',()=>{
  it('accepts the original control and rejects every deliberately invalid record',()=>{
    expect(prepare(record).historical0079?.appliedAt).toBe('2025-03-04T05:06:07.123456+00:00');
    const mutations=registryMutations(record,baseline);
    expect(Object.keys(mutations).sort()).toEqual(['0001-missing-fields','0090-missing-fields','adopted','invalid-time','wrong-checksum','wrong-name']);
    for(const [kind,mutation] of Object.entries(mutations)) {
      expect(mutation === record).toBe(false);
      expect(()=>prepare(kind === '0001-missing-fields' ? `${record}\n${mutation}` : mutation)).toThrow();
    }
  });
  it('refuses an unexpected source record instead of making a no-op mutation',()=>{
    expect(()=>registryMutations(record.replace("'ortho_followup_coverage'","'unknown'"),baseline)).toThrow();
    expect(()=>registryMutations(record.replace('.123456','.123'),baseline)).toThrow();
    expect(()=>registryMutations(record.replace(', FALSE);',', TRUE);'),baseline)).toThrow();
    expect(()=>registryMutations(record,'not-a-checksum')).toThrow();
  });
});
