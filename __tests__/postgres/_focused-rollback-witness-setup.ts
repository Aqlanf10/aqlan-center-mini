import originalSetup from './_global-setup';
import { validateFocusedRollbackWitnessEnvironment } from './_focused-rollback-witness-guard';

export default async function setup() {
  validateFocusedRollbackWitnessEnvironment(process.env);
  return originalSetup();
}
