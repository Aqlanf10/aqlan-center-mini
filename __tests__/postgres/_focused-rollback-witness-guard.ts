import path from 'node:path';
import { validateOperationalVerificationEnvironment } from '../../lib/verification-target-policy.mjs';
import { validatePostgresTestTarget } from './_safe-target';

/** Called before the original PostgreSQL global setup constructs a client. */
export function validateFocusedRollbackWitnessEnvironment(env: NodeJS.ProcessEnv): void {
  const database = 'postgresql://ci:ci@127.0.0.1:55473/aqlan_p1_test?sslmode=disable';
  if (env.GITHUB_ACTIONS !== 'true' || env.CI !== 'true' || !/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID ?? '')
      || env.SYNTHETIC_LATE_ROLLBACK_WITNESS !== '1' || env.TEST_DATABASE_URL !== database
      || env.DATABASE_URL !== database || !env.GITHUB_WORKSPACE || !path.isAbsolute(env.GITHUB_WORKSPACE)) {
    throw new Error('Focused rollback witness requires its dedicated GitHub CI synthetic service.');
  }
  // Reject unsafe alternative aliases and deployment markers before any client.
  validateOperationalVerificationEnvironment(env, { requireSource: true });
  validatePostgresTestTarget(env);
}
