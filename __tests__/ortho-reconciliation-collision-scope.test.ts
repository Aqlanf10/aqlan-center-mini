import type { Client } from "pg";
import { expect, it, vi } from "vitest";
import { readOrthoCatalog, type OrthoVersion } from "../lib/ortho-reconciliation-catalog";
import { guardOrthoRevisionMigration } from "../lib/ortho-revision-migration-guard";
import contracts from "../lib/ortho-assessment-runtime.generated.json";

it.each(contracts)("report covers exactly the guard's collision-name set for $version", async contract => {
  const query = vi.fn().mockResolvedValue({ rows: [] });
  await readOrthoCatalog({ query } as unknown as Client, contract.version as OrthoVersion);
  const reportNames = query.mock.calls[0][1][0]; query.mockClear();
  await guardOrthoRevisionMigration({ query, release() {} }, contract);
  expect(new Set(reportNames)).toEqual(new Set(query.mock.calls[0][1][0]));
});
