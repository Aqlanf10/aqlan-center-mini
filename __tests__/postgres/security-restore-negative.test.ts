import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { openBackupTimestampFixture } from './_backup-timestamp-fixture';
import { loadMigrationFiles, migrate } from '../../lib/migrations';
import { fullBackupBlocks } from '../../lib/fullBackup';
import { stagedRestore } from '../../lib/restore/staging';
import { parseTarBytes } from '../../lib/restore/archive';
import { storageKeyOf } from '../helpers/backup-blocks';
import { tarGzBytes } from '../helpers/backup-tar';

vi.mock('next/headers', () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ get: () => undefined }),
}));

// Synthetic-only, owned PostgreSQL 18 databases created by a validated fixture.
// No production URL, data, services, or attachments are used.
let fixture: Awaited<ReturnType<typeof openBackupTimestampFixture>>;
let directory: string;
let validArchive: string;
let storageKey: string;
let sourceBytes: Buffer;
beforeAll(async () => {
  fixture = await openBackupTimestampFixture({ ...process.env });
  directory = await mkdtemp(path.join(tmpdir(), 'security-pg18-restore-'));
  await migrate(fixture.source, { apply: true, files: await loadMigrationFiles() });
  sourceBytes = Buffer.from('PG18-ISOLATED-XRAY-FIXTURE-NOT-A-PATIENT', 'utf8');
  const content = sourceBytes.toString('utf8');
  storageKey = storageKeyOf(content);
  const sha = createHash('sha256').update(sourceBytes).digest('hex');
  const patient = (await fixture.source.query(
    "INSERT INTO patients (patient_number, full_name) VALUES ('SEC-PG18-1','Synthetic PG18 fixture') RETURNING id"
  )).rows[0];
  await fixture.source.query(
    "INSERT INTO patient_documents (patient_id,kind,title,mime_type,size_bytes,sha256,storage_key,uploaded_by) VALUES ($1,'xray','synthetic document','image/png',$2,$3,$4,'synthetic')",
    [patient.id, sourceBytes.length, sha, storageKey],
  );
  const client = await fixture.source.connect();
  try {
    const parts: Buffer[] = [];
    for await (const part of fullBackupBlocks({
      source: client, readDocument: async (key) => key === storageKey ? sourceBytes : null,
    })) parts.push(Buffer.from(part));
    validArchive = path.join(directory, 'valid.tar.gz');
    await writeFile(validArchive, gzipSync(Buffer.concat(parts)));
  } finally { client.release(); }
}, 300_000);

afterAll(async () => {
  try { await fixture?.close(); }
  finally { if (directory) await rm(directory, { recursive:true, force:true }); }
});

it('PG18 actual backup writer refuses missing registered physical document', async () => {
  const client = await fixture.source.connect();
  try {
    const collect = async () => {
      for await (const _part of fullBackupBlocks({source:client, readDocument:async()=>null})) { }
    };
    await expect(collect()).rejects.toThrow(/missing or corrupt/i);
  } finally { client.release(); }
});

it('PG18 actual restore refuses archive missing the referenced attachment before touching target', async () => {
  const parsed = parseTarBytes(gunzipSync(await readFile(validArchive)));
  const entries = parsed.order.filter(name => !name.startsWith('documents/'))
    .map(name => ({ name, data: parsed.entries.get(name)!.data }));
  const archivePath = path.join(directory, 'missing-document.tar.gz');
  await writeFile(archivePath, tarGzBytes(entries));
  const result = await stagedRestore({
    archivePath,
    targetUrl: fixture.sqlTarget.options.connectionString!,
    stagingDir: path.join(directory, 'missing-document-stage'),
  });
  expect(result.ok).toBe(false);
  expect(result.validationErrors.length).toBeGreaterThan(0);
  const count = (await fixture.sqlTarget.query(
    "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'"
  )).rows[0].n;
  expect(count).toBe(0);
});

it('PG18 partial staging-directory failure leaves isolated target unqualified; no automatic cutover', async () => {
  const invalidStage = path.join(directory, 'this-is-a-file-not-a-directory');
  await writeFile(invalidStage, 'synthetic-blocker');
  // Current code applies SQL in a transaction before writing the documents;
  // file IO error then fails the restore and leaves a disposable partial target.
  await expect(stagedRestore({
    archivePath: validArchive,
    targetUrl: fixture.archiveTarget.options.connectionString!,
    stagingDir: invalidStage,
  })).rejects.toThrow();
  const restored = (await fixture.archiveTarget.query(
    "SELECT count(*)::int AS n FROM patients WHERE patient_number='SEC-PG18-1'"
  )).rows[0].n;
  expect(restored).toBe(1); // partial state is explicitly recorded, not called success
  expect((await readFile(invalidStage, 'utf8'))).toBe('synthetic-blocker');
});
