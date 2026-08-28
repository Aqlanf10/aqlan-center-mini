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
import { FormField, dictPath } from "@/components/shared/form-field";
import { Select } from "@/components/shared/select";
import { useI18n } from "@/i18n/provider";
import type { Currency } from "@/db/schema/enums";
import { createChargeAction, createPaymentAction } from "@/server/finance/actions";

const CURRENCIES: Currency[] = ["YER", "SAR", "USD"];

function FinanceDialog({
  kind,
  patientId,
}: {
  kind: "charge" | "payment";
  patientId: string;
}) {
  const { dict } = useI18n();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState<Currency>("YER");
  const [description, setDescription] = useState("");

  const isCharge = kind === "charge";

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    setSubmitting(true);
    try {
      const result = isCharge
        ? await createChargeAction({ patientId, amount, currency, description })
        : await createPaymentAction({ patientId, amount, currency, description });
      if (result.ok) {
        toast.success(dictPath(dict, result.messageKey));
        setOpen(false);
        setAmount("");
        setDescription("");
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
        <Button variant={isCharge ? "default" : "outline"}>
          <PlusIcon aria-hidden="true" />
          {isCharge ? dict.finance.addCharge : dict.finance.addPayment}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>
            {isCharge ? dict.finance.addCharge : dict.finance.addPayment}
          </DialogTitle>
          <DialogDescription>{dict.finance.title}</DialogDescription>
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

          <div className="grid grid-cols-2 gap-3">
            <FormField
              id={`finance-amount-${kind}`}
              label={dict.finance.fields.amount}
              required
              error={errorFor("amount")}
            >
              <Input
                id={`finance-amount-${kind}`}
                type="number"
                inputMode="decimal"
                step="0.01"
                min="0.01"
                dir="ltr"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                disabled={submitting}
                required
              />
            </FormField>
            <FormField
              id={`finance-currency-${kind}`}
              label={dict.finance.fields.currency}
              required
              error={errorFor("currency")}
            >
              <Select
                id={`finance-currency-${kind}`}
                value={currency}
                onChange={(event) => setCurrency(event.target.value as Currency)}
                disabled={submitting}
                options={CURRENCIES.map((value) => ({ value, label: value }))}
              />
            </FormField>
          </div>

          <FormField
            id={`finance-desc-${kind}`}
            label={dict.finance.fields.description}
            required={isCharge}
            error={errorFor("description")}
          >
            <Input
              id={`finance-desc-${kind}`}
              value={description}
              placeholder={dict.finance.fields.descriptionPlaceholder}
              onChange={(event) => setDescription(event.target.value)}
              disabled={submitting}
              required={isCharge}
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

export function ChargeFormDialog({ patientId }: { patientId: string }) {
  return <FinanceDialog kind="charge" patientId={patientId} />;
}

export function PaymentFormDialog({ patientId }: { patientId: string }) {
  return <FinanceDialog kind="payment" patientId={patientId} />;
}
