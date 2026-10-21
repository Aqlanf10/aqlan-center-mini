import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile, readFile, stat } from 'node:fs/promises';
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
let secondBytes: Buffer;
let secondStorageKey: string;
beforeAll(async () => {
  fixture = await openBackupTimestampFixture({ ...process.env });
  directory = await mkdtemp(path.join(tmpdir(), 'security-pg18-restore-'));
  await migrate(fixture.source, { apply: true, files: await loadMigrationFiles() });
  sourceBytes = Buffer.from('PG18-ISOLATED-XRAY-FIXTURE-NOT-A-PATIENT', 'utf8');
  const content = sourceBytes.toString('utf8');
  storageKey = storageKeyOf(content);
  const sha = createHash('sha256').update(sourceBytes).digest('hex');
  secondBytes = Buffer.from('PG18-SECOND-SYNTHETIC-ATTACHMENT-FOR-LATE-IO-FAILURE', 'utf8');
  secondStorageKey = storageKeyOf(secondBytes.toString('utf8'));
  const secondSha = createHash('sha256').update(secondBytes).digest('hex');
  const patient = (await fixture.source.query(
    "INSERT INTO patients (patient_number, full_name) VALUES ('SEC-PG18-1','Synthetic PG18 fixture') RETURNING id"
  )).rows[0];
  await fixture.source.query(
    "INSERT INTO patient_documents (patient_id,kind,title,mime_type,size_bytes,sha256,storage_key,uploaded_by) VALUES ($1,'xray','synthetic document','image/png',$2,$3,$4,'synthetic')",
    [patient.id, sourceBytes.length, sha, storageKey],
  );
  await fixture.source.query(
    "INSERT INTO patient_documents (patient_id,kind,title,mime_type,size_bytes,sha256,storage_key,uploaded_by) VALUES ($1,'xray','second synthetic document','image/png',$2,$3,$4,'synthetic')",
    [patient.id, secondBytes.length, secondSha, secondStorageKey],
  );
  const client = await fixture.source.connect();
  try {
    const parts: Buffer[] = [];
    for await (const part of fullBackupBlocks({
      source: client,
      readDocument: async (key) => key === storageKey ? sourceBytes : key === secondStorageKey ? secondBytes : null,
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
      let emittedBytes = 0;
      for await (const part of fullBackupBlocks({ source:client, readDocument:async()=>null })) {
        emittedBytes += part.byteLength;
      }
      return emittedBytes;
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
  const partialStage = path.join(directory, 'partial-stage');
  // The first document must be created and verified successfully. Reserve the
  // second document's *file path* as a directory so its write fails with EISDIR
  // only after the first file has been written (not on initial mkdir).
  const blockedSecondPath = path.join(partialStage, secondStorageKey);
  await mkdir(blockedSecondPath, { recursive: true });
  // The source metadata query orders by patient_documents.id. Confirm the
  // archived physical entries are in the expected first-then-second order.
  const archived = parseTarBytes(gunzipSync(await readFile(validArchive)));
  const names = archived.order.filter((name) => name.startsWith('documents/'));
  expect(names).toHaveLength(2);
  expect(archived.entries.has('documents/' + storageKey.replaceAll('/', '_')) || names[0].includes(storageKey.slice(6))).toBe(true);
  // SQL commits first, then the first attachment writes; the second write fails.
  await expect(stagedRestore({
    archivePath: validArchive,
    targetUrl: fixture.archiveTarget.options.connectionString!,
    stagingDir: partialStage,
  })).rejects.toThrow();
  const firstWritten = await readFile(path.join(partialStage, storageKey));
  expect(firstWritten.equals(sourceBytes)).toBe(true);
  expect(createHash('sha256').update(firstWritten).digest('hex'))
    .toBe(createHash('sha256').update(sourceBytes).digest('hex'));
  expect((await stat(blockedSecondPath)).isDirectory()).toBe(true);
  const restored = (await fixture.archiveTarget.query(
    "SELECT count(*)::int AS n FROM patients WHERE patient_number='SEC-PG18-1'"
  )).rows[0].n;
  expect(restored).toBe(1); // Partially populated *disposable* target, never cut over
  expect((await fixture.archiveTarget.query(
    "SELECT count(*)::int AS n FROM patient_documents WHERE patient_id = (SELECT id FROM patients WHERE patient_number='SEC-PG18-1')"
  )).rows[0].n).toBe(2);
});
