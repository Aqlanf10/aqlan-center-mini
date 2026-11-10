import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { ORTHO_REOPEN_SQL } from '../lib/ortho-reopen-schema';
import { ORTHO_REOPEN_HISTORY_TABLES, RESET_KEEP_TABLES } from '../lib/clinic-reset';
it('pins the runtime migration to exact0125 bytes and retained clinical history',()=>{
 expect(ORTHO_REOPEN_SQL).toBe(readFileSync(new URL('../migrations/0125_ortho_case_reopen.sql',import.meta.url),'utf8'));
 expect(ORTHO_REOPEN_HISTORY_TABLES).toEqual(['ortho_case_reopen_events']);
 expect(RESET_KEEP_TABLES).toEqual(expect.arrayContaining([...ORTHO_REOPEN_HISTORY_TABLES]));
});
