import {readFileSync} from 'node:fs';
import {expect,it} from 'vitest';
import {CEPH_CORRECTION_LINEAGE_SQL} from '../lib/ceph-correction-lineage-schema';
it('keeps the new additive schema exact without mutating old source rows',()=>{
 expect(CEPH_CORRECTION_LINEAGE_SQL).toBe(readFileSync('migrations/0124_ceph_correction_lineage.sql','utf8'));
 expect(CEPH_CORRECTION_LINEAGE_SQL).not.toMatch(/UPDATE\s+ceph_analyses\s+SET/i);
 expect(CEPH_CORRECTION_LINEAGE_SQL).toContain('DEFERRABLE INITIALLY DEFERRED');
 expect(CEPH_CORRECTION_LINEAGE_SQL).toContain("OR EXISTS(SELECT 1 FROM ceph_completion_provenance WHERE analysis_id=parent.id)");
});
