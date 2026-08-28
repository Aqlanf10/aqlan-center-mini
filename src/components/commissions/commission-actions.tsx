"use client";

import { useRef, useState, type FormEvent } from "react";
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
import { Textarea } from "@/components/ui/textarea";
import { FormField, dictPath } from "@/components/shared/form-field";
import { Select } from "@/components/shared/select";
import { useI18n } from "@/i18n/provider";
import {
  approveCommissionAction,
  payCommissionAction,
  reverseCommissionAction,
  setCommissionAmountAction,
} from "@/server/commissions/actions";
import type { CashAccountOption } from "@/components/finance/voucher-dialogs";

/** Set amount (PENDING with no plan) — ADMIN. */
export function CommissionSetAmountButton({ commissionId }: { commissionId: string }) {
  const { dict } = useI18n();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    setSubmitting(true);
    try {
      const result = await setCommissionAmountAction(commissionId, { amount });
      if (result.ok) {
        toast.success(dictPath(dict, result.messageKey));
        setOpen(false);
        setAmount("");
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
          {dict.commissions.setAmount}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{dict.commissions.setAmountTitle}</DialogTitle>
          <DialogDescription>{dict.commissions.needsPlan}</DialogDescription>
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
          <FormField id={`amount-${commissionId}`} label={dict.commissions.fields.amount} required>
            <Input
              id={`amount-${commissionId}`}
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

/** Approve (PENDING → APPROVED) — ADMIN, one click. */
export function CommissionApproveButton({ commissionId }: { commissionId: string }) {
  const { dict } = useI18n();
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function handleApprove() {
    setPending(true);
    try {
      const result = await approveCommissionAction(commissionId);
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
    <Button variant="outline" size="sm" onClick={handleApprove} disabled={pending}>
      {dict.commissions.approve}
    </Button>
  );
}

/** Pay via payment voucher (APPROVED → PAID) — ADMIN. */
export function CommissionPayButton({
  commissionId,
  cashAccounts,
}: {
  commissionId: string;
  cashAccounts: CashAccountOption[];
}) {
  const { dict } = useI18n();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [cashAccountId, setCashAccountId] = useState("");
  const [paymentMethod, setPaymentMethod] = useState("CASH");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const idempotencyKey = useRef(crypto.randomUUID());

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    setSubmitting(true);
    try {
      const result = await payCommissionAction(commissionId, {
        cashAccountId,
        paymentMethod,
        idempotencyKey: idempotencyKey.current,
      });
      if (result.ok) {
        toast.success(dictPath(dict, result.messageKey));
        setOpen(false);
        idempotencyKey.current = crypto.randomUUID();
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
        <Button size="sm">{dict.commissions.pay}</Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{dict.commissions.payTitle}</DialogTitle>
          <DialogDescription>{dict.financeVouchers.reversalHint}</DialogDescription>
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
          <FormField id={`pay-account-${commissionId}`} label={dict.commissions.fields.cashAccount} required>
            <Select
              id={`pay-account-${commissionId}`}
              value={cashAccountId}
              onChange={(event) => setCashAccountId(event.target.value)}
              disabled={submitting}
            >
              <option value="">{dict.common.select}</option>
              {cashAccounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.name} ({account.currency})
                </option>
              ))}
            </Select>
          </FormField>
          <FormField id={`pay-method-${commissionId}`} label={dict.commissions.fields.paymentMethod} required>
            <Select
              id={`pay-method-${commissionId}`}
              value={paymentMethod}
              onChange={(event) => setPaymentMethod(event.target.value)}
              disabled={submitting}
            >
              {["CASH", "TRANSFER", "CARD", "OTHER"].map((method) => (
                <option key={method} value={method}>
                  {dict.financeVouchers.paymentMethods[method as "CASH"]}
                </option>
              ))}
            </Select>
          </FormField>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={submitting}>
              {dict.common.cancel}
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? <LoaderCircleIcon className="animate-spin" aria-hidden="true" /> : null}
              {dict.commissions.pay}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Reverse (PENDING/APPROVED → REVERSED) with mandatory reason. */
export function CommissionReverseButton({ commissionId }: { commissionId: string }) {
  const { dict } = useI18n();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    setSubmitting(true);
    try {
      const result = await reverseCommissionAction(commissionId, { reason });
      if (result.ok) {
        toast.success(dictPath(dict, result.messageKey));
        setOpen(false);
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
          {dict.commissions.reverse}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{dict.commissions.reverseTitle}</DialogTitle>
          <DialogDescription>{dict.financeVouchers.reversalHint}</DialogDescription>
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
          <FormField id={`reverse-reason-${commissionId}`} label={dict.commissions.reason} required>
            <Textarea
              id={`reverse-reason-${commissionId}`}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              disabled={submitting}
              rows={2}
              required
            />
          </FormField>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={submitting}>
              {dict.common.cancel}
            </Button>
            <Button type="submit" variant="destructive" disabled={submitting}>
              {submitting ? <LoaderCircleIcon className="animate-spin" aria-hidden="true" /> : null}
              {dict.commissions.reverse}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
