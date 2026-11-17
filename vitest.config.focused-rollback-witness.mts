import { defineConfig } from 'vitest/config';
import base from './vitest.config.postgres.mts';

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ['__tests__/postgres/hr-composed-legacy-restore.test.ts'],
    globalSetup: ['__tests__/postgres/_focused-rollback-witness-setup.ts'],
  },
});
