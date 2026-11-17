import { lstat, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Client } from 'pg';
import { validateFocusedRollbackWitnessEnvironment } from '../postgres/_focused-rollback-witness-guard';
import { serializeRetainedRollbackReport } from './retained-rollback-report';

/** Only a generated directory for this exact CI run and attempt is eligible. */
export function selectSyntheticWitnessDirectory(names: string[], runId: string, attempt: string): string {
  if (!/^[1-9][0-9]*$/.test(runId) || !/^[1-9][0-9]*$/.test(attempt)) throw new Error('Invalid synthetic witness.');
  const prefix = `hr-composed-legacy-restore-${runId}-${attempt}-`;
  const candidates = names.filter(name => name.startsWith(prefix) && /^[a-zA-Z0-9]{6}$/.test(name.slice(prefix.length)));
  if (candidates.length !== 1) throw new Error('Invalid synthetic witness.');
  return candidates[0];
}

async function ownedFile(file: string, maximum: number): Promise<string> {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size <= 0 || info.size > maximum
      || typeof process.getuid !== 'function' || info.uid !== process.getuid()) throw new Error('Invalid synthetic witness.');
  return readFile(file, 'utf8');
}

/** Upload only a strict fixed-field report; raw archives and databases stay local. */
export async function captureFocusedRollbackReport(env: NodeJS.ProcessEnv): Promise<void> {
  validateFocusedRollbackWitnessEnvironment(env);
  const root = await realpath(env.RUNNER_TEMP!);
  const name = selectSyntheticWitnessDirectory(await readdir(root), env.GITHUB_RUN_ID!, env.GITHUB_RUN_ATTEMPT!);
  const dir = path.join(root, name), dirStat = await lstat(dir);
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink() || await realpath(dir) !== dir
      || typeof process.getuid !== 'function' || dirStat.uid !== process.getuid()) throw new Error('Invalid synthetic witness.');
  const entries = await readdir(dir);
  const identities = entries.filter(entry => /^identity-aqlan_backup_precision_[a-f0-9]{32}\.json$/.test(entry));
  if (identities.length !== 3) throw new Error('Invalid synthetic witness.');
  const recorded: { name: string; oid: string; owner: string }[] = [];
  for (const filename of identities) {
    const identity = JSON.parse(await ownedFile(path.join(dir, filename), 1024)) as Record<string, unknown>;
    if (Object.keys(identity).sort().join(',') !== 'name,oid,owner'
        || identity.name !== filename.slice('identity-'.length, -'.json'.length)
        || typeof identity.oid !== 'string' || !/^[0-9]+$/.test(identity.oid)
        || typeof identity.owner !== 'string' || !/^[0-9]+$/.test(identity.owner)) throw new Error('Invalid synthetic witness.');
    recorded.push({ name: identity.name as string, oid: identity.oid, owner: identity.owner });
  }
  const report = JSON.parse(await ownedFile(path.join(dir, 'synthetic-rollback-report.json'), 4096));
  const safe = serializeRetainedRollbackReport(report, true);
  // Recheck the same owned service and all three database identities before
  // producing anything eligible for upload. No URL or query result is output.
  const client = new Client({ connectionString: env.TEST_DATABASE_URL!, ssl: false });
  await client.connect();
  try {
    const { rows: [server] } = await client.query<{ database: string; user: string; version: string }>(
      "SELECT current_database() AS database, current_user AS \"user\", current_setting('server_version_num') AS version",
    );
    if (server.database !== 'aqlan_p1_test' || server.user !== 'ci' || Math.floor(Number(server.version) / 10000) !== 18) {
      throw new Error('Invalid synthetic witness.');
    }
    const { rows } = await client.query<{ name: string; oid: string; owner: string; owned: boolean }>(
      'SELECT datname AS name, oid::text, datdba::text AS owner, pg_get_userbyid(datdba)=current_user AS owned FROM pg_database WHERE datname=ANY($1::text[])',
      [recorded.map(item => item.name)],
    );
    if (rows.length !== 3 || recorded.some(item => !rows.some(row => row.name === item.name && row.oid === item.oid && row.owner === item.owner && row.owned))) {
      throw new Error('Invalid synthetic witness.');
    }
  } finally { await client.end(); }
  const output = path.join(root, `focused-rollback-report-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}.json`);
  await writeFile(output, safe, { flag: 'wx', mode: 0o600 });
}

