import { defineConfig } from 'vitest/config';
import base from './vitest.config.postgres.mts';

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ['__tests__/postgres/hr-composed-legacy-restore.test.ts', '__tests__/postgres/inventory-authority-maintenance.test.ts'],
    globalSetup: ['__tests__/postgres/_history-witness-setup.ts'],
    // Run the restore cases only; later inventory reset cases deliberately
    // create and remove database objects and are outside this retained witness.
    testNamePattern: /restores the actual pre-HR archive|refuses a truncated archive|rolls back every restored data row|pre-identity backup restores|identity-dependent history without source identity/,
  },
});
