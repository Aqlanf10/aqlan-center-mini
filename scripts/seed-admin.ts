/**
 * Seed the first administrator account for Aqlan Center Mini.
 *
 * Run only after DATABASE_URL points at the dedicated Neon database:
 *
 *   ADMIN_USERNAME=admin ADMIN_PASSWORD='<strong-password>' \
 *   ADMIN_NAME='System Administrator' ADMIN_EMAIL='admin@example.com' \
 *   npm run db:seed
 *
 * The password is never printed or logged. Passwords are stored as strong
 * one-way hashes by Better Auth (scrypt) — see src/lib/auth/server.ts.
 * Uses the trusted server-side admin createUser API (public self-signup
 * is disabled in the auth config).
 */
import "dotenv/config";
import { eq } from "drizzle-orm";

import { db } from "../src/db";
import { users } from "../src/db/schema";
import { auth } from "../src/lib/auth/server";

async function main(): Promise<void> {
  const username = process.env.ADMIN_USERNAME?.trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  const name = process.env.ADMIN_NAME?.trim() || "System Administrator";
  const email =
    process.env.ADMIN_EMAIL?.trim().toLowerCase() ||
    `${username ?? "admin"}@staff.aqlan-center.local`;

  if (!username || !password) {
    console.error(
      "Missing ADMIN_USERNAME or ADMIN_PASSWORD environment variables."
    );
    process.exit(1);
  }

  if (password.length < 8) {
    console.error("ADMIN_PASSWORD must be at least 8 characters.");
    process.exit(1);
  }

  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.username, username))
    .limit(1);

  if (existing) {
    console.error(`User "${username}" already exists. Nothing was changed.`);
    process.exit(1);
  }

  // Trusted server-side admin API: hashes the password properly and
  // creates the credential account in one step.
  const result = await auth.api.createUser({
    body: {
      name,
      email,
      password,
      role: "ADMIN",
      data: { username, active: true },
    },
  });

  const userId = result?.user?.id;
  if (!userId) {
    console.error("Admin creation returned no user id.");
    process.exit(1);
  }

  // Ensure our custom columns are exactly as intended.
  await db
    .update(users)
    .set({ username, active: true, role: "ADMIN" })
    .where(eq(users.id, userId));

  console.log(`Admin user created successfully: ${username} (${userId})`);
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error(
      "Seed failed:",
      error instanceof Error ? error.message : error
    );
    process.exit(1);
  });
