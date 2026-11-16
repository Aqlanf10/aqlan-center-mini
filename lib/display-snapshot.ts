import "server-only";
import { activeAnnouncementsForScreenWith, currentPublicDisplayCallWith, getPool, getSettingsWith, usesSharedLocalDatabaseConnection } from "./db";
import { withIsolation } from "./transactions";
import { projectWaitingRoomDisplay } from "./waiting-room";

/** A public projection on a clinic bearing canonical markers. This is not staff
 * admission: cookies, role labels and record scopes never enlarge the response.
 * Uses the existing transaction owner and public projection, without on-read
 * announcement migration or a fallback to legacy readers after any failure. */
export async function readPublicDisplaySnapshot() {
  if (process.env.USE_LOCAL_DB === "true" || usesSharedLocalDatabaseConnection()) throw new Error("DISPLAY_READ_EXCLUSIVE_CONNECTION_REQUIRED");
  return withIsolation(getPool(), "REPEATABLE READ", async client => {
    await client.query("SET TRANSACTION READ ONLY");
    await client.query("SET LOCAL statement_timeout = '3000ms'");
    await client.query("SET LOCAL lock_timeout = '1000ms'");
    // The current-call day filter and response use the same transaction clock.
    const { rows: [clock] } = await client.query<{ now: Date }>("SELECT CURRENT_TIMESTAMP AS now");
    const now = clock.now;
    const settings = await getSettingsWith(client);
    const calls = await currentPublicDisplayCallWith(client);
    const announcements = await activeAnnouncementsForScreenWith(client, settings);
    const result = projectWaitingRoomDisplay({ now, calls, settings, announcements });
    if (Buffer.byteLength(JSON.stringify(result), "utf8") > 1_048_576) throw new Error("DISPLAY_READ_RESULT_TOO_LARGE");
    return result;
  });
}
