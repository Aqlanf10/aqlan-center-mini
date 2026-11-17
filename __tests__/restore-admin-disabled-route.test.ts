import { afterEach, expect, it, vi } from 'vitest';

const mocks=vi.hoisted(() => ({
  auth:vi.fn(),
  restore:vi.fn(),
}));
vi.mock('@/lib/backupReadOnly', () => ({ requireBackupAdminReadOnly:mocks.auth }));
vi.mock('@/lib/restore/admin', () => ({ runAdminRestoreDrill:mocks.restore }));
import { POST } from '../app/api/settings/backup/restore/route';

afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

it('reports the suspended administrative restore as unavailable after authentication', async () => {
  vi.stubEnv('RAILWAY_VOLUME_MOUNT_PATH','/synthetic-volume');
  mocks.auth.mockResolvedValue({ok:true,session:{role:'admin',username:'synthetic-admin'}});
  mocks.restore.mockResolvedValue({ok:false,reason:'restore-temporarily-disabled'});
  const backupId='production-backup-20261117-010203-001-abcde123-abcdef12.tar.gz';
  const request=new Request('http://localhost/api/settings/backup/restore',{
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({backupId,confirmation:backupId}),
  });
  const response=await POST(request);
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ok:false,reason:'restore-temporarily-disabled',message:'تجربة الاستعادة الإدارية متوقفة مؤقتًا لحماية البيانات.'});
  expect(mocks.restore).toHaveBeenCalledOnce();
});
