import { describe, expect, it } from "vitest";
import { decodeEvidence, evidenceRecords, type EvidenceFile } from "./security-http/_synthetic-evidence-log";

const png = (size: number) => Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(size, 7)]);
const pdf = (size: number) => Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(size, 1)]);
const identity = { runId: "1", runAttempt: "1", ref: "refs/pull/1/merge", githubSha: "a", checkoutSha: "b", checkoutParents: ["c", "d"] };
const expected = new Map<string, EvidenceFile["mime"]>([["a.png", "image/png"], ["b.pdf", "application/pdf"]]);
const files: EvidenceFile[] = [{ filename: "a.png", mime: "image/png", bytes: png(9000) }, { filename: "b.pdf", mime: "application/pdf", bytes: pdf(20) }];

describe("synthetic evidence log transport", () => {
  it("round-trips a complete set with its run/checkout identity and acceptance flag", () => {
    const decoded = decodeEvidence(evidenceRecords({ scope: "unit-scope", expected, files, aggregateCap: 1 << 20 }, identity));
    expect([...decoded.keys()]).toEqual(["a.png", "b.pdf"]);
    expect(decoded.get("a.png")!.bytes.equals(files[0].bytes)).toBe(true);
    expect(decoded.get("b.pdf")!.meta).toMatchObject({ scope: "unit-scope", acceptance: true, synthetic: true, ...identity });
  });

  it("refuses an incomplete, duplicate, unexpected, oversized or malformed set before writing anything", () => {
    const set = (over: Partial<Parameters<typeof evidenceRecords>[0]>) => () => evidenceRecords({ scope: "unit-scope", expected, files, aggregateCap: 1 << 20, ...over }, identity);
    expect(set({ files: [files[0]] })).toThrow("Incomplete or duplicate");
    expect(set({ files: [files[0], files[0]] })).toThrow("Incomplete or duplicate");
    expect(set({ files: [files[0], { ...files[1], filename: "c.pdf" }] })).toThrow("Unexpected evidence member");
    expect(set({ files: [files[0], { ...files[1], bytes: Buffer.from("not a pdf") }] })).toThrow("signature");
    expect(set({ files: [{ ...files[0], bytes: png(1024 * 1024) }, files[1]] })).toThrow("exceeds bound");
    expect(set({ aggregateCap: 100 })).toThrow("aggregate");
    expect(set({ scope: "Bad Scope" })).toThrow("scope");
  });

  it("detects a missing or altered chunk on decode", () => {
    const records = evidenceRecords({ scope: "unit-scope", expected, files, aggregateCap: 1 << 20 }, identity);
    expect(() => decodeEvidence(records.filter((_, index) => index !== 2))).toThrow();
    const altered = records.map((line, index) => index === 1 ? line.replace(/.$/, (c) => c === "A" ? "B" : "A") : line);
    expect(() => decodeEvidence(altered)).toThrow("checksum");
  });
});
