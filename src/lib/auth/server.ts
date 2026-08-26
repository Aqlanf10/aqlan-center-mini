import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin, username } from "better-auth/plugins";
import { adminAc, defaultAc } from "better-auth/plugins/admin/access";
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
 * - Admin plugin powers trusted server-side staff creation with proper
 *   password hashing. Roles map 1:1 to our enum (ADMIN/DOCTOR/RECEPTION).
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
    // Public self-registration is disabled: staff accounts are created
    // only by an ADMIN through /settings/staff (or the seed script), both
    // using the trusted server-side admin createUser API.
    disableSignUp: true,
  },
  plugins: [
    username(),
    admin({
      // Our staff roles — "ADMIN" is the only admin role. The roles map
      // makes the plugin's types accept the app's role enum directly.
      adminRoles: ["ADMIN"],
      defaultRole: "RECEPTION",
      roles: {
        ADMIN: adminAc,
        DOCTOR: defaultAc.newRole({}),
        RECEPTION: defaultAc.newRole({}),
      },
      // No default password is ever embedded in source code.
    }),
  ],
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
  advanced: {
    database: {
      // Our id columns are `uuid` — Better Auth's default nanoid-style ids
      // would be rejected by PostgreSQL ("invalid input syntax for type
      // uuid"). Generate RFC 4122 ids for every entity it creates.
      generateId: () => crypto.randomUUID(),
    },
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
