import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { username } from "better-auth/plugins";
import { eq } from "drizzle-orm";

import { db } from "@/db";
import * as schema from "@/db/schema";
import { users } from "@/db/schema";

/**
 * Better Auth instance for Aqlan Center Mini.
 *
 * - Username + password sign-in (staff accounts).
 * - Password hashes are stored by the credential provider in `accounts.password`
 *   using a strong one-way hash (scrypt) — never plaintext.
 * - Sessions are persisted in the `sessions` table.
 * - Deactivated users (active = false) cannot create new sessions.
 */
export const auth = betterAuth({
  appName: "Aqlan Center Mini",
  secret: process.env.AUTH_SECRET ?? "insecure-development-secret-change-me",
  // Optional explicit base URL (recommended in production to silence the
  // dynamic-origin warning); when unset the origin is derived per request.
  ...(process.env.BETTER_AUTH_URL
    ? { baseURL: process.env.BETTER_AUTH_URL }
    : {}),
  database: drizzleAdapter(db, {
    provider: "pg",
    schema,
    // Tables are exported with plural names (users, sessions, ...).
    usePlural: true,
  }),
  emailAndPassword: {
    enabled: true,
    autoSignIn: false,
    minPasswordLength: 8,
  },
  plugins: [username()],
  user: {
    additionalFields: {
      role: {
        type: "string",
        required: true,
        defaultValue: "RECEPTION",
        input: false,
      },
      active: {
        type: "boolean",
        required: true,
        defaultValue: true,
        input: false,
      },
    },
  },
  session: {
    expiresIn: 60 * 60 * 24 * 7, // 7 days
    updateAge: 60 * 60 * 24, // refresh once a day
  },
  databaseHooks: {
    session: {
      create: {
        before: async (session) => {
          const [user] = await db
            .select({ active: users.active })
            .from(users)
            .where(eq(users.id, session.userId))
            .limit(1);
          if (!user || !user.active) {
            // Returning false blocks session creation for deactivated users.
            return false;
          }
          return true;
        },
      },
    },
  },
});

/** Cookie checked cheaply by the middleware (real checks stay server-side). */
export const SESSION_COOKIE_NAME = "better-auth.session_token";
