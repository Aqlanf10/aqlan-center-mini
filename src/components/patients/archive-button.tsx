"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ArchiveIcon, LoaderCircleIcon, UndoIcon } from "lucide-react";
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
import { dictPath } from "@/components/shared/form-field";
import { useI18n } from "@/i18n/provider";
import { setPatientActiveAction } from "@/server/patients/actions";

/**
 * Archive / reactivate a patient. Archiving is a soft action: clinical and
 * financial records are never deleted (FKs are RESTRICT at the DB level).
 */
export function ArchivePatientButton({
  patientId,
  active,
  name,
}: {
  patientId: string;
  active: boolean;
  name: string;
}) {
  const { dict } = useI18n();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  function run() {
    startTransition(async () => {
      const result = await setPatientActiveAction(patientId, !active);
      if (result.ok) {
        toast.success(dictPath(dict, result.messageKey));
        setOpen(false);
        router.refresh();
      } else {
        toast.error(dictPath(dict, result.errorKey));
      }
    });
  }

  if (active) {
    return (
      <Dialog open={open} onOpenChange={setOpen}>
        <Button variant="outline" onClick={() => setOpen(true)}>
          <ArchiveIcon aria-hidden="true" />
          {dict.patients.archive.action}
        </Button>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{dict.patients.archive.confirmTitle}</DialogTitle>
            <DialogDescription>
              {name} — {dict.patients.archive.confirmDescription}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={pending}>
              {dict.common.cancel}
            </Button>
            <Button variant="destructive" onClick={run} disabled={pending}>
              {pending ? (
                <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
              ) : (
                <ArchiveIcon aria-hidden="true" />
              )}
              {dict.patients.archive.action}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Button variant="outline" onClick={run} disabled={pending}>
      {pending ? (
        <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
      ) : (
        <UndoIcon aria-hidden="true" />
      )}
      {dict.patients.archive.reactivate}
    </Button>
  );
}
