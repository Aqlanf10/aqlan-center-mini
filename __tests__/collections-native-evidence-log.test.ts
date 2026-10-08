import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { COLLECTIONS_NATIVE_COLUMN_KEYS, emitCollectionsNativeEvidence, emitCollectionsNativeFailure,
  emitCollectionsNativePreGateGeometry, type CollectionsNativeEvidenceMember,
  type CollectionsNativeFailureImage, type CollectionsNativeLayoutMetrics } from "./security-http/_collections-native-evidence";

const prefix = "SYNTHETIC_COLLECTIONS_NATIVE_EVIDENCE_V1";
const names = [
  "collections-native-screen.png", "collections-native-print.png", "collections-native.pdf",
  "collections-native-filtered-screen.png", "collections-native-filtered-print.png", "collections-native-filtered.pdf",
  "collections-native-mobile.png",
];
function fixtures(): CollectionsNativeEvidenceMember[] {
  return names.map(filename => {
    const pdf = filename.endsWith(".pdf");
    return { filename, mime: pdf ? "application/pdf" : "image/png", bytes: pdf
      ? Buffer.from("%PDF-1.7\n" + "synthetic-test".repeat(400) + "\n%%EOF\n")
      : Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(5000, 42)]) };
  });
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("bounded synthetic native-currency evidence transport", () => {
  it("frames seven exact buffers with ordered indexed chunks, hashes and bounded provenance", () => {
    vi.stubEnv("GITHUB_RUN_ID", "123456789");
    vi.stubEnv("GITHUB_SHA", "a".repeat(40));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const members = fixtures();
    emitCollectionsNativeEvidence([...members].reverse());
    const lines = log.mock.calls.map(call => String(call[0]));
    let cursor = 0;
    for (const member of members) {
      const begin = lines[cursor++];
      expect(begin.startsWith(`${prefix} BEGIN `)).toBe(true);
      const metadata = JSON.parse(begin.slice(`${prefix} BEGIN `.length));
      expect(metadata).toEqual({ scope: "collections-native", file: member.filename, mime: member.mime,
        bytes: member.bytes.length, sha256: createHash("sha256").update(member.bytes).digest("hex"),
        chunks: Math.ceil(member.bytes.toString("base64").length / 4096),
        runId: "123456789", checkoutSha: "a".repeat(40), synthetic: true });
      const chunks: string[] = [];
      for (let index = 1; index <= metadata.chunks; index++) {
        const marker = `${prefix} CHUNK ${member.filename} ${index}/${metadata.chunks} `;
        const line = lines[cursor++];
        expect(line.startsWith(marker)).toBe(true);
        const chunk = line.slice(marker.length);
        expect(chunk).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
        expect(chunk.length).toBeLessThanOrEqual(4096);
        chunks.push(chunk);
      }
      expect(Buffer.from(chunks.join(""), "base64")).toEqual(member.bytes);
      expect(lines[cursor++]).toBe(`${prefix} END ${JSON.stringify(metadata)}`);
    }
    expect(cursor).toBe(lines.length);
  });

  it.each(["missing", "duplicate", "unknown", "mime", "empty", "png-size", "pdf-size", "signature", "pdf-eof"])(
    "emits no partial evidence for %s rejection", fault => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const members = fixtures();
      if (fault === "missing") members.pop();
      if (fault === "duplicate") members[5] = members[2];
      if (fault === "unknown") members[5].filename = "unlisted-output.pdf";
      if (fault === "mime") members[5].mime = "image/png";
      if (fault === "empty") members[5].bytes = Buffer.alloc(0);
      if (fault === "png-size") members[4].bytes = Buffer.alloc(1024 * 1024 + 1);
      if (fault === "pdf-size") members[5].bytes = Buffer.alloc(2 * 1024 * 1024 + 1);
      if (fault === "signature") members[4].bytes = Buffer.from("not-a-png");
      if (fault === "pdf-eof") members[5].bytes = Buffer.from("%PDF-1.7\nmissing-final-marker");
      expect(() => emitCollectionsNativeEvidence(members)).toThrow(/Synthetic collections evidence/);
      expect(log).not.toHaveBeenCalled();
    },
  );

  it("never includes arbitrary environment text in provenance", () => {
    vi.stubEnv("GITHUB_RUN_ID", "untrusted\n".repeat(1000));
    vi.stubEnv("GITHUB_SHA", "secret-not-a-checkout");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    emitCollectionsNativeEvidence(fixtures());
    const first = String(log.mock.calls[0][0]);
    expect(first).toContain('"runId":"unavailable","checkoutSha":"unavailable"');
    expect(first.length).toBeLessThan(500);
    expect(first).not.toContain("secret");
    expect(first).not.toContain("untrusted");
  });
});

