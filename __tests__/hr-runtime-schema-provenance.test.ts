import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import bundled from '../lib/hr-temporal-schema.generated.json';

it('bundles the exact reviewed 0056/R1-0057/allocated0058 bytes without depending on a runtime filesystem', async () => {
  expect(bundled.map(file => file.filename)).toEqual(['0056_hr_employment_history.sql', '0057_hr_schedule_policy_versions.sql', '0058_hr_temporal_write_receipts.sql']);
  expect(bundled.map(file => file.checksum)).toEqual([
    'cc87396b7d3cd5035c67f1dfa0f2dedbe2ed904a618722b12b833c969cf7c112',
    '8e4bf0f0adf3d2284f64bd792b3903958ce6ed62923b4cb0c61ac405b82b8791',
    '1c2c0a3582cb5777fe6cf063d0ba5d1bbe04ef6acbbf035382a7fceeb9a6b972',
  ]);
  for (const file of bundled) {
    const sql = await readFile(`migrations/${file.filename}`, 'utf8');
    expect(file.sql).toBe(sql);
    expect(file.checksum).toBe(createHash('sha256').update(sql).digest('hex'));
    expect(file.version).toBe(file.filename.slice(0, 4));
    expect(file.name).toBe(file.filename.slice(5, -4));
  }
});
