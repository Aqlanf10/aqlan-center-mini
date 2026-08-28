"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { LoaderCircleIcon, PlusIcon } from "lucide-react";
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
import { Textarea } from "@/components/ui/textarea";
import { FormField, dictPath } from "@/components/shared/form-field";
import { useI18n } from "@/i18n/provider";
import { appendVisitCorrectionAction } from "@/server/visits/actions";

/**
 * Append an audited correction to a COMPLETED visit (ADMIN only).
 * The original clinical fields are never modified.
 */
export function VisitCorrectionDialog({ visitId }: { visitId: string }) {
  const { dict } = useI18n();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [note, setNote] = useState("");
  const [reason, setReason] = useState("");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    setSubmitting(true);
    try {
      const result = await appendVisitCorrectionAction(visitId, { note, reason });
      if (result.ok) {
        toast.success(dictPath(dict, result.messageKey));
        setOpen(false);
        setNote("");
        setReason("");
        router.refresh();
      } else {
        setFormError(dictPath(dict, result.errorKey));
      }
    } catch {
      setFormError(dict.common.serverError);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <PlusIcon aria-hidden="true" />
          {dict.visitCorrections.add}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{dict.visitCorrections.add}</DialogTitle>
          <DialogDescription>{dict.visitCorrections.subtitle}</DialogDescription>
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
          <FormField id={`correction-note-${visitId}`} label={dict.visitCorrections.note} required>
            <Textarea
              id={`correction-note-${visitId}`}
              value={note}
              onChange={(event) => setNote(event.target.value)}
              disabled={submitting}
              rows={3}
              required
            />
          </FormField>
          <FormField id={`correction-reason-${visitId}`} label={dict.visitCorrections.reason} required>
            <Textarea
              id={`correction-reason-${visitId}`}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              disabled={submitting}
              rows={2}
              required
            />
          </FormField>
          <div className="flex justify-end gap-2">
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
              {dict.common.save}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
