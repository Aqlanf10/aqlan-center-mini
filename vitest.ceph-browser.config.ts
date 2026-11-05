import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["__tests__/security-http/ceph-tracer-real-react.test.ts"], testTimeout: 30000, hookTimeout: 120000, fileParallelism: false } });
