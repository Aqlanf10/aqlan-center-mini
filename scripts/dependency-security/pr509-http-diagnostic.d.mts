/** Public type boundary for the bounded, exact-target diagnostic collector. */
export const TARGET: '__tests__/security-http/radiology-request-journey.test.ts';
export const MAX_REPORT_BYTES: 33554432;
export interface DiagnosticLocation {
  file: typeof TARGET;
  line: number;
  column: number;
}
export interface DiagnosticAssertionFailure {
  category: 'AssertionError' | 'TimeoutError' | 'Error' | 'Unknown';
  locations: DiagnosticLocation[];
  expected?: number | boolean;
  actual?: number | boolean;
}
export interface DiagnosticSuiteFailure {
  category: 'SuiteError';
  locations: [];
}
export interface ValidDiagnostic {
  schemaVersion: 1;
  status: 'valid';
  file: typeof TARGET;
  failedCount: number;
  omittedFailures: number;
  failures: Array<DiagnosticAssertionFailure | DiagnosticSuiteFailure>;
}
export interface UnavailableDiagnostic {
  schemaVersion: 1;
  status: 'unavailable-or-invalid';
}
/** Throws on untrusted report shape, source identity or bounds violations. */
export function sanitizeDiagnostic(report: unknown, root: string): ValidDiagnostic;
/** Always attempts raw-file cleanup; unavailable results contain no raw context. */
export function collectDiagnostic(rawFile: string, root: string):
  | { code: 0; result: ValidDiagnostic }
  | { code: 1; result: UnavailableDiagnostic };
