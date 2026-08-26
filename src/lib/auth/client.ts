"use client";

import { createAuthClient } from "better-auth/react";
import { usernameClient } from "better-auth/client/plugins";

export const authClient = createAuthClient({
  plugins: [usernameClient()],
});

/** Map a Better Auth error code to a dictionary message key. */
export function getLoginErrorKey(error: unknown): "invalidCredentials" | "loginFailed" {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: string }).code === "INVALID_USERNAME_OR_PASSWORD"
  ) {
    return "invalidCredentials";
  }
  return "loginFailed";
}
