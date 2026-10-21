// Import hook blocks network clients during synthetic restore CLI tests.
import { registerHooks } from 'node:module';
const stub = "export class Client { constructor() { process.stderr.write('PG_CLIENT_CONSTRUCTOR_CALLED\\n'); throw new Error('network blocked by synthetic probe'); }}";
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'pg') {
      return { url: 'data:text/javascript,' + encodeURIComponent(stub), shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
