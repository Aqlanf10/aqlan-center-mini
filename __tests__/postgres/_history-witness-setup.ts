import originalSetup from './_global-setup';
import { validateHistoryWitnessEnvironment } from './_history-witness-guard';

export default async function setup() {
  validateHistoryWitnessEnvironment(process.env);
  return originalSetup();
}
