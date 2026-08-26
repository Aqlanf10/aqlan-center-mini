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
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { FormField, dictPath } from "@/components/shared/form-field";
import { Select } from "@/components/shared/select";
import { useI18n } from "@/i18n/provider";
import type { ContactResult, ContactType } from "@/db/schema/enums";
import { logContactAction } from "@/server/contacts/actions";

const CONTACT_TYPES: ContactType[] = ["PHONE", "WHATSAPP", "IN_PERSON", "OTHER"];
const CONTACT_RESULTS: ContactResult[] = [
  "CONTACTED",
  "NO_ANSWER",
  "RESCHEDULED",
  "WILL_CALL_BACK",
  "CANCELLED",
  "OTHER",
];

/**
 * Quick "log contact attempt" dialog. Saves patientId + userId + result +
 * optional note; the history then shows on the patient profile and the
 * Follow-up "Contacted" queue.
 */
export function ContactDialog({
  patientId,
  patientName,
  defaultType = "PHONE",
  trigger,
  triggerVariant = "outline",
}: {
  patientId: string;
  patientName: string;
  defaultType?: ContactType;
  trigger: string;
  triggerVariant?: "default" | "outline" | "ghost" | "secondary";
}) {
  const { dict } = useI18n();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [contactType, setContactType] = useState<ContactType>(defaultType);
  const [result, setResult] = useState<ContactResult>("CONTACTED");
  const [note, setNote] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    try {
      const response = await logContactAction({
        patientId,
        contactType,
        result,
        note,
      });
      if (response.ok) {
        toast.success(dictPath(dict, response.messageKey));
        setOpen(false);
        setNote("");
        setFieldErrors({});
        router.refresh();
      } else {
        setFieldErrors(response.fieldErrors ?? {});
        toast.error(dictPath(dict, response.errorKey));
      }
    } catch {
      toast.error(dict.common.serverError);
    } finally {
      setSubmitting(false);
    }
  }

  const errorFor = (key: string) =>
    fieldErrors[key] ? dictPath(dict, fieldErrors[key]!) : undefined;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant={triggerVariant}>{trigger}</Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{dict.followUp.contactDialog.title}</DialogTitle>
          <DialogDescription>{patientName}</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
          <FormField
            id="contact-type"
            label={dict.followUp.contactDialog.type}
            required
            error={errorFor("contactType")}
          >
            <Select
              id="contact-type"
              value={contactType}
              onChange={(event) => setContactType(event.target.value as ContactType)}
              disabled={submitting}
              options={CONTACT_TYPES.map((value) => ({
                value,
                label: dict.statuses.contactType[value],
              }))}
            />
          </FormField>

          <FormField
            id="contact-result"
            label={dict.followUp.contactDialog.result}
            required
            error={errorFor("result")}
          >
            <Select
              id="contact-result"
              value={result}
              onChange={(event) => setResult(event.target.value as ContactResult)}
              disabled={submitting}
              options={CONTACT_RESULTS.map((value) => ({
                value,
                label: dict.statuses.contactResult[value],
              }))}
            />
          </FormField>

          <FormField id="contact-note" label={dict.followUp.contactDialog.note} error={errorFor("note")}>
            <Textarea
              id="contact-note"
              value={note}
              placeholder={dict.followUp.contactDialog.notePlaceholder}
              onChange={(event) => setNote(event.target.value)}
              disabled={submitting}
              rows={2}
            />
          </FormField>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={submitting}>
              {dict.common.cancel}
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? (
                <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
              ) : null}
              {dict.followUp.contactDialog.save}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
