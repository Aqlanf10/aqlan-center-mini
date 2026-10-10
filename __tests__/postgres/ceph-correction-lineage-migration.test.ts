import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { COORDINATED_MIGRATION_VERSIONS, loadMigrationFiles, migrate } from "../../lib/migrations";
import { CEPH_CORRECTION_LINEAGE_SQL } from "../../lib/ceph-correction-lineage-schema";
import { openPeriodontalFixture } from "./_periodontal-fixture";

/**
 * (ORTHO-ID-2) الهجرة المحجوزة 0047 على قاعدة PostgreSQL 18 اصطناعية فريدة: تُبنى السلسلة الفعلية حتى 0043، تُسجَّل
 * دراسات قديمة (بينها نسخة تصحيح كُتبت قبل العمود)، ثم تُطبَّق 0047. التحقق: لا فقد بيانات، لا أصل مخمَّن للنسخ القديمة،
 * القيود تعمل، وإعادة التشغيل بلا أثر. لا مال ولا Production.
 */
let fixture: Awaited<ReturnType<typeof openPeriodontalFixture>> | undefined;
const pool = () => fixture!.pool;
type Snapshot = { id: number; facts: Record<string, unknown> };
let oldRows: Snapshot[] = [];
let patientId = 0;

beforeAll(async () => {
  fixture = await openPeriodontalFixture(process.env, { pristine: true });
  const files = await loadMigrationFiles();
  expect(files.map((file) => file.version)).toEqual([...COORDINATED_MIGRATION_VERSIONS]);
  expect(files[files.length - 1].filename).toBe("0047_ceph_correction_lineage.sql");
  await migrate(pool(), { apply: true, files: files.slice(0, 43) });
  expect((await pool().query("SELECT to_regclass('public.ceph_analyses')::text AS rel")).rows[0].rel).not.toBeNull();
  expect((await pool().query("SELECT 1 FROM information_schema.columns WHERE table_name='ceph_analyses' AND column_name='corrects_analysis_id'")).rows).toHaveLength(0);

  patientId = (await pool().query<{ id: number }>("INSERT INTO patients (patient_number,full_name) VALUES ('SYN-LINEAGE-MIG','Synthetic lineage patient') RETURNING id")).rows[0].id;
  const document = (await pool().query<{ id: number }>(
    `INSERT INTO patient_documents (patient_id,kind,title,mime_type,size_bytes,sha256,storage_key,uploaded_by)
     VALUES ($1,'imaging','Synthetic','image/jpeg',1,'lineage-mig','synthetic/lineage-mig.jpg','synthetic') RETURNING id`, [patientId])).rows[0].id;
  // An approved study and a pre-0047 "correction copy" written the old way (origin only in the free-text note).
  const approved = (await pool().query<{ id: number }>(
    `INSERT INTO ceph_analyses (patient_id,document_id,status,phase,created_by,completed_by,completed_at)
     VALUES ($1,$2,'completed','posttreatment','synthetic','synthetic',NOW()) RETURNING id`, [patientId, document])).rows[0].id;
  const oldCopy = (await pool().query<{ id: number }>(
    `INSERT INTO ceph_analyses (patient_id,document_id,status,note,created_by)
     VALUES ($1,$2,'draft',$3,'synthetic') RETURNING id`, [patientId, document, `نسخة تصحيح عن التحليل #${approved}`])).rows[0].id;
  oldRows = [];
  for (const id of [approved, oldCopy]) {
    oldRows.push({ id, facts: (await pool().query("SELECT to_jsonb(a) AS facts FROM ceph_analyses a WHERE id=$1", [id])).rows[0].facts });
  }
  await migrate(pool(), { apply: true, files });
}, 240_000);
afterAll(async () => { await fixture?.close(); }, 30_000);

describe("0047 on a database that already holds studies", () => {
  it("adds one nullable column, keeps every existing row byte-for-byte, and guesses no origin for the old copy", async () => {
    for (const old of oldRows) {
      const { rows: [now] } = await pool().query("SELECT to_jsonb(a) - 'corrects_analysis_id' AS facts, corrects_analysis_id FROM ceph_analyses a WHERE id=$1", [old.id]);
      expect(now.facts).toEqual(old.facts);
      expect(now.corrects_analysis_id).toBeNull();
    }
    const { rows: [column] } = await pool().query(
      "SELECT data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name='ceph_analyses' AND column_name='corrects_analysis_id'");
    expect(column).toEqual({ data_type: "bigint", is_nullable: "YES", column_default: null });
    expect((await pool().query("SELECT COUNT(*)::int AS n FROM schema_migrations")).rows[0].n).toBe(COORDINATED_MIGRATION_VERSIONS.length);
    expect((await pool().query("SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1")).rows[0].version).toBe("0047");
  });

  it("enforces older-origin, same-patient and no-self-link rules", async () => {
    const [approved, oldCopy] = oldRows.map((row) => row.id);
    await expect(pool().query("UPDATE ceph_analyses SET corrects_analysis_id=id WHERE id=$1", [oldCopy])).rejects.toThrow(/ceph_analyses_corrects_older_chk/);
    await expect(pool().query("UPDATE ceph_analyses SET corrects_analysis_id=$2 WHERE id=$1", [approved, oldCopy])).rejects.toThrow(/ceph_analyses_corrects_older_chk/);
    const other = (await pool().query<{ id: number }>("INSERT INTO patients (patient_number,full_name) VALUES ('SYN-LINEAGE-MIG-2','Synthetic other') RETURNING id")).rows[0].id;
    const document = (await pool().query<{ id: number }>(
      `INSERT INTO patient_documents (patient_id,kind,title,mime_type,size_bytes,sha256,storage_key,uploaded_by)
       VALUES ($1,'imaging','Synthetic','image/jpeg',1,'lineage-mig-2','synthetic/lineage-mig-2.jpg','synthetic') RETURNING id`, [other])).rows[0].id;
    await expect(pool().query(
      "INSERT INTO ceph_analyses (patient_id,document_id,status,created_by,corrects_analysis_id) VALUES ($1,$2,'draft','synthetic',$3)",
      [other, document, approved])).rejects.toThrow(/ceph_analyses_corrects_same_patient_fk/);
  });

  it("is re-runnable: a second run of the migration body and of the migrator changes nothing", async () => {
    const before = (await pool().query("SELECT conname FROM pg_constraint WHERE conrelid='ceph_analyses'::regclass ORDER BY conname")).rows;
    await pool().query(CEPH_CORRECTION_LINEAGE_SQL);
    await pool().query(CEPH_CORRECTION_LINEAGE_SQL);
    expect((await pool().query("SELECT conname FROM pg_constraint WHERE conrelid='ceph_analyses'::regclass ORDER BY conname")).rows).toEqual(before);
    expect(await migrate(pool(), { apply: true, files: await loadMigrationFiles() })).toMatchObject({ appliedVersions: [], alreadyUpToDate: true });
  });
});
