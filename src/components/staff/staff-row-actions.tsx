"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { LoaderCircleIcon, UserRoundCheckIcon, UserRoundXIcon } from "lucide-react";
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
import { Select } from "@/components/shared/select";
import { dictPath } from "@/components/shared/form-field";
import { useI18n } from "@/i18n/provider";
import type { UserRole } from "@/db/schema/enums";
import {
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