function layoutMetrics(scene: CollectionsNativeLayoutMetrics["scene"] = "all-desktop"): CollectionsNativeLayoutMetrics {
  const rowCount = scene === "all-desktop" ? 7 : 4, totalsCount = scene === "all-desktop" ? 3 : 1;
  const cell = () => ({ left: 0, right: 100, top: 0, bottom: 20, width: 100, height: 20,
    clientWidth: 100, scrollWidth: 100, textWidth: 80, textHeight: 16 });
  return { scene, rowCount, totalsCount,
    bounds: { tableLeft: 400, tableRight: 1526, frameLeft: 400, frameRight: 1518,
      clientWidth: 1118, scrollWidth: 1126, viewportWidth: 1920 },
    columns: COLLECTIONS_NATIVE_COLUMN_KEYS.map(key => ({ key, header: cell(), footer: cell(),
      body: Array.from({ length: rowCount }, cell), totals: Array.from({ length: key === "nativeMinor" ? totalsCount : 0 }, cell) })) };
}
function failureImage(): CollectionsNativeFailureImage {
  return { filename: "collections-native-desktop-failed.png", mime: "image/png",
    bytes: Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(5000, 37)]) };
}

describe("bounded pre-gate collections geometry and failure-only diagnostic", () => {
  it.each(["all-desktop", "filtered-desktop"] as const)("logs exact trusted numeric geometry for %s before acceptance", scene => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const metrics = layoutMetrics(scene);
    emitCollectionsNativePreGateGeometry(metrics);
    expect(log).toHaveBeenCalledTimes(1);
    const marker = "SYNTHETIC_COLLECTIONS_NATIVE_PRE_GATE_GEOMETRY_V1 ";
    const line = String(log.mock.calls[0][0]);
    expect(line.startsWith(marker)).toBe(true);
    const payload = JSON.parse(line.slice(marker.length));
    expect(payload).toMatchObject({ scope: "collections-native", synthetic: true, acceptance: false, metrics });
    expect(Buffer.byteLength(line, "utf8")).toBeLessThan(65 * 1024);
  });

  it("separates failed screenshot frames from acceptance and authenticates exact image and metrics bytes", () => {
    vi.stubEnv("GITHUB_RUN_ID", "12345");
    vi.stubEnv("GITHUB_SHA", "b".repeat(40));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const image = failureImage(), metrics = layoutMetrics();
    emitCollectionsNativeFailure(image, metrics);
    const lines = log.mock.calls.map(call => String(call[0]));
    const failurePrefix = "SYNTHETIC_COLLECTIONS_NATIVE_FAILURE_V1";
    const metadata = JSON.parse(lines[0].slice(`${failurePrefix} BEGIN `.length));
    expect(metadata).toEqual({ scope: "collections-native", status: "failed-desktop-bounds", acceptance: false,
      synthetic: true, scene: "all-desktop", file: image.filename, mime: "image/png", bytes: image.bytes.length,
      sha256: createHash("sha256").update(image.bytes).digest("hex"),
      chunks: Math.ceil(image.bytes.toString("base64").length / 4096), runId: "12345", checkoutSha: "b".repeat(40),
      metricsBytes: Buffer.byteLength(JSON.stringify(metrics), "utf8"),
      metricsSha256: createHash("sha256").update(JSON.stringify(metrics)).digest("hex") });
    expect(lines[1]).toBe(`${failurePrefix} METRICS ${JSON.stringify(metrics)}`);
    const chunks: string[] = [];
    for (let index = 1; index <= metadata.chunks; index++) {
      const marker = `${failurePrefix} CHUNK ${image.filename} ${index}/${metadata.chunks} `;
      expect(lines[index + 1].startsWith(marker)).toBe(true);
      const chunk = lines[index + 1].slice(marker.length);
      expect(chunk).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
      expect(chunk.length).toBeLessThanOrEqual(4096);
      chunks.push(chunk);
    }
    expect(Buffer.from(chunks.join(""), "base64")).toEqual(image.bytes);
    expect(lines.at(-1)).toBe(`${failurePrefix} END ${JSON.stringify(metadata)}`);
    expect(lines).toHaveLength(metadata.chunks + 3);
    expect(lines.some(line => line.startsWith(prefix))).toBe(false);
  });

  it.each(["scene", "rows", "totals", "unknown-key", "missing-column", "wrong-column", "missing-cell", "sparse-cells",
    "array-extra", "cell-extra", "nonfinite", "out-of-range", "negative-size", "inconsistent-bounds", "viewport", "native-lines"])(
    "rejects malformed %s metrics before any geometry or failure frame", fault => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const metrics = layoutMetrics();
      if (fault === "scene") Object.assign(metrics, { scene: "production" });
      if (fault === "rows") metrics.rowCount = 7000;
      if (fault === "totals") metrics.totalsCount = 2;
      if (fault === "unknown-key") Object.assign(metrics, { text: "not-allowed".repeat(10000) });
      if (fault === "missing-column") metrics.columns.pop();
      if (fault === "wrong-column") metrics.columns[0].key = "nativeMinor";
      if (fault === "missing-cell") metrics.columns[0].body.pop();
      if (fault === "sparse-cells") metrics.columns[0].body = new Array(7);
      if (fault === "array-extra") Object.assign(metrics.columns[0].body, { toJSON: () => "not-allowed" });
      if (fault === "cell-extra") Object.assign(metrics.columns[9].footer, { text: "not-allowed" });
      if (fault === "nonfinite") metrics.columns[9].footer.textWidth = Number.NaN;
      if (fault === "out-of-range") metrics.columns[9].footer.textWidth = 16385;
      if (fault === "negative-size") metrics.columns[9].footer.clientWidth = -1;
      if (fault === "inconsistent-bounds") metrics.columns[9].footer.width = 99;
      if (fault === "viewport") metrics.bounds.viewportWidth = 390;
      if (fault === "native-lines") metrics.columns[4].totals.pop();
      expect(() => emitCollectionsNativePreGateGeometry(metrics)).toThrow(/Synthetic collections diagnostic/);
      expect(() => emitCollectionsNativeFailure(failureImage(), metrics)).toThrow(/Synthetic collections diagnostic/);
      expect(log).not.toHaveBeenCalled();
    },
  );

  it.each(["name", "mime", "empty", "non-buffer", "oversize", "signature", "extra-key"])(
    "rejects an invalid %s image without partial diagnostic frames", fault => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const image = failureImage();
      if (fault === "name") Object.assign(image, { filename: "collections-native-screen.png" });
      if (fault === "mime") Object.assign(image, { mime: "application/pdf" });
      if (fault === "empty") image.bytes = Buffer.alloc(0);
      if (fault === "non-buffer") Object.assign(image, { bytes: new Uint8Array(20) });
      if (fault === "oversize") image.bytes = Buffer.alloc(1024 * 1024 + 1);
      if (fault === "signature") image.bytes = Buffer.from("not-a-png");
      if (fault === "extra-key") Object.assign(image, { url: "not-allowed" });
      expect(() => emitCollectionsNativeFailure(image, layoutMetrics())).toThrow(/Synthetic collections diagnostic/);
      expect(log).not.toHaveBeenCalled();
    },
  );

  it("accepts the exact 1 MiB image limit and sanitizes arbitrary provenance", () => {
    vi.stubEnv("GITHUB_RUN_ID", "untrusted\n".repeat(1000));
    vi.stubEnv("GITHUB_SHA", "not-a-checkout");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const image = failureImage();
    image.bytes = Buffer.alloc(1024 * 1024);
    Buffer.from("89504e470d0a1a0a", "hex").copy(image.bytes);
    emitCollectionsNativeFailure(image, layoutMetrics());
    const first = String(log.mock.calls[0][0]);
    expect(first).toContain('"bytes":1048576');
    expect(first).toContain('"runId":"unavailable","checkoutSha":"unavailable"');
    expect(first).not.toContain("untrusted");
    expect(first).not.toContain("not-a-checkout");
  });

  it("cannot substitute a failure screenshot into the seven-file positive contract", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const success = fixtures();
    success[0] = failureImage();
    expect(() => emitCollectionsNativeEvidence(success)).toThrow(/unknown or duplicate filename/);
    expect(log).not.toHaveBeenCalled();
  });
});
