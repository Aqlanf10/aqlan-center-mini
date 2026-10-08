import { createHash } from "node:crypto";

export interface CollectionsNativeEvidenceMember {
  filename: string;
  mime: "image/png" | "application/pdf";
  bytes: Buffer;
}

const FILES = [
  "collections-native-screen.png",
  "collections-native-print.png",
  "collections-native.pdf",
  "collections-native-filtered-screen.png",
  "collections-native-filtered-print.png",
  "collections-native-filtered.pdf",
  "collections-native-mobile.png",
] as const;
const PREFIX = "SYNTHETIC_COLLECTIONS_NATIVE_EVIDENCE_V1";
const CHUNK_CHARACTERS = 4096;
const MAX_TOTAL_BYTES = 9 * 1024 * 1024;

/** Exact synthetic browser buffers, validated together before emitting any frame.
 * No filesystem reads, globbing, cookies, exports, network or CI workflow changes.
 * Call only after all content, no-write and browser-teardown assertions succeed.
 */
export function emitCollectionsNativeEvidence(members: readonly CollectionsNativeEvidenceMember[]): void {
  if (members.length !== FILES.length) throw new Error("Synthetic collections evidence requires exactly seven allowlisted files");
  const byName = new Map<string, CollectionsNativeEvidenceMember>();
  let totalBytes = 0;
  for (const member of members) {
    if (!FILES.some(filename => filename === member.filename) || byName.has(member.filename)) {
      throw new Error("Synthetic collections evidence has an unknown or duplicate filename");
    }
    const pdf = member.filename.endsWith(".pdf");
    const expectedMime = pdf ? "application/pdf" : "image/png";
    if (member.mime !== expectedMime || !Buffer.isBuffer(member.bytes) || member.bytes.length === 0
      || member.bytes.length > (pdf ? 2 : 1) * 1024 * 1024) {
      throw new Error(`Synthetic collections evidence MIME/byte limit rejected: ${member.filename}`);
    }
    if (pdf ? member.bytes.subarray(0, 5).toString("ascii") !== "%PDF-"
      || !member.bytes.subarray(-1024).toString("ascii").includes("%%EOF")
      : member.bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
      throw new Error(`Synthetic collections evidence signature rejected: ${member.filename}`);
    }
    totalBytes += member.bytes.length;
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error("Synthetic collections evidence exceeds the 9 MiB aggregate limit");
    byName.set(member.filename, member);
  }
  // Provenance cannot expand a bounded frame or accidentally include arbitrary env text.
  const runId = /^\d{1,24}$/.test(process.env.GITHUB_RUN_ID ?? "") ? process.env.GITHUB_RUN_ID : "unavailable";
  const checkoutSha = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(process.env.GITHUB_SHA ?? "") ? process.env.GITHUB_SHA : "unavailable";
  const prepared = FILES.map(filename => {
    const member = byName.get(filename);
    if (!member) throw new Error(`Synthetic collections evidence missing: ${filename}`);
    const base64 = member.bytes.toString("base64");
    return { base64, metadata: {
      scope: "collections-native", file: filename, mime: member.mime, bytes: member.bytes.length,
      sha256: createHash("sha256").update(member.bytes).digest("hex"),
      chunks: Math.ceil(base64.length / CHUNK_CHARACTERS), runId, checkoutSha, synthetic: true,
    } };
  });
  for (const { base64, metadata } of prepared) {
    const identity = JSON.stringify(metadata);
    console.log(`${PREFIX} BEGIN ${identity}`);
    for (let index = 0; index < metadata.chunks; index++) {
      console.log(`${PREFIX} CHUNK ${metadata.file} ${index + 1}/${metadata.chunks} ${base64.slice(index * CHUNK_CHARACTERS, (index + 1) * CHUNK_CHARACTERS)}`);
    }
    console.log(`${PREFIX} END ${identity}`);
  }
}

/** Separately labelled layout controls, never positive financial evidence.
 * Exact browser-returned buffers only; emit after the full journey/teardown and
 * financial immutability checks. No workflow change or filesystem scan. */
