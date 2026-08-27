"use client";

import { useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AlertCircleIcon, EyeIcon, EyeOffIcon, LoaderCircleIcon } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useI18n } from "@/i18n/provider";
import { authClient, getLoginErrorKey } from "@/lib/auth/client";
import { safeInternalPath, validateLogin, type LoginFieldErrors } from "@/lib/validation";

export function LoginForm() {
  const { dict } = useI18n();
  const router = useRouter();
  const searchParams = useSearchParams();

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<LoginFieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);

    const validation = validateLogin({ username, password });
    if (!validation.ok) {
      setFieldErrors(validation.errors);
      return;
    }
    setFieldErrors({});

    setSubmitting(true);
    try {
      const result = await authClient.signIn.username({
        username: validation.data.username,
        password: validation.data.password,
      });

      if (result.error) {
        setFormError(getLoginErrorKey(result.error));
        return;
      }

      const next = safeInternalPath(searchParams.get("next"));
      router.push(next);
      router.refresh();
    } catch {
      setFormError("loginFailed");
    } finally {
      setSubmitting(false);
    }
  }

  function fieldError(messageKey: string | undefined) {
    if (!messageKey) return undefined;
    const value = dict.auth[messageKey as keyof typeof dict.auth];
    return typeof value === "string" ? value : dict.errors.generic;
  }

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle className="text-2xl">{dict.auth.loginTitle}</CardTitle>
        <CardDescription>{dict.auth.loginSubtitle}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
          {formError ? (
            <Alert variant="destructive">
              <AlertCircleIcon aria-hidden="true" />
              <AlertTitle>{dict.common.error}</AlertTitle>
              <AlertDescription>
                {formError === "invalidCredentials"
                  ? dict.auth.invalidCredentials
                  : dict.auth.loginFailed}
              </AlertDescription>
            </Alert>
          ) : null}

          <div className="flex flex-col gap-2">
            <Label htmlFor="username">{dict.auth.username}</Label>
            <Input
              id="username"
              name="username"
              autoComplete="username"
              inputMode="text"
              dir="ltr"
              placeholder={dict.auth.usernamePlaceholder}
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              aria-invalid={Boolean(fieldErrors.username)}
              aria-describedby={fieldErrors.username ? "username-error" : undefined}
              disabled={submitting}
              required
            />
            {fieldErrors.username ? (
              <p id="username-error" className="text-destructive text-sm" role="alert">
                {fieldError(fieldErrors.username)}
              </p>
            ) : null}
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="password">{dict.auth.password}</Label>
            <div className="relative">
              <Input
                id="password"
                name="password"
                type={showPassword ? "text" : "password"}
                autoComplete="current-password"
                dir="ltr"
                placeholder={dict.auth.passwordPlaceholder}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                aria-invalid={Boolean(fieldErrors.password)}
                aria-describedby={fieldErrors.password ? "password-error" : undefined}
                disabled={submitting}
                required
                className="pe-11"
              />
              <button
                type="button"
                onClick={() => setShowPassword((visible) => !visible)}
                className="text-muted-foreground hover:text-foreground absolute inset-y-0 end-2 my-auto flex size-7 items-center justify-center rounded-md focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
                aria-label={showPassword ? dict.auth.hidePassword : dict.auth.showPassword}
                aria-pressed={showPassword}
                disabled={submitting}
              >
                {showPassword ? (
                  <EyeOffIcon className="size-4" aria-hidden="true" />
                ) : (
                  <EyeIcon className="size-4" aria-hidden="true" />
                )}
              </button>
            </div>
            {fieldErrors.password ? (
              <p id="password-error" className="text-destructive text-sm" role="alert">
                {fieldError(fieldErrors.password)}
              </p>
            ) : null}
          </div>

          <Button type="submit" className="w-full" disabled={submitting}>
            {submitting ? (
              <>
                <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
                {dict.auth.submitting}
              </>
            ) : (
              dict.auth.submit
            )}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
