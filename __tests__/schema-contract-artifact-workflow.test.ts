import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
it('preserves the failing schema drift gate while retaining only its generated schema artifact', () => {
 const source = readFileSync('.github/workflows/ci.yml', 'utf8');
 const generation = source.split('      - name: Generate current schema contract on PostgreSQL 18\n')[1].split('\n      - name:')[0];
 expect(generation).toMatch(/^ {10}npm run schema:contract:verify -- --fresh \/tmp\/current-schema-contract.pg18.json --committed \/tmp\/committed-schema-contract.pg18.json$/m);
 expect(generation).not.toMatch(/continue-on-error|\|\|\s*(true|:)/);
 const artifact = source.split('      - name: Upload PostgreSQL 18 schema contract\n')[1].split('\n      - name:')[0];
 expect(artifact).toContain('        if: always()'); expect(artifact).toContain('          path: /tmp/current-schema-contract.pg18.json');
 expect(artifact).toContain('          if-no-files-found: error'); expect(artifact).not.toMatch(/continue-on-error|path:.*\*/);
});
