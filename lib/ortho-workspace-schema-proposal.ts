import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { DbClient, DbPool } from "./db";

/**
 * Installs proposal 0140 (`ortho_clinical_workspaces`, `ortho_clinical_workspace_revisions`,
 * `patient_documents.parent_document_id`) in isolated test / staging rehearsal databases.
 * Never invoked implicitly inside production HTTP routes (Charter §23).
 */
export async function installOrthoWorkspaceSchemaProposal(runner: Pick<DbPool | DbClient, "query">): Promise<void> {
  const sqlPath = resolve(process.cwd(), "migrations/proposals/0140_ortho_clinical_workspaces.sql");
  const sql = await readFile(sqlPath, "utf8");
  await runner.query(sql);
}
