// Test-only asynchronous loader: fail if the raw entry creates a pg Client.
const pgStub = "export class Client { constructor() { process.stderr.write('SYNTHETIC_PG_CLIENT_BLOCKED\\n'); throw new Error('synthetic pg client blocked'); } }";

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'pg') return { url: 'data:text/javascript,' + encodeURIComponent(pgStub), shortCircuit: true };
  return nextResolve(specifier, context);
}
