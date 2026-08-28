"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  EyeIcon,
  EyeOffIcon,
  KeyRoundIcon,
  LoaderCircleIcon,
  UserRoundCheckIcon,
  UserRoundXIcon,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/shared/select";
import { FormField, dictPath } from "@/components/shared/form-field";
import { useI18n } from "@/i18n/provider";
import type { UserRole } from "@/db/schema/enums";
import {
  resetStaffPasswordAction,
  setStaffActiveAction,
  setStaffRoleAction,
} from "@/server/staff/actions";

/** Row-level staff controls: activate/deactivate + role change. */
export function StaffRowActions({
  userId,
  name,
  active,
  role,
  isSelf,
}: {
  userId: string;
  name: string;
  active: boolean;
  role: UserRole;
  isSelf: boolean;
}) {
  const { dict } = useI18n();
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function runActive(next: boolean) {
    startTransition(async () => {
      const result = await setStaffActiveAction(userId, next);
      if (result.ok) {
        toast.success(dictPath(dict, result.messageKey));
        router.refresh();
      } else {
        toast.error(dictPath(dict, result.errorKey));
      }
    });
  }

  function runRole(next: string) {
    if (next === role) return;
    startTransition(async () => {
      const result = await setStaffRoleAction(userId, next as UserRole);
      if (result.ok) {
        toast.success(dictPath(dict, result.messageKey));
        router.refresh();
      } else {
        toast.error(dictPath(dict, result.errorKey));
      }
    });
  }

  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <ResetPasswordButton userId={userId} name={name} />

      <div className="w-36">
        <Select
          value={role}
          onChange={(event) => runRole(event.target.value)}
          disabled={pending || isSelf}
          aria-label={dict.staff.actions.changeRole}
          options={(["ADMIN", "DOCTOR", "RECEPTION"] as const).map((value) => ({
            value,
            label: dict.roles[value],
          }))}
        />
      </div>

      {active ? (
        <DeactivateButton
          name={name}
          disabled={pending || isSelf}
          onConfirm={() => runActive(false)}
        />
      ) : (
        <Button
          variant="outline"
          size="sm"
          onClick={() => runActive(true)}
          disabled={pending || isSelf}
        >
          {pending ? (
            <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
          ) : (
            <UserRoundCheckIcon aria-hidden="true" />
          )}
          {dict.staff.actions.activate}
        </Button>
      )}
    </div>
  );
}

function DeactivateButton({
  name,
  disabled,
  onConfirm,
}: {
  name: string;
  disabled?: boolean;
  onConfirm: () => void;
}) {
  const { dict } = useI18n();
  const [open, setOpen] = useDialogState();

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)} disabled={disabled}>
        <UserRoundXIcon aria-hidden="true" />
        {dict.staff.actions.deactivate}
      </Button>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{dict.staff.confirmDeactivateTitle}</DialogTitle>
          <DialogDescription>
            {name} — {dict.staff.confirmDeactivateDescription}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            {dict.common.cancel}
          </Button>
          <Button
            variant="destructive"
            onClick={() => {
              setOpen(false);
              onConfirm();
            }}
          >
            {dict.staff.actions.deactivate}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function useDialogState() {
  return useState(false);
}

/** ADMIN-only: set a new password for another staff member. */
function ResetPasswordButton({
  userId,
  name,
}: {
  userId: string;
  name: string;
}) {
  const { dict } = useI18n();
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [show, setShow] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const t = dict.staff.reset;

  function reset() {
    setNewPassword("");
    setConfirmPassword("");
    setFieldErrors({});
    setFormError(null);
    setShow(false);
  }

  async function handleSubmit() {
    setFormError(null);
    setSubmitting(true);
    try {
      const result = await resetStaffPasswordAction(userId, {
        newPassword,
        confirmPassword,
      });
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

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <KeyRoundIcon aria-hidden="true" />
        {t.trigger}
      </Button>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t.title}</DialogTitle>
          <DialogDescription>
            {name} — {t.description}
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void handleSubmit();
          }}
          className="flex flex-col gap-4"
          noValidate
        >
          {formError ? (
            <p
              className="bg-destructive/10 text-destructive rounded-md px-3 py-2 text-sm"
              role="alert"
            >
              {formError}
            </p>
          ) : null}

          <FormField
            id={`rp-new-${userId}`}
            label={t.newPassword}
            required
            error={errorFor("newPassword")}
            hint={dict.auth.changePassword.minHint}
          >
            <div className="relative">
              <Input
                id={`rp-new-${userId}`}
                type={show ? "text" : "password"}
                autoComplete="new-password"
                value={newPassword}
                onChange={(e) => {
                  setNewPassword(e.target.value);
                  setFieldErrors((prev) => ({ ...prev, newPassword: "" }));
                }}
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
                onClick={() => setShow((v) => !v)}
                aria-label={
                  show ? dict.auth.hidePassword : dict.auth.showPassword
                }
                tabIndex={-1}
              >
                {show ? (
                  <EyeOffIcon aria-hidden="true" />
                ) : (
                  <EyeIcon aria-hidden="true" />
                )}
              </Button>
            </div>
          </FormField>

          <FormField
            id={`rp-confirm-${userId}`}
            label={t.confirmPassword}
            required
            error={errorFor("confirmPassword")}
          >
            <Input
              id={`rp-confirm-${userId}`}
              type={show ? "text" : "password"}
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(e) => {
                setConfirmPassword(e.target.value);
                setFieldErrors((prev) => ({ ...prev, confirmPassword: "" }));
              }}
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
                <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
              ) : null}
              {t.submit}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