export function emitCollectionsPaginationControls(members: readonly CollectionsNativeEvidenceMember[]): void {
  const files = ["collections-pagination-old-layout-control.pdf", "collections-pagination-multipage-layout-control.pdf"] as const;
  if (members.length !== files.length) throw new Error("Pagination controls require exactly two allowlisted PDFs");
  const byName = new Map<string, CollectionsNativeEvidenceMember>();
  for (const member of members) {
    if (!files.some(filename => filename === member.filename) || byName.has(member.filename)
      || member.mime !== "application/pdf" || !Buffer.isBuffer(member.bytes)
      || member.bytes.length === 0 || member.bytes.length > 2 * 1024 * 1024
      || !member.bytes.subarray(0, 5).equals(Buffer.from("%PDF-", "ascii"))
      || !member.bytes.subarray(-1024).includes(Buffer.from("%%EOF", "ascii"))) {
      throw new Error("Pagination control filename, MIME, size or signature rejected");
    }
    byName.set(member.filename, member);
  }
  const runId = /^\d{1,24}$/.test(process.env.GITHUB_RUN_ID ?? "") ? process.env.GITHUB_RUN_ID : "unavailable";
  const checkoutSha = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(process.env.GITHUB_SHA ?? "") ? process.env.GITHUB_SHA : "unavailable";
  const prefix = "SYNTHETIC_COLLECTIONS_PAGINATION_CONTROL_V1";
  const prepared = files.map(filename => {
    const member = byName.get(filename)!;
    const base64 = member.bytes.toString("base64");
    return { base64, metadata: {
      scope: "collections-pagination-controls", file: filename, mime: "application/pdf", bytes: member.bytes.length,
      sha256: createHash("sha256").update(member.bytes).digest("hex"), chunks: Math.ceil(base64.length / CHUNK_CHARACTERS),
      runId, checkoutSha, synthetic: true, acceptance: false, layoutOnly: true,
      control: filename === files[0] ? "old-layout-negative" : "tall-row-multipage",
    } };
  });
  for (const { base64, metadata } of prepared) {
    const identity = JSON.stringify(metadata);
    console.log(`${prefix} BEGIN ${identity}`);
    for (let index = 0; index < metadata.chunks; index++) {
      console.log(`${prefix} CHUNK ${metadata.file} ${index + 1}/${metadata.chunks} ${base64.slice(index * CHUNK_CHARACTERS, (index + 1) * CHUNK_CHARACTERS)}`);
    }
    console.log(`${prefix} END ${identity}`);
  }
}

// Failure diagnostics are a separate protocol. They are never members of FILES
// and never evidence that the browser witness passed its acceptance assertions.
export const COLLECTIONS_NATIVE_COLUMN_KEYS = [
  "date", "patientName", "patientNumber", "kindLabel", "nativeMinor", "targetLabel",
  "settlementText", "methodLabel", "receiver", "note",
] as const;
export interface CollectionsNativeCellGeometry {
  left: number; right: number; top: number; bottom: number; width: number; height: number;
  clientWidth: number; scrollWidth: number; textWidth: number; textHeight: number;
}
export interface CollectionsNativeLayoutMetrics {
  scene: "all-desktop" | "filtered-desktop";
  rowCount: number;
  totalsCount: number;
  bounds: { tableLeft: number; tableRight: number; frameLeft: number; frameRight: number;
    clientWidth: number; scrollWidth: number; viewportWidth: number };
  columns: { key: typeof COLLECTIONS_NATIVE_COLUMN_KEYS[number]; header: CollectionsNativeCellGeometry;
    body: CollectionsNativeCellGeometry[]; footer: CollectionsNativeCellGeometry;
    totals: CollectionsNativeCellGeometry[] }[];
}
export interface CollectionsNativeFailureImage {
  filename: "collections-native-desktop-failed.png";
  mime: "image/png";
  bytes: Buffer;
}
const FAILURE_PREFIX = "SYNTHETIC_COLLECTIONS_NATIVE_FAILURE_V1";
const METRICS_PREFIX = "SYNTHETIC_COLLECTIONS_NATIVE_PRE_GATE_GEOMETRY_V1";
const MAX_METRICS_BYTES = 64 * 1024;
const CELL_KEYS = ["left", "right", "top", "bottom", "width", "height", "clientWidth", "scrollWidth", "textWidth", "textHeight"];
const BOUNDS_KEYS = ["tableLeft", "tableRight", "frameLeft", "frameRight", "clientWidth", "scrollWidth", "viewportWidth"];

function diagnosticRecord(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Object.getOwnPropertySymbols(value).length !== 0
    || Object.keys(value).sort().join("|") !== [...keys].sort().join("|")) {
    throw new Error("Synthetic collections diagnostic has invalid metric keys");
  }
}

function diagnosticArray(value: unknown, length: number): asserts value is unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length !== length
    || Object.getOwnPropertySymbols(value).length !== 0
    || Object.keys(value).join("|") !== Array.from({ length }, (_, index) => String(index)).join("|")) {
    throw new Error("Synthetic collections diagnostic has invalid cell array structure");
  }
}

function diagnosticNumbers(value: unknown, keys: readonly string[]) {
  diagnosticRecord(value, keys);
  for (const key of keys) {
    const entry = value[key];
    if (typeof entry !== "number" || !Number.isFinite(entry) || Math.abs(entry) > 16384
      || (/Width$|Height$|^width$|^height$/.test(key) && entry < 0)) {
      throw new Error("Synthetic collections diagnostic has invalid metric numbers");
    }
  }
}

