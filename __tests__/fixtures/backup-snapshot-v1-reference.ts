/** Frozen pre-refactor canonical exporter from composed tree
 * d3196a2777f1e19120d61fa0a994eb677e2501f3, lib/db.ts.
 * Test oracle only: never imported by runtime or used as a second exporter.
 */
import { backupSelectColumns, insertStatement, insertionOrder, sequenceResets } from '../../lib/backup';
import type { Queryable } from '../../lib/db';

export async function* backupSnapshotSqlLines(pool: Queryable): AsyncGenerator<string> {

  const { rows: tableRows } = (await pool.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name`,
  )) as { rows: { table_name: string }[] };
  const tables = tableRows.map((row) => row.table_name);

  // الترتيب من مفاتيح القاعدة نفسها لا من قائمة مكتوبة بيد: قائمةٌ يدوية تنسى جدولًا
  // يُضاف غدًا، فتفشل الاستعادة بخطأ مفتاح أجنبي في أسوأ لحظة.
  const { rows: fkRows } = (await pool.query(
    `SELECT tc.table_name AS child, ccu.table_name AS parent
       FROM information_schema.table_constraints tc
       JOIN information_schema.constraint_column_usage ccu
         ON ccu.constraint_name = tc.constraint_name
      WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'`,
  )) as { rows: { child: string; parent: string }[] };
  const dependsOn = new Map(tables.map((table) => [table, new Set<string>()]));
  for (const row of fkRows) {
    // A patient's optional photo points back to a document owned by that patient.
    // Restore patients first with this one column null, then restore the link below.
    if (row.child === "patients" && row.parent === "patient_documents") continue;
    // Completed plan items link back to visits that themselves depend on plans/items.
    if (row.child === "plan_items" && row.parent === "visits") continue;
    // A family may name a patient as guarantor while the patient belongs to that family.
    // Insert the family without the guarantor, then restore that link after all patients.
    if (row.child === "patient_families" && row.parent === "patients") continue;
    dependsOn.get(row.child)?.add(row.parent);
  }
  // Restore historical receipts before their allocation document. Otherwise
  // the refund-follow trigger would generate events already present in backup.
  if(dependsOn.has("invoice_settlement_reclassifications"))
    dependsOn.get("invoice_settlement_reclassifications")!.add("payments");
  //0060 seals a complete clinical snapshot on revision INSERT. These trigger
  // dependencies are additional to declared foreign keys and must survive restore.
  if(dependsOn.has("legacy_treatment_document_revisions")) {
    dependsOn.get("legacy_treatment_document_revisions")!.add("legacy_treatment_agreements");
    dependsOn.get("legacy_treatment_document_revisions")!.add("legacy_treatment_coverage_snapshots");
  }
  if(dependsOn.has("debt_repayment_arrangements"))
    dependsOn.get("debt_repayment_arrangements")!.add("patient_opening_balance_history");
  for (const dependency of ["plan_items", "plan_installments", "invoice_items", "patient_opening_balances"])
    dependsOn.get("approved_agreement_principals")?.add(dependency);
  const ordered = insertionOrder(
    tables.map((table) => ({ table, dependsOn: [...(dependsOn.get(table) ?? [])] })),
  );

  yield `-- نسخة احتياطية — انسياب العيادة\n`;
  yield `-- أُخذت: ${new Date().toISOString()}\n`;
  yield `-- الاستعادة: على قاعدة فارغة فتحها البرنامج مرة واحدة فأنشأ جداولها.\n`;
  yield `BEGIN;\n`;

  // العدّادات تُعاد فقط لجداول لها عمود `id`. الجداول ذات المفتاح الطبيعي —
  // الإعدادات بمفتاحها النصّي، والأرصدة الافتتاحية برقم المريض — لا عدّاد لها،
  // وتوليد جملة تشير إلى `id` فيها يُفشل ملف النسخة كله عند أول سطر استعادة.
  const withSerialId: string[] = [];
  const patientPhotoLinks: { patientId: number; documentId: number }[] = [];
  const familyGuarantorLinks: { familyId: number; patientId: number }[] = [];
  const planVisitLinks: { itemId: number; visitId: number }[] = [];

  for (const table of ordered) {
    const { rows: columnRows } = (await pool.query(
      `SELECT column_name, data_type, column_default, is_identity FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1
        ORDER BY ordinal_position`,
      [table],
    )) as { rows: { column_name: string; data_type: string; column_default: string | null; is_identity: string }[] };
    const columns = columnRows.map((row) => row.column_name);
    if (columns.length === 0) continue;
    /* (P1.14) التسلسل واعٍ بأنواع الأعمدة: jsonb يُكتب JSON، وARRAY literal
       مصفوفة — القيمة وحدها لا تكفي للتمييز (pg يفكّ الاثنين إلى قيم JS).
       والعدّاد يُعاد فقط لعمود id عدديّ فعلي بnextval — مفتاح TEXT وإن اسمه id
       (ai_providers) كان يُفشل COALESCE بنوعين لا يجتمعان. */
    const columnType = new Map(columnRows.map((row) => [row.column_name, row.data_type]));
    const idColumn = columnRows.find((row) => row.column_name === "id");
    if (idColumn
        && ["smallint", "integer", "bigint"].includes(idColumn.data_type)
        && ((idColumn.column_default ?? "").startsWith("nextval") || idColumn.is_identity === "YES")) {
      withSerialId.push(table);
    }

    const identityInsert = columnRows.some(row => row.is_identity === "YES");
    // Immutable revisions must restore in stream order, never physical heap order.
    const restoreOrder = table === "debt_repayment_revisions" ? " ORDER BY arrangement_id, version"
      : table === "legacy_treatment_document_revisions" ? " ORDER BY document_id, version"
      : table === "hr_effective_revisions" ? " ORDER BY stream_id, revision" : "";
    const { rows } = await pool.query(`SELECT ${backupSelectColumns(columnRows)} FROM "${table}"${restoreOrder}`);
    yield `\n-- ${table} (${rows.length})\n`;
    for (const row of rows) {
      if (table === "plan_items" && typeof row.id === "number" && typeof row.visit_id === "number") {
        planVisitLinks.push({itemId:row.id,visitId:row.visit_id});
        yield `${insertStatement(table, columns, {...row,visit_id:null}, columnType, identityInsert)}\n`;
      } else if (table === "patient_families" && typeof row.id === "number" && typeof row.guarantor_patient_id === "number") {
        familyGuarantorLinks.push({ familyId: row.id, patientId: row.guarantor_patient_id });
        yield `${insertStatement(table, columns, { ...row, guarantor_patient_id: null }, columnType, identityInsert)}\n`;
      } else if (table === "patients" && typeof row.id === "number" && typeof row.photo_document_id === "number") {
        patientPhotoLinks.push({ patientId: row.id, documentId: row.photo_document_id });
        yield `${insertStatement(table, columns, { ...row, photo_document_id: null }, columnType, identityInsert)}\n`;
      } else {
        yield `${insertStatement(table, columns, row, columnType, identityInsert)}\n`;
      }
    }
  }

  yield `\n`;
  for (const link of planVisitLinks) yield `UPDATE plan_items SET visit_id = ${link.visitId} WHERE id = ${link.itemId};\n`;
  for (const link of patientPhotoLinks) {
    yield `UPDATE patients SET photo_document_id = ${link.documentId} WHERE id = ${link.patientId};\n`;
  }
  for (const link of familyGuarantorLinks) {
    yield `UPDATE patient_families SET guarantor_patient_id = ${link.patientId} WHERE id = ${link.familyId};\n`;
  }
  for (const reset of sequenceResets(withSerialId)) yield `${reset}\n`;
  yield `COMMIT;\n`;
}
