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
 */
import "dotenv/config";
import { eq } from "drizzle-orm";

import { db } from "../src/db";
import { users } from "../src/db/schema";
import { auth } from "../src/lib/auth/server";

async function main(): Promise<void> {
  const username = process.env.ADMIN_USERNAME?.trim();
  const password = process.env.ADMIN_PASSWORD;
  const name = process.env.ADMIN_NAME?.trim() || "System Administrator";
  const email =
    process.env.ADMIN_EMAIL?.trim() ||
    `${username ?? "admin"}@aqlan-center-mini.local`;

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

  // Sign-up endpoint invoked from the trusted server side: creates the user
  // and their credential account (password stored as a strong hash).
  const created = await auth.api.signUpEmail({
    body: {
      name,
      username,
      email,
      password,
      callbackURL: "/login",
    },
  });

  // Role and active flags are server-controlled (input: false), so set the
  // ADMIN role directly after creation.
  await db
    .update(users)
    .set({ role: "ADMIN", active: true })
    .where(eq(users.id, created.user.id));

  console.log(`Admin user created successfully: ${username} (${created.user.id})`);
  console.log("Set ADMIN role and activated the account.");
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error("Seed failed:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
