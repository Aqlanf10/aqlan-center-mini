import { captureFocusedRollbackReport } from './capture-focused-rollback-report';

captureFocusedRollbackReport(process.env).catch(() => {
  process.stderr.write('SYNTHETIC_REPORT_CAPTURE_FAILED\n');
  process.exitCode = 1;
});
