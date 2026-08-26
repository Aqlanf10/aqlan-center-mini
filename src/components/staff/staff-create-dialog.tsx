"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { LoaderCircleIcon } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { FormField, dictPath } from "@/components/shared/form-field";
import { Select } from "@/components/shared/select";
import { useI18n } from "@/i18n/provider";
import type { UserRole } from "@/db/schema/enums";
import { createStaffAction } from "@/server/staff/actions";

/** Add-staff dialog (ADMIN only; enforced server-side). */
export function StaffCreateDialog({ trigger }: { trigger: string }) {
  const { dict } = useI18n();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<UserRole>("RECEPTION");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    setSubmitting(true);
    try {
      const result = await createStaffAction({
        name,
        username,
        email,
        password,
        role,
      });
      if (result.ok) {
        toast.success(dictPath(dict, result.messageKey));
        setOpen(false);
        setName("");
        setUsername("");
        setEmail("");
        setPassword("");
        setRole("RECEPTION");
        setFieldErrors({});
        router.refresh();
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
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>{trigger}</Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{dict.staff.add}</DialogTitle>
          <DialogDescription>{dict.staff.subtitle}</DialogDescription>
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

          <FormField id="staff-name" label={dict.staff.fields.name} required error={errorFor("name")}>
            <Input
              id="staff-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              disabled={submitting}
              required
            />
          </FormField>

          <FormField id="staff-username" label={dict.staff.fields.username} required error={errorFor("username")}>
            <Input
              id="staff-username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              disabled={submitting}
              dir="ltr"
              autoComplete="off"
              required
            />
          </FormField>

          <FormField
            id="staff-email"
            label={dict.staff.fields.email}
            hint={dict.staff.fields.emailOptional}
            error={errorFor("email")}
          >
            <Input
              id="staff-email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              disabled={submitting}
              dir="ltr"
              autoComplete="off"
            />
          </FormField>

          <FormField
            id="staff-password"
            label={dict.staff.fields.password}
            hint={dict.staff.fields.passwordNote}
            required
            error={errorFor("password")}
          >
            <Input
              id="staff-password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={submitting}
              dir="ltr"
              autoComplete="new-password"
              minLength={8}
              required
            />
          </FormField>

          <FormField id="staff-role" label={dict.staff.fields.role} required error={errorFor("role")}>
            <Select
              id="staff-role"
              value={role}
              onChange={(event) => setRole(event.target.value as UserRole)}
              disabled={submitting}
              options={(["ADMIN", "DOCTOR", "RECEPTION"] as const).map((value) => ({
                value,
                label: dict.roles[value],
              }))}
            />
          </FormField>

          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={submitting}>
              {dict.common.cancel}
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? (
                <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
              ) : null}
              {dict.common.save}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
