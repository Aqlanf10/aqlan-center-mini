"use client";

import { useMemo, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { LoaderCircleIcon, PlusIcon, PrinterIcon } from "lucide-react";
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
import type { Currency } from "@/db/schema/enums";
import {
  createPaymentVoucherAction,
  createReceiptVoucherAction,
  reverseVoucherAction,
} from "@/server/finance/voucher-actions";

const CURRENCIES: Currency[] = ["YER", "SAR", "USD"];
const PAYMENT_METHODS = ["CASH", "TRANSFER", "CARD", "OTHER"] as const;

export type CashAccountOption = {
  id: string;
  name: string;
  currency: Currency;
};

export type PatientOption = { id: string; label: string };
export type DoctorOption = { id: string; label: string };
export type LabOption = { id: string; label: string };
export type SupplierOption = { id: string; label: string };
export type ExpenseCategoryOption = { id: string; nameAr: string; nameEn: string };

/**
 * Receipt voucher dialog (سند قبض). Generates an idempotency key per logical
 * submission — a double click or retry never creates a duplicate voucher.
 */
export function ReceiptVoucherDialog({
  cashAccounts,
  patients,
  fixedPatientId,
  fixedPatientLabel,
}: {
  cashAccounts: CashAccountOption[];
  patients: PatientOption[];
  fixedPatientId?: string;
  fixedPatientLabel?: string;
}) {
  const { dict } = useI18n();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const [patientId, setPatientId] = useState(fixedPatientId ?? "");
  const [otherPartyName, setOtherPartyName] = useState("");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState<Currency>("YER");
  const [cashAccountId, setCashAccountId] = useState("");
  const [paymentMethod, setPaymentMethod] =
    useState<(typeof PAYMENT_METHODS)[number]>("CASH");
  const [description, setDescription] = useState("");
  const [reference, setReference] = useState("");

  const idempotencyKey = useRef(crypto.randomUUID());
  const accountsForCurrency = useMemo(
    () => cashAccounts.filter((account) => account.currency === currency),
    [cashAccounts, currency]
  );

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    setSubmitting(true);
    try {
      const result = await createReceiptVoucherAction({
        patientId,
        otherPartyName,
        amount,
        currency,
        cashAccountId,
        paymentMethod,
        description,
        reference,
        idempotencyKey: idempotencyKey.current,
      });
      if (result.ok) {
        toast.success(dictPath(dict, result.messageKey));
        setOpen(false);
        setAmount("");
        setDescription("");
        setReference("");
        setFieldErrors({});
        // Fresh key for the NEXT logical submission.
        idempotencyKey.current = crypto.randomUUID();
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
        <Button>
          <PlusIcon aria-hidden="true" />
          {dict.financeVouchers.newReceipt}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{dict.financeVouchers.newReceipt}</DialogTitle>
          <DialogDescription>{dict.financeVouchers.receiptsSubtitle}</DialogDescription>
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

          {fixedPatientId ? (
            <p className="text-muted-foreground rounded-md border px-3 py-2 text-sm">
              {fixedPatientLabel ?? dict.financeVouchers.fields.patient}
            </p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField
                id="receipt-patient"
                label={dict.financeVouchers.fields.patient}
                error={errorFor("patientId")}
              >
                <Select
                  id="receipt-patient"
                  value={patientId}
                  onChange={(event) => setPatientId(event.target.value)}
                  disabled={submitting}
                >
                  <option value="">{dict.common.select}</option>
                  {patients.map((patient) => (
                    <option key={patient.id} value={patient.id}>
                      {patient.label}
                    </option>
                  ))}
                </Select>
              </FormField>
              <FormField
                id="receipt-other-party"
                label={`${dict.financeVouchers.fields.otherPartyName} (${dict.common.optional})`}
                error={errorFor("otherPartyName")}
              >
                <Input
                  id="receipt-other-party"
                  value={otherPartyName}
                  onChange={(event) => setOtherPartyName(event.target.value)}
                  disabled={submitting || Boolean(patientId)}
                />
              </FormField>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <FormField
              id="receipt-amount"
              label={dict.financeVouchers.fields.amount}
              required
              error={errorFor("amount")}
            >
              <Input
                id="receipt-amount"
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
              id="receipt-currency"
              label={dict.financeVouchers.fields.currency}
              required
              error={errorFor("currency")}
            >
              <Select
                id="receipt-currency"
                value={currency}
                onChange={(event) => {
                  setCurrency(event.target.value as Currency);
                  setCashAccountId("");
                }}
                disabled={submitting}
              >
                {CURRENCIES.map((code) => (
                  <option key={code} value={code}>
                    {code}
                  </option>
                ))}
              </Select>
            </FormField>
          </div>

          <FormField
            id="receipt-account"
            label={dict.financeVouchers.fields.cashAccount}
            required
            error={errorFor("cashAccountId")}
          >
            <Select
              id="receipt-account"
              value={cashAccountId}
              onChange={(event) => setCashAccountId(event.target.value)}
              disabled={submitting}
            >
              <option value="">{dict.common.select}</option>
              {accountsForCurrency.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.name} ({account.currency})
                </option>
              ))}
            </Select>
          </FormField>

          <FormField
            id="receipt-method"
            label={dict.financeVouchers.fields.paymentMethod}
            required
          >
            <Select
              id="receipt-method"
              value={paymentMethod}
              onChange={(event) =>
                setPaymentMethod(event.target.value as (typeof PAYMENT_METHODS)[number])
              }
              disabled={submitting}
            >
              {PAYMENT_METHODS.map((method) => (
                <option key={method} value={method}>
                  {dict.financeVouchers.paymentMethods[method]}
                </option>
              ))}
            </Select>
          </FormField>

          <FormField
            id="receipt-description"
            label={dict.financeVouchers.fields.description}
            error={errorFor("description")}
          >
            <Textarea
              id="receipt-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              disabled={submitting}
              rows={2}
            />
          </FormField>

          <FormField
            id="receipt-reference"
            label={dict.financeVouchers.fields.reference}
            error={errorFor("reference")}
          >
            <Input
              id="receipt-reference"
              value={reference}
              onChange={(event) => setReference(event.target.value)}
              disabled={submitting}
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
              ) : (
                <PlusIcon aria-hidden="true" />
              )}
              {dict.common.save}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Payment voucher dialog (سند صرف) — ADMIN only. */
export function PaymentVoucherDialog({
  cashAccounts,
  doctors,
  labs,
  suppliers,
  expenseCategories,
}: {
  cashAccounts: CashAccountOption[];
  doctors: DoctorOption[];
  labs: LabOption[];
  suppliers: SupplierOption[];
  expenseCategories: ExpenseCategoryOption[];
}) {
  const { dict } = useI18n();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const [partyType, setPartyType] = useState<"DOCTOR" | "LAB" | "SUPPLIER" | "OTHER">("OTHER");
  const [doctorId, setDoctorId] = useState("");
  const [labId, setLabId] = useState("");
  const [supplierId, setSupplierId] = useState("");
  const [otherPartyName, setOtherPartyName] = useState("");
  const [expenseCategoryId, setExpenseCategoryId] = useState("");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState<Currency>("YER");
  const [cashAccountId, setCashAccountId] = useState("");
  const [paymentMethod, setPaymentMethod] =
    useState<(typeof PAYMENT_METHODS)[number]>("CASH");
  const [description, setDescription] = useState("");
  const [reference, setReference] = useState("");

  const idempotencyKey = useRef(crypto.randomUUID());
  const accountsForCurrency = useMemo(
    () => cashAccounts.filter((account) => account.currency === currency),
    [cashAccounts, currency]
  );

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    setSubmitting(true);
    try {
      const result = await createPaymentVoucherAction({
        partyType,
        doctorId,
        labId,
        supplierId,
        otherPartyName,
        expenseCategoryId,
        amount,
        currency,
        cashAccountId,
        paymentMethod,
        description,
        reference,
        idempotencyKey: idempotencyKey.current,
      });
      if (result.ok) {
        toast.success(dictPath(dict, result.messageKey));
        setOpen(false);
        setAmount("");
        setDescription("");
        setReference("");
        setOtherPartyName("");
        setFieldErrors({});
        idempotencyKey.current = crypto.randomUUID();
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
        <Button>
          <PlusIcon aria-hidden="true" />
          {dict.financeVouchers.newPayment}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{dict.financeVouchers.newPayment}</DialogTitle>
          <DialogDescription>{dict.financeVouchers.vouchersSubtitle}</DialogDescription>
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
            id="payment-party-type"
            label={dict.financeVouchers.fields.partyType}
            required
            error={errorFor("partyType")}
          >
            <Select
              id="payment-party-type"
              value={partyType}
              onChange={(event) =>
                setPartyType(event.target.value as "DOCTOR" | "LAB" | "SUPPLIER" | "OTHER")
              }
              disabled={submitting}
            >
              <option value="OTHER">{dict.financeVouchers.fields.generalExpense}</option>
              <option value="DOCTOR">{dict.financeVouchers.fields.doctor}</option>
              <option value="LAB">{dict.financeVouchers.fields.lab}</option>
              <option value="SUPPLIER">{dict.financeVouchers.fields.supplier}</option>
            </Select>
          </FormField>

          {partyType === "DOCTOR" ? (
            <FormField
              id="payment-doctor"
              label={dict.financeVouchers.fields.doctor}
              required
              error={errorFor("doctorId")}
            >
              <Select
                id="payment-doctor"
                value={doctorId}
                onChange={(event) => setDoctorId(event.target.value)}
                disabled={submitting}
              >
                <option value="">{dict.common.select}</option>
                {doctors.map((doctor) => (
                  <option key={doctor.id} value={doctor.id}>
                    {doctor.label}
                  </option>
                ))}
              </Select>
            </FormField>
          ) : null}

          {partyType === "LAB" ? (
            <FormField
              id="payment-lab"
              label={dict.financeVouchers.fields.lab}
              required
              error={errorFor("labId")}
            >
              <Select
                id="payment-lab"
                value={labId}
                onChange={(event) => setLabId(event.target.value)}
                disabled={submitting}
              >
                <option value="">{dict.common.select}</option>
                {labs.map((lab) => (
                  <option key={lab.id} value={lab.id}>
                    {lab.label}
                  </option>
                ))}
              </Select>
            </FormField>
          ) : null}

          {partyType === "SUPPLIER" ? (
            <FormField
              id="payment-supplier"
              label={dict.financeVouchers.fields.supplier}
              required
              error={errorFor("supplierId")}
            >
              <Select
                id="payment-supplier"
                value={supplierId}
                onChange={(event) => setSupplierId(event.target.value)}
                disabled={submitting}
              >
                <option value="">{dict.common.select}</option>
                {suppliers.map((supplier) => (
                  <option key={supplier.id} value={supplier.id}>
                    {supplier.label}
                  </option>
                ))}
              </Select>
            </FormField>
          ) : null}

          {partyType === "OTHER" ? (
            <>
              <FormField
                id="payment-other-name"
                label={dict.financeVouchers.fields.otherPartyName}
                required
                error={errorFor("otherPartyName")}
              >
                <Input
                  id="payment-other-name"
                  value={otherPartyName}
                  onChange={(event) => setOtherPartyName(event.target.value)}
                  disabled={submitting}
                  required
                />
              </FormField>
              <FormField
                id="payment-expense-category"
                label={dict.financeVouchers.fields.expenseCategory}
                required
                error={errorFor("expenseCategoryId")}
              >
                <Select
                  id="payment-expense-category"
                  value={expenseCategoryId}
                  onChange={(event) => setExpenseCategoryId(event.target.value)}
                  disabled={submitting}
                >
                  <option value="">{dict.common.select}</option>
                  {expenseCategories.map((category) => (
                    <option key={category.id} value={category.id}>
                      {category.nameAr} — {category.nameEn}
                    </option>
                  ))}
                </Select>
              </FormField>
            </>
          ) : null}

          <div className="grid grid-cols-2 gap-3">
            <FormField
              id="payment-amount"
              label={dict.financeVouchers.fields.amount}
              required
              error={errorFor("amount")}
            >
              <Input
                id="payment-amount"
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
              id="payment-currency"
              label={dict.financeVouchers.fields.currency}
              required
              error={errorFor("currency")}
            >
              <Select
                id="payment-currency"
                value={currency}
                onChange={(event) => {
                  setCurrency(event.target.value as Currency);
                  setCashAccountId("");
                }}
                disabled={submitting}
              >
                {CURRENCIES.map((code) => (
                  <option key={code} value={code}>
                    {code}
                  </option>
                ))}
              </Select>
            </FormField>
          </div>

          <FormField
            id="payment-account"
            label={dict.financeVouchers.fields.cashAccount}
            required
            error={errorFor("cashAccountId")}
          >
            <Select
              id="payment-account"
              value={cashAccountId}
              onChange={(event) => setCashAccountId(event.target.value)}
              disabled={submitting}
            >
              <option value="">{dict.common.select}</option>
              {accountsForCurrency.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.name} ({account.currency})
                </option>
              ))}
            </Select>
          </FormField>

          <FormField id="payment-method" label={dict.financeVouchers.fields.paymentMethod} required>
            <Select
              id="payment-method"
              value={paymentMethod}
              onChange={(event) =>
                setPaymentMethod(event.target.value as (typeof PAYMENT_METHODS)[number])
              }
              disabled={submitting}
            >
              {PAYMENT_METHODS.map((method) => (
                <option key={method} value={method}>
                  {dict.financeVouchers.paymentMethods[method]}
                </option>
              ))}
            </Select>
          </FormField>

          <FormField
            id="payment-description"
            label={dict.financeVouchers.fields.description}
            error={errorFor("description")}
          >
            <Textarea
              id="payment-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              disabled={submitting}
              rows={2}
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
              ) : (
                <PlusIcon aria-hidden="true" />
              )}
              {dict.common.save}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Voucher reversal dialog (ADMIN) — mandatory reason, no history rewrite. */
