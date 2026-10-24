import { checkServerIdentity, type ConnectionOptions } from "node:tls";

/** Bind peer identity to the approved endpoint, including IP endpoints for
 * which pg does not set servername on its already-connected socket. */
export function empty51Tls(host: string, ca?: string): ConnectionOptions {
  return { rejectUnauthorized: true, ...(ca ? { ca } : {}),
    checkServerIdentity: (_hostname, certificate) => checkServerIdentity(host, certificate) };
}
