import { totalmem } from "node:os";
import { getHeapStatistics } from "node:v8";
import { fileURLToPath } from "node:url";

export const TYPECHECK_HEAP_MIB = 4096;
const MIB = 1024 * 1024;

/** Reserve native/compiler/process memory; never hide a small runner behind a larger V8 limit. */
export function inspectTypecheckMemory({ totalBytes, constrainedBytes, availableBytes, heapLimitBytes }) {
  if (![totalBytes, availableBytes, heapLimitBytes].every(value => Number.isFinite(value) && value > 0)
    || constrainedBytes !== undefined && (!Number.isFinite(constrainedBytes) || constrainedBytes < 0)) {
    throw new Error("TYPECHECK_MEMORY_METRICS_INVALID");
  }
  const capacityBytes = constrainedBytes > 0 ? Math.min(totalBytes, constrainedBytes) : totalBytes;
  const report = {
    capacityMiB: Math.floor(capacityBytes / MIB),
    availableMiB: Math.floor(Math.min(availableBytes, capacityBytes) / MIB),
    heapLimitMiB: Math.floor(heapLimitBytes / MIB),
    requestedHeapMiB: TYPECHECK_HEAP_MIB,
  };
  if (report.capacityMiB < TYPECHECK_HEAP_MIB + 2048 || report.availableMiB < TYPECHECK_HEAP_MIB + 1024) {
    throw Object.assign(new Error("TYPECHECK_RUNNER_MEMORY_INSUFFICIENT"), { report });
  }
  if (report.heapLimitMiB < TYPECHECK_HEAP_MIB || report.heapLimitMiB > TYPECHECK_HEAP_MIB + 512) {
    throw Object.assign(new Error("TYPECHECK_HEAP_CONFIGURATION_MISMATCH"), { report });
  }
  return report;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const report = inspectTypecheckMemory({
      totalBytes: totalmem(), constrainedBytes: process.constrainedMemory(),
      availableBytes: process.availableMemory(), heapLimitBytes: getHeapStatistics().heap_size_limit,
    });
    console.log(JSON.stringify({ gate: "full-typecheck-memory", ...report }));
  } catch (error) {
    console.error(JSON.stringify({ gate: "full-typecheck-memory", error: error.message, ...error.report }));
    process.exitCode = 1;
  }
}
