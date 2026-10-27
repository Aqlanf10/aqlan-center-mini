// Real TypeScript child execution, not a mocked success result.
import { existsSync } from "node:fs";
enum SyntheticStatus { Passed = 0 }
if (!existsSync("package.json")) throw new Error("Journey cwd was not preserved");
console.log("Synthetic TypeScript journey passed");
process.exit(SyntheticStatus.Passed);
