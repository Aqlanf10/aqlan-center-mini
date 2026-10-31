import {createHash} from 'node:crypto';
import {readdir,readFile} from 'node:fs/promises';

/** Filesystem-only provenance for the plain-Node SQL restore CLI. No DB/bootstrap. */
export async function loadRestoreMigrationChecksums(directory=new URL('../../migrations/',import.meta.url)) {
  const files=[];
  const seen=new Set();
  for(const filename of await readdir(directory)){
    const match=/^(\d{4})_([a-z0-9_]+)\.sql$/.exec(filename);
    if(!match)continue;
    if(seen.has(match[1]))throw new Error('Duplicate restore migration version.');
    seen.add(match[1]);
    const sql=await readFile(new URL(filename,directory),'utf8');
    files.push({version:match[1],checksum:createHash('sha256').update(sql,'utf8').digest('hex')});
  }
  if(!seen.has('0001'))throw new Error('Restore migration provenance unavailable.');
  return files;
}
