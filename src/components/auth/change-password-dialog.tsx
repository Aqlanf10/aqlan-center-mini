"use client";

import { useState, type FormEvent } from "react";
import { EyeIcon, EyeOffIcon, KeyRoundIcon, LoaderCircleIcon } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { FormField, dictPath } from "@/components/shared/form-field";
import { useI18n } from "@/i18n/provider";
import { changeMyPasswordAction } from "@/server/auth/actions";

/**
 * Signed-in user changes their own password. Requires the current
 * password; other sessions are revoked on success. Password values are
 * never logged and never echoed back. Can run self-contained (own
 * trigger button) or controlled via open/onOpenChange.
 */
export function ChangePasswordDialog({
  open: controlledOpen,
  onOpenChange,
}: {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const { dict } = useI18n();
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = controlledOpen ?? uncontrolledOpen;
  const setOpen = onOpenChange ?? setUncontrolledOpen;
  const [submitting, setSubmitting] = useState(false);
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [values, setValues] = useState({
    currentPassword: "",
    newPassword: "",
    confirmPassword: "",
  });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  function reset() {
    setValues({ currentPassword: "", newPassword: "", confirmPassword: "" });
    setFieldErrors({});
    setFormError(null);
    setShowCurrent(false);
    setShowNew(false);
  }

  function set(key: keyof typeof values, value: string) {
    setValues((prev) => ({ ...prev, [key]: value }));
    setFieldErrors((prev) => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);

    setSubmitting(true);
    try {
      const result = await changeMyPasswordAction(values);
      if (result.ok) {
        toast.success(dictPath(dict, result.messageKey));
        setOpen(false);
        reset();
      } else {
        setFieldErrors(result.fieldErrors ?? {});
        if (Object.keys(result.fieldErrors ?? {}).length === 0) {
          setFormError(dictPath(dict, result.errorKey));
        }
      }
    } catch {
      setFormError(dict.common.serverError);
    } finally {
      setSubmitting(false);
    }
  }

  const errorFor = (key: string) =>
    fieldErrors[key] ? dictPath(dict, fieldErrors[key]!) : undefined;

  const t = dict.auth.changePassword;
  const controlled = controlledOpen !== undefined;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      {!controlled ? (
        <DialogTrigger asChild>
          <Button variant="outline" size="sm">
            <KeyRoundIcon aria-hidden="true" />
            {t.trigger}
          </Button>
        </DialogTrigger>
      ) : null}
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t.title}</DialogTitle>
          <DialogDescription>{t.description}</DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
          {formError ? (
            <p
              className="bg-destructive/10 text-destructive rounded-md px-3 py-2 text-sm"
              role="alert"
            >
              {formError}
            </p>
          ) : null}

          <FormField
            id="cp-current"
            label={t.currentPassword}
            required
            error={errorFor("currentPassword")}
          >
            <div className="relative">
              <Input
                id="cp-current"
                type={showCurrent ? "text" : "password"}
                autoComplete="current-password"
                value={values.currentPassword}
                onChange={(e) => set("currentPassword", e.target.value)}
                disabled={submitting}
                required
                dir="ltr"
                className="pe-10"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="absolute inset-y-0 end-1.5"
                onClick={() => setShowCurrent((v) => !v)}
                aria-label={
                  showCurrent ? dict.auth.hidePassword : dict.auth.showPassword
                }
                tabIndex={-1}
              >
                {showCurrent ? (
                  <EyeOffIcon aria-hidden="true" />
                ) : (
                  <EyeIcon aria-hidden="true" />
                )}
              </Button>
            </div>
          </FormField>

          <FormField
            id="cp-new"
            label={t.newPassword}
            required
            error={errorFor("newPassword")}
            hint={t.minHint}
          >
            <div className="relative">
              <Input
                id="cp-new"
                type={showNew ? "text" : "password"}
                autoComplete="new-password"
                value={values.newPassword}
                onChange={(e) => set("newPassword", e.target.value)}
                disabled={submitting}
                required
                minLength={8}
                dir="ltr"
                className="pe-10"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="absolute inset-y-0 end-1.5"
                onClick={() => setShowNew((v) => !v)}
                aria-label={
                  showNew ? dict.auth.hidePassword : dict.auth.showPassword
                }
                tabIndex={-1}
              >
                {showNew ? (
                  <EyeOffIcon aria-hidden="true" />
                ) : (
                  <EyeIcon aria-hidden="true" />
                )}
              </Button>
            </div>
          </FormField>

          <FormField
            id="cp-confirm"
            label={t.confirmPassword}
            required
            error={errorFor("confirmPassword")}
          >
            <Input
              id="cp-confirm"
              type={showNew ? "text" : "password"}
              autoComplete="new-password"
              value={values.confirmPassword}
              onChange={(e) => set("confirmPassword", e.target.value)}
              disabled={submitting}
              required
              dir="ltr"
            />
          </FormField>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
              disabled={submitting}
            >
              {dict.common.cancel}
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? (
                <>
                  <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
                  {dict.common.saving}
                </>
              ) : (
                t.submit
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
