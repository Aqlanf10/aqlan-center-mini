import { afterEach, expect, it, vi } from 'vitest';
import { allowLocalDemoData } from '../lib/database-scope';
it('seeds demo accounts and stock only for explicitly local, non-production storage', () => {
  expect(allowLocalDemoData({})).toBe(false);
  expect(allowLocalDemoData({ NODE_ENV: 'production', USE_LOCAL_DB: 'true' })).toBe(false);
  expect(allowLocalDemoData({ RAILWAY_PROJECT_ID: 'project', USE_LOCAL_DB: 'true' })).toBe(false);
  expect(allowLocalDemoData({ NODE_ENV: 'development', USE_LOCAL_DB: 'true' })).toBe(true);
});
afterEach(() => vi.unstubAllEnvs());
async function freshPool() {
  vi.resetModules();
  return (await import('../lib/db')).getPool;
}
it('does not silently create an in-memory database with no connection', async () => {
  for (const name of ['DATABASE_URL','POSTGRES_URL','POSTGRES_PRISMA_URL','POSTGRES_URL_NON_POOLING','USE_LOCAL_DB','RAILWAY_PROJECT_ID']) vi.stubEnv(name,'');
  const getPool = await freshPool();
  expect(getPool).toThrow('DATABASE_URL');
});
it('rejects explicit in-memory storage in production', async () => {
  vi.stubEnv('NODE_ENV','production'); vi.stubEnv('USE_LOCAL_DB','true'); vi.stubEnv('RAILWAY_PROJECT_ID','');
  expect(await freshPool()).toThrow('الإنتاج');
});
it('does not swallow the wrong-project guard with a local fallback', async () => {
  vi.stubEnv('RAILWAY_PROJECT_ID','wrong-project'); vi.stubEnv('USE_LOCAL_DB','true');
  expect(await freshPool()).toThrow('مشروع');
});
