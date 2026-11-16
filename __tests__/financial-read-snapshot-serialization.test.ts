import {expect,it,vi} from 'vitest';
import {withFinancialReadSnapshot} from '../lib/financial-read-snapshot';
it('never overlaps queries on the leased connection',async()=>{
 let active=0,max=0;
 const query=vi.fn(async()=>{active++;max=Math.max(max,active);await new Promise(r=>setTimeout(r,2));active--;return {rows:[]};});
 const release=vi.fn(),client={query,release},pool={query,connect:async()=>client};
 await withFinancialReadSnapshot(pool,runner=>Promise.all([runner.query('SELECT 1'),runner.query('SELECT 2'),runner.query('SELECT 3')]));
 expect(max).toBe(1);expect(release).toHaveBeenCalledExactlyOnceWith(false);
});
it('drains an in-flight read before rollback and prevents escaped reads',async()=>{
 let active=0,max=0;const calls:string[]=[];let escaped:any;
 const failure=new Error('reader failed');
 const query=async(sql:string)=>{calls.push(sql);active++;max=Math.max(max,active);await new Promise(r=>setTimeout(r,2));active--;return {rows:[]};};
 const release=vi.fn(),client={query,release},pool={query,connect:async()=>client};
 await expect(withFinancialReadSnapshot(pool,async runner=>{escaped=runner;void runner.query('SELECT 1');await Promise.resolve();throw failure;})).rejects.toBe(failure);
 expect(max).toBe(1);expect(calls.at(-1)).toBe('ROLLBACK');
 await expect(escaped.query('SELECT late')).rejects.toThrow('FINANCIAL_SNAPSHOT_CLOSED');expect(calls).not.toContain('SELECT late');
});
it('does not run queued SQL after a query fails or commit swallowed failures',async()=>{
 const failure=new Error('query failed');const calls:string[]=[];
 const query=async(sql:string)=>{calls.push(sql);if(sql==='SELECT fail')throw failure;return {rows:[]};};
 const release=vi.fn(),client={query,release},pool={query,connect:async()=>client};
 await expect(withFinancialReadSnapshot(pool,async runner=>{await Promise.allSettled([runner.query('SELECT fail'),runner.query('SELECT skipped')]);return 42;})).rejects.toBe(failure);
 expect(calls).toEqual(['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY','SELECT fail','ROLLBACK']);
});
