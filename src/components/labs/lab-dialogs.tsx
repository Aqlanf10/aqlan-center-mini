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
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { FormField, dictPath } from "@/components/shared/form-field";
import { useI18n } from "@/i18n/provider";
import {
  createLabAction,
  invoiceLabCaseAction,
  setLabActiveAction,
  updateLabAction,
} from "@/server/labs/actions";


export function LabDialog({
  lab,
  buttonLabel,
}: {
  lab?: { id: string; name: string; phone: string | null; address: string | null; notes: string | null };
  buttonLabel: string;
}) {
  const { dict } = useI18n();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [name, setName] = useState(lab?.name ?? "");
  const [phone, setPhone] = useState(lab?.phone ?? "");
  const [address, setAddress] = useState(lab?.address ?? "");
  const [notes, setNotes] = useState(lab?.notes ?? "");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    setSubmitting(true);
    try {
      const result = lab
        ? await updateLabAction(lab.id, { name, phone, address, notes })
        : await createLabAction({ name, phone, address, notes });
      if (result.ok) {
        toast.success(dictPath(dict, result.messageKey));
        setOpen(false);
        setName("");
        setPhone("");
        setAddress("");
        setNotes("");
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
        <Button variant={lab ? "outline" : "default"} size={lab ? "sm" : "default"}>
          {lab ? null : <PlusIcon aria-hidden="true" />}
          {buttonLabel}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{dict.labs.newLab}</DialogTitle>
          <DialogDescription>{dict.labs.subtitle}</DialogDescription>
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
          <FormField id={`lab-name-${lab?.id ?? "new"}`} label={dict.labs.fields.name} required>
            <Input
              id={`lab-name-${lab?.id ?? "new"}`}
              value={name}
              onChange={(event) => setName(event.target.value)}
              disabled={submitting}
              required
            />
          </FormField>
          <FormField id={`lab-phone-${lab?.id ?? "new"}`} label={dict.labs.fields.phone}>
            <Input
              id={`lab-phone-${lab?.id ?? "new"}`}
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              disabled={submitting}
              dir="ltr"
            />
          </FormField>
          <FormField id={`lab-address-${lab?.id ?? "new"}`} label={dict.labs.fields.address}>
            <Input
              id={`lab-address-${lab?.id ?? "new"}`}
              value={address}
              onChange={(event) => setAddress(event.target.value)}
              disabled={submitting}
            />
          </FormField>
          <FormField id={`lab-notes-${lab?.id ?? "new"}`} label={dict.labs.fields.notes}>
            <Textarea
              id={`lab-notes-${lab?.id ?? "new"}`}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              disabled={submitting}
              rows={2}
            />
          </FormField>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={submitting}>
              {dict.common.cancel}
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? <LoaderCircleIcon className="animate-spin" aria-hidden="true" /> : null}
              {dict.common.save}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function LabActiveButton({ labId, active }: { labId: string; active: boolean }) {
  const { dict } = useI18n();
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function handleToggle() {
    setPending(true);
    try {
      const result = await setLabActiveAction(labId, !active);
      if (result.ok) {
        toast.success(dictPath(dict, result.messageKey));
        router.refresh();
      } else {
        toast.error(dictPath(dict, result.errorKey));
      }
    } catch {
      toast.error(dict.common.serverError);
    } finally {
      setPending(false);
    }
  }

  return (
    <Button variant="outline" size="sm" onClick={handleToggle} disabled={pending}>
      {active ? dict.financeAccounts.archive : dict.financeAccounts.reactivate}
    </Button>
  );
}

/** Record the lab invoice for a case (locks the cost into the balance). */
export function LabInvoiceDialog({
  caseId,
  caseNumber,
  defaultAmount,
  invoiced,
}: {
  caseId: string;
  caseNumber: string;
  defaultAmount: string;
  invoiced: boolean;
}) {
  const { dict } = useI18n();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [invoiceAmount, setInvoiceAmount] = useState(defaultAmount);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    setSubmitting(true);
    try {
      const result = await invoiceLabCaseAction(caseId, { invoiceNumber, invoiceAmount });
      if (result.ok) {
        toast.success(dictPath(dict, result.messageKey));
        setOpen(false);
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
        <Button variant="outline" size="sm" disabled={invoiced}>
          {dict.labs.invoiceCase}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>
            {dict.labs.recordInvoice} — {caseNumber}
          </DialogTitle>
          <DialogDescription>{dict.labs.caseFields.invoiced}</DialogDescription>
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
            id={`invoice-number-${caseId}`}
            label={dict.labs.caseFields.invoiceNumber}
          >
            <Input
              id={`invoice-number-${caseId}`}
              value={invoiceNumber}
              onChange={(event) => setInvoiceNumber(event.target.value)}
              disabled={submitting}
              dir="ltr"
            />
          </FormField>
          <FormField
            id={`invoice-amount-${caseId}`}
            label={dict.labs.caseFields.invoiceAmount}
            required
          >
            <Input
              id={`invoice-amount-${caseId}`}
              type="number"
              inputMode="decimal"
              step="0.01"
              min="0.01"
              dir="ltr"
              value={invoiceAmount}
              onChange={(event) => setInvoiceAmount(event.target.value)}
              disabled={submitting}
              required
            />
          </FormField>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={submitting}>
              {dict.common.cancel}
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? <LoaderCircleIcon className="animate-spin" aria-hidden="true" /> : null}
              {dict.common.save}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
