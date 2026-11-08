import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { expect, it } from "vitest";
import type { StudyTextPresentation } from "../lib/ortho-study-text-export";

it("creates missing output parents and can rerun without removing existing evidence", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "study-pptx-local-test-"));
  const output = join(cwd, "docs/ortho/evidence/saved-study-20261105");
  const require = createRequire(import.meta.url);
  const run = () => execFileSync(process.execPath, [
    "--import", require.resolve("tsx"),
    fileURLToPath(new URL("../scripts/verify-study-pptx-local.ts", import.meta.url)),
  ], {
    cwd, timeout: 30_000, stdio: "pipe",
    env: { ...process.env, TSX_TSCONFIG_PATH: fileURLToPath(new URL("../tsconfig.json", import.meta.url)) },
  });
  try {
    expect(existsSync(output)).toBe(false);
    run();
    const json = readFileSync(join(output, "synthetic-presentation.json"), "utf8");
    const presentation = JSON.parse(json) as StudyTextPresentation;
    expect(presentation.caseId).toBe(900002);
    expect(presentation.revisionId).toBe(900004);
    expect(presentation.pages.length).toBeGreaterThan(0);
    expect(json).toContain("حالة اصطناعية للتحقق فقط");
    const zip = await JSZip.loadAsync(readFileSync(join(output, "synthetic-text.pptx")), { checkCRC32: true });
    expect(zip.file("[Content_Types].xml")).not.toBeNull();
    expect(zip.file("ppt/presentation.xml")).not.toBeNull();
    expect(Object.keys(zip.files).filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name))).toHaveLength(presentation.pages.length);
    writeFileSync(join(output, "keep.txt"), "existing evidence");
    run();
    expect(readFileSync(join(output, "keep.txt"), "utf8")).toBe("existing evidence");
    expect(readFileSync(join(output, "synthetic-presentation.json"), "utf8")).toBe(json);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}, 60_000);
