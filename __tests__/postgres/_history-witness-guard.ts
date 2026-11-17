import path from 'node:path';
import { validateOperationalVerificationEnvironment } from '../../lib/verification-target-policy.mjs';
import { validatePostgresTestTarget } from './_safe-target';

/** Called before the original PostgreSQL global setup constructs a client. */
export function validateHistoryWitnessEnvironment(env: NodeJS.ProcessEnv): void {
  const database = 'postgresql://ci:ci@127.0.0.1:55473/aqlan_p1_test?sslmode=disable';
  if (env.GITHUB_ACTIONS !== 'true' || env.CI !== 'true' || !/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID ?? '')
      || !/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ATTEMPT ?? '')
      || env.SYNTHETIC_RESTORE_HISTORY_WITNESS !== '1' || env.TEST_DATABASE_URL !== database
      || env.DATABASE_URL !== database || !env.GITHUB_WORKSPACE || !path.isAbsolute(env.GITHUB_WORKSPACE)
      || !env.RUNNER_TEMP || !path.isAbsolute(env.RUNNER_TEMP) || env.SYNTHETIC_WITNESS_ROOT !== env.RUNNER_TEMP) {
    throw new Error('Restore history witness requires its dedicated GitHub CI synthetic service.');
  }
  for (const key of ['POSTGRES_URL', 'POSTGRES_PRISMA_URL', 'POSTGRES_URL_NON_POOLING', 'SOURCE_DATABASE_URL'] as const) {
    if (env[key] !== undefined && env[key] !== database) {
      throw new Error('Restore history witness requires matching database aliases.');
    }
  }
  // Reject unsafe alternative aliases and deployment markers before any client.
  validateOperationalVerificationEnvironment(env, { requireSource: true });
  validatePostgresTestTarget(env);
}