function diagnosticCell(value: unknown) {
  diagnosticNumbers(value, CELL_KEYS);
  const cell = value as CollectionsNativeCellGeometry;
  if (cell.right < cell.left || cell.bottom < cell.top
    || Math.abs(cell.right - cell.left - cell.width) > 0.03
    || Math.abs(cell.bottom - cell.top - cell.height) > 0.03) {
    throw new Error("Synthetic collections diagnostic has inconsistent cell bounds");
  }
}

function validatedDiagnosticMetrics(input: CollectionsNativeLayoutMetrics): string {
  diagnosticRecord(input, ["scene", "rowCount", "totalsCount", "bounds", "columns"]);
  const count = input.scene === "all-desktop" ? 7 : input.scene === "filtered-desktop" ? 4 : 0;
  const totals = input.scene === "all-desktop" ? 3 : 1;
  if (!count || input.rowCount !== count || input.totalsCount !== totals) {
    throw new Error("Synthetic collections diagnostic has invalid scene or fixture counts");
  }
  diagnosticArray(input.columns, COLLECTIONS_NATIVE_COLUMN_KEYS.length);
  diagnosticNumbers(input.bounds, BOUNDS_KEYS);
  if (input.bounds.viewportWidth !== 1920) throw new Error("Synthetic collections diagnostic has an unexpected viewport");
  for (const [index, column] of input.columns.entries()) {
    diagnosticRecord(column, ["key", "header", "body", "footer", "totals"]);
    if (column.key !== COLLECTIONS_NATIVE_COLUMN_KEYS[index]) {
      throw new Error("Synthetic collections diagnostic has invalid column or cell counts");
    }
    diagnosticArray(column.body, count);
    diagnosticArray(column.totals, column.key === "nativeMinor" ? totals : 0);
    diagnosticCell(column.header);
    diagnosticCell(column.footer);
    column.body.forEach(diagnosticCell);
    column.totals.forEach(diagnosticCell);
  }
  const text = JSON.stringify(input);
  if (Buffer.byteLength(text, "utf8") > MAX_METRICS_BYTES) {
    throw new Error("Synthetic collections diagnostic exceeds the metrics byte limit");
  }
  return text;
}

function diagnosticProvenance() {
  return {
    runId: /^\d{1,24}$/.test(process.env.GITHUB_RUN_ID ?? "") ? process.env.GITHUB_RUN_ID : "unavailable",
    checkoutSha: /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(process.env.GITHUB_SHA ?? "") ? process.env.GITHUB_SHA : "unavailable",
  };
}

/** Bounded numeric-only geometry after synthetic content checks, before the gate. */
export function emitCollectionsNativePreGateGeometry(metrics: CollectionsNativeLayoutMetrics): void {
  const text = validatedDiagnosticMetrics(metrics);
  console.log(`${METRICS_PREFIX} ${JSON.stringify({ scope: "collections-native", synthetic: true,
    acceptance: false, ...diagnosticProvenance(), metrics: JSON.parse(text) })}`);
}

/** Only the actual pre-gate screenshot, only when an unchanged bounds gate fails.
 * Validate both inputs before any diagnostic frame. This protocol has one exact
 * filename, a 1 MiB PNG cap and no filesystem/network access or error text.
 */
export function emitCollectionsNativeFailure(image: CollectionsNativeFailureImage, metrics: CollectionsNativeLayoutMetrics): void {
  const metricText = validatedDiagnosticMetrics(metrics);
  diagnosticRecord(image, ["filename", "mime", "bytes"]);
  if (image.filename !== "collections-native-desktop-failed.png" || image.mime !== "image/png"
    || !Buffer.isBuffer(image.bytes) || image.bytes.length === 0 || image.bytes.length > 1024 * 1024
    || image.bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
    throw new Error("Synthetic collections diagnostic has an invalid image");
  }
  const base64 = image.bytes.toString("base64");
  const metadata = { scope: "collections-native", status: "failed-desktop-bounds", acceptance: false,
    synthetic: true, scene: metrics.scene, file: image.filename, mime: image.mime, bytes: image.bytes.length,
    sha256: createHash("sha256").update(image.bytes).digest("hex"),
    chunks: Math.ceil(base64.length / CHUNK_CHARACTERS), ...diagnosticProvenance(),
    metricsBytes: Buffer.byteLength(metricText, "utf8"),
    metricsSha256: createHash("sha256").update(metricText).digest("hex") };
  const identity = JSON.stringify(metadata);
  console.log(`${FAILURE_PREFIX} BEGIN ${identity}`);
  console.log(`${FAILURE_PREFIX} METRICS ${metricText}`);
  for (let index = 0; index < metadata.chunks; index++) {
    console.log(`${FAILURE_PREFIX} CHUNK ${metadata.file} ${index + 1}/${metadata.chunks} ${base64.slice(index * CHUNK_CHARACTERS, (index + 1) * CHUNK_CHARACTERS)}`);
  }
  console.log(`${FAILURE_PREFIX} END ${identity}`);
}
