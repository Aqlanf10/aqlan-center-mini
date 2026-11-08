import {defineConfig} from 'vitest/config';
export default defineConfig({test:{include:['__tests__/security-http/retention-ledger-real-react.test.ts'],testTimeout:30000,hookTimeout:120000,fileParallelism:false}});
