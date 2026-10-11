import { lstat, open } from "node:fs/promises";
import { pathToFileURL } from "node:url";

// Exact synthetic fixture outputs only. Never upload markers, traces, HAR or storage.
export const linkageEvidence = [
  {
    marker: "artifacts/unified-linkage/started.txt",
    files: [
      "artifacts/unified-linkage/closed-case-diagnostics-390.png",
      "artifacts/unified-linkage/closed-case-diagnostics-1280.png",
      "artifacts/unified-linkage/invalid-context-390.png",
      "artifacts/unified-linkage/invalid-context-1280.png",
    ],
  },
  {
    marker: "artifacts/invoice-explicit-selection/started.txt",
    files: [
      "artifacts/invoice-explicit-selection/fresh-plan-390.png",
      "artifacts/invoice-explicit-selection/fresh-plan-1280.png",
      "artifacts/invoice-explicit-selection/exact-item-390.png",
      "artifacts/invoice-explicit-selection/exact-item-1280.png",
    ],
  },
  {
    marker: "artifacts/operational-checkout/started.txt",
    files: [
      "artifacts/operational-checkout/operational-checkout-ready-390.png",
      "artifacts/operational-checkout/operational-checkout-ready-1280.png",
    ],
  },
];

export function missingLinkageEvidence(outcome, present) {
  const missing = [];
  for (const suite of linkageEvidence) {
    // Successful full HTTP run may not silently omit any suite. Before a suite
    // starts, an earlier job failure must not manufacture a missing-PNG failure.
    const required = outcome === "success" || present.has(suite.marker);
    if (!required) continue;
    for (const path of [suite.marker, ...suite.files]) if (!present.has(path)) missing.push(path);
  }
  return missing;
}

export async function verifyLinkageEvidence(outcome) {
  const present = new Set();
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  for (const path of linkageEvidence.flatMap((suite) => [suite.marker, ...suite.files])) {
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.size === 0) continue;
      if (path.endsWith(".png")) {
        const file = await open(path, "r");
        try {
          const header = Buffer.alloc(8);
          const { bytesRead } = await file.read(header, 0, 8, 0);
          if (bytesRead !== 8 || !header.equals(signature)) continue;
        } finally { await file.close(); }
      }
      present.add(path);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  const missing = missingLinkageEvidence(outcome, present);
  if (missing.length) throw new Error(`Missing required synthetic linkage evidence: ${missing.join(", ")}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await verifyLinkageEvidence(process.env.LINKAGE_HTTP_OUTCOME ?? "");
}
