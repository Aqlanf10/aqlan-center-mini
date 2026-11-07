import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { readFileByKeyBounded } from '../lib/files';
import { storageKey } from '../lib/storage';
let directory = '';
afterEach(async () => { if (directory) await rm(directory, {recursive:true,force:true}); directory=''; vi.unstubAllEnvs(); });
it('bounds actual stored bytes, leaves the original untouched, and rejects unsafe keys or invalid limits',async()=>{
 directory=await mkdtemp(join(tmpdir(),'synthetic-study-bounded-'));vi.stubEnv('DOCUMENTS_DIR',directory);
 const key=storageKey('a'.repeat(64),'png'), path=join(directory,key);await mkdir(dirname(path),{recursive:true});await writeFile(path,'synthetic');
 expect(await readFileByKeyBounded(key,9)).toEqual(Buffer.from('synthetic'));
 expect(await readFileByKeyBounded(key,8)).toBeNull();
 expect(await readFileByKeyBounded(key,9)).toEqual(Buffer.from('synthetic'));
 for(const limit of [0,-1,NaN,26*1024*1024])expect(await readFileByKeyBounded(key,limit)).toBeNull();
 expect(await readFileByKeyBounded('../escape',9)).toBeNull();
 expect(await readFileByKeyBounded(storageKey('b'.repeat(64),'png'),9)).toBeNull();
});
