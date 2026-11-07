import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { loadMigrationFiles } from "../lib/migration-files";
import reviewed from "./fixtures/reviewed-migration-manifest.json";

it("keeps the reviewed 86-file composed migration ledger byte-exact", async () => {
  const files = await loadMigrationFiles();
  expect(files.map(({ version, name, filename, checksum }) => ({ version, name, filename, checksum }))).toEqual(reviewed);
  for (const file of files) {
    expect(createHash("sha256").update(file.sql).digest("hex"), file.filename)
      .toBe(reviewed.find(entry => entry.version === file.version)!.checksum);
  }
});
