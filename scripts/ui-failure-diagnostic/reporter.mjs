import { appendFileSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { resolve, relative } from "node:path";

// Diagnostic-only reporter. No browser storage, headers, bodies or server logs.
// Each result is persisted synchronously before another test can hide its error.
export default class ImmediateFailureReporter {
  constructor() {
    this.root = process.cwd();
    this.output = resolve(process.env.UI_DIAGNOSTIC_OUTPUT);
    this.provenance = JSON.parse(readFileSync(resolve(this.output, "provenance.json"), "utf8"));
    this.results = [];
    this.sequence = 0;
  }
  text(value, limit = 12000) {
    const raw = String(value ?? "");
    const redacted = raw
      .replace(/(?:postgres(?:ql)?|https?):\/\/[^\s/@]+:[^\s/@]+@[^\s]+/gi, "[credential-url-redacted]")
      .replace(/(authorization|cookie|set-cookie|password|session_secret)\s*[:=][^\r\n]*/gi, "$1=[redacted]")
      .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[token-redacted]");
    return { text: redacted.slice(0, limit), truncated: redacted.length > limit };
  }
  errors(values = []) {
    return values.slice(0, 4).map(error => ({ name: this.text(error.name, 200),
      message: this.text(error.message), stack: this.text(error.stack), frame: this.text(error.frame) }));
  }
  emit(kind, data) {
    if (++this.sequence > 512) throw new Error("Diagnostic event bound exceeded");
    const line = JSON.stringify({ protocol: "AQLAN_UI_FAILURE_DIAGNOSTIC_V1", acceptance: false,
      sequence: this.sequence, at: new Date().toISOString(), runId: this.provenance.runId,
      attempt: this.provenance.attempt, sourceCommit: this.provenance.sourceCommit,
      sourceTree: this.provenance.sourceTree, mode: this.provenance.mode, group: this.provenance.group, kind, ...data }) + "\n";
    if (Buffer.byteLength(line) > 210000) throw new Error("Diagnostic line bound exceeded");
    appendFileSync(resolve(this.output, "events.jsonl"), line);
    writeSync(1, line);
  }
  onTestCaseReady(test) {
    this.emit("test-start", { file: relative(this.root, test.module.moduleId), name: this.text(test.fullName, 2000) });
  }
  onTestCaseResult(test) {
    const result = test.result();
    const row = { file: relative(this.root, test.module.moduleId), name: this.text(test.fullName, 2000),
      state: result.state, duration: test.diagnostic()?.duration ?? null, errors: this.errors(result.errors) };
    this.results.push(row); this.emit("test-result", row);
  }
  onTestModuleEnd(module) {
    this.emit("module-end", { file: relative(this.root, module.moduleId), errors: this.errors(module.errors()) });
  }
  onTestRunEnd(modules, errors, reason) {
    const end = { reason, moduleCount: modules.length, unhandledErrors: this.errors(errors), results: this.results };
    writeFileSync(resolve(this.output, "results.json"), JSON.stringify(end, null, 2) + "\n");
    this.emit("run-end", { reason, moduleCount: modules.length, unhandledErrors: end.unhandledErrors,
      passed: this.results.filter(row => row.state === "passed").length,
      failed: this.results.filter(row => row.state === "failed").length,
      skipped: this.results.filter(row => row.state === "skipped").length });
  }
}