export function VoucherReversalDialog({
  voucherId,
  voucherNumber,
  disabled,
  buttonLabel,
}: {
  voucherId: string;
  voucherNumber: string;
  disabled?: boolean;
  buttonLabel?: string;
}) {
  const { dict } = useI18n();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [reason, setReason] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!reason.trim()) {
      setFormError(dict.validation.required);
      return;
    }
    setFormError(null);
    setSubmitting(true);
    try {
      const result = await reverseVoucherAction(voucherId, { reason });
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
        <Button variant="outline" size="sm" disabled={disabled}>
          {buttonLabel ?? dict.financeVouchers.reverse}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {dict.financeVouchers.reversalTitle.replace("{number}", voucherNumber)}
          </DialogTitle>
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
          <FormField
            id={`reversal-reason-${voucherId}`}
            label={dict.financeVouchers.reversalReason}
            required
          >
            <Textarea
              id={`reversal-reason-${voucherId}`}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              disabled={submitting}
              rows={3}
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
            <Button type="submit" variant="destructive" disabled={submitting}>
              {submitting ? (
                <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
              ) : null}
              {dict.financeVouchers.reverse}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Print link (opens the print page in a new tab). */
export function VoucherPrintButton({ voucherId }: { voucherId: string }) {
  const { dict } = useI18n();
  return (
    <Button variant="outline" size="sm" asChild>
      <a href={`/print/receipts/${voucherId}`} target="_blank" rel="noopener noreferrer">
        <PrinterIcon aria-hidden="true" />
        {dict.financeVouchers.print}
      </a>
    </Button>
  );
}
