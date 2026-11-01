import { afterAll, beforeAll, vi } from 'vitest';
import { prescriptionHistoryProtectionCases } from './helpers/prescription-history-protection-cases';
vi.stubEnv('USE_LOCAL_DB','true'); vi.stubEnv('NODE_ENV','test'); vi.stubEnv('RAILWAY_PROJECT_ID','');
const db = await import('../lib/db');
beforeAll(async () => { await db.ensureSchema(); },60000);
afterAll(async () => { await db.resetPoolForTesting(); vi.unstubAllEnvs(); });
prescriptionHistoryProtectionCases(db);
