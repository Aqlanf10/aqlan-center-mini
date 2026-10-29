import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(join(__dirname, "../.github/workflows/ci.yml"), "utf8");
const completionJob = workflow.match(/^ {2}required_completion:\n(?:(?!^ {2}\S)[\s\S])*/m)?.[0];

// Execute the workflow's actual shell body, not a second implementation of its
// condition. Deliberately reject layout drift rather than testing an empty or
// partial script if the job changes its shape.
function completionShell(): string {
  expect(completionJob, "required_completion job must exist").toBeDefined();
  const blocks = [...completionJob!.matchAll(/^ {8}run: \|\n((?: {10}[^\n]*(?:\n|$))+)/gm)];
  expect(blocks, "required_completion must have exactly one literal run body").toHaveLength(1);
  expect(completionJob!.trimEnd().endsWith(blocks[0][0].trimEnd()),
    "the extracted block must include the entire final shell body").toBe(true);
  const shell = blocks[0][1].replace(/^ {10}/gm, "");
  expect(shell.trim()).not.toBe("");
  return shell;
}

const results = ["success", "failure", "skipped", "cancelled"] as const;
const combinations = results.flatMap(quality =>
  results.flatMap(postgres => results.flatMap(http => results.map(print => ({ quality, postgres, http, print })))),
);

describe("required CI completion executes fail-closed shell", () => {
  it.each(combinations)(
    "quality=$quality postgres=$postgres http=$http print=$print",
    ({ quality, postgres, http, print }) => {
      const result = spawnSync("bash", ["--noprofile", "--norc", "-e", "-c", completionShell()], {
        encoding: "utf8",
        timeout: 5_000,
        env: {
          NODE_ENV: "test",
          PATH: process.env.PATH,
          QUALITY_RESULT: quality,
          POSTGRES_RESULT: postgres,
          HTTP_RESULT: http,
          PRINT_RESULT: print,
        },
      });
      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      const success = quality === "success" && postgres === "success" && http === "success" && print === "success";
      expect(result.status, result.stderr).toBe(success ? 0 : 1);
      if (success) {
        expect(result.stdout).toBe("");
      } else {
        expect(result.stdout).toContain(
          `::error::Required CI incomplete: quality=${quality}, postgres_integration=${postgres}, security_http=${http}, contract_print_visual=${print}`,
        );
      }
    },
  );
});
