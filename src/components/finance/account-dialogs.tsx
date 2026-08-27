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
import {
  createCashAccountAction,
  setCashAccountActiveAction,
  updateCashAccountAction,
} from "@/server/finance/account-actions";

const CURRENCIES: Currency[] = ["YER", "SAR", "USD"];

export function CashAccountDialog({
  account,
  buttonLabel,
  variant,
}: {
  account?: { id: string; name: string; type: "CASH" | "BANK" };
  buttonLabel: string;
  variant?: "default" | "outline";
}) {
  const { dict } = useI18n();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const [name, setName] = useState(account?.name ?? "");
  const [currency, setCurrency] = useState<Currency>("YER");
  const [type, setType] = useState<"CASH" | "BANK">(account?.type ?? "CASH");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    setSubmitting(true);
    try {
      const result = account
        ? await updateCashAccountAction(account.id, { name, currency, type })
        : await createCashAccountAction({ name, currency, type });
      if (result.ok) {
        toast.success(dictPath(dict, result.messageKey));
        setOpen(false);
        setName("");
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
        <Button variant={variant ?? "default"} size={account ? "sm" : "default"}>
          {account ? null : <PlusIcon aria-hidden="true" />}
          {buttonLabel}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{dict.financeAccounts.newAccount}</DialogTitle>
          <DialogDescription>
            {dict.financeAccounts.cashAccountsSubtitle}
          </DialogDescription>
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
            id={`account-name-${account?.id ?? "new"}`}
            label={dict.financeAccounts.fields.name}
            required
            error={errorFor("name")}
          >
            <Input
              id={`account-name-${account?.id ?? "new"}`}
              value={name}
              onChange={(event) => setName(event.target.value)}
              disabled={submitting}
              required
            />
          </FormField>
          {!account ? (
            <FormField
              id="account-currency"
              label={dict.financeAccounts.fields.currency}
              required
              error={errorFor("currency")}
            >
              <Select
                id="account-currency"
                value={currency}
                onChange={(event) => setCurrency(event.target.value as Currency)}
                disabled={submitting}
              >
                {CURRENCIES.map((code) => (
                  <option key={code} value={code}>
                    {code}
                  </option>
                ))}
              </Select>
            </FormField>
          ) : null}
          <FormField id="account-type" label={dict.financeAccounts.fields.type} required>
            <Select
              id="account-type"
              value={type}
              onChange={(event) => setType(event.target.value as "CASH" | "BANK")}
              disabled={submitting}
            >
              <option value="CASH">{dict.financeAccounts.types.CASH}</option>
              <option value="BANK">{dict.financeAccounts.types.BANK}</option>
            </Select>
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

/** Archive / reactivate toggle (server action, no client state). */
export function CashAccountActiveButton({
  accountId,
  active,
}: {
  accountId: string;
  active: boolean;
}) {
  const { dict } = useI18n();
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function handleToggle() {
    setPending(true);
    try {
      const result = await setCashAccountActiveAction(accountId, !active);
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
    <Button
      variant="outline"
      size="sm"
      onClick={handleToggle}
      disabled={pending}
    >
      {active ? dict.financeAccounts.archive : dict.financeAccounts.reactivate}
    </Button>
  );
}

/** Expense category create/edit dialog. */
export function ExpenseCategoryDialog({
  category,
  buttonLabel,
}: {
  category?: { id: string; nameAr: string; nameEn: string };
  buttonLabel: string;
}) {
  const { dict } = useI18n();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [nameAr, setNameAr] = useState(category?.nameAr ?? "");
  const [nameEn, setNameEn] = useState(category?.nameEn ?? "");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    setSubmitting(true);
    try {
      const { createExpenseCategoryAction, updateExpenseCategoryAction } = await import(
        "@/server/finance/account-actions"
      );
      const result = category
        ? await updateExpenseCategoryAction(category.id, { nameAr, nameEn })
        : await createExpenseCategoryAction({ nameAr, nameEn });
      if (result.ok) {
        toast.success(dictPath(dict, result.messageKey));
        setOpen(false);
        setNameAr("");
        setNameEn("");
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
        <Button variant={category ? "outline" : "default"} size={category ? "sm" : "default"}>
          {category ? null : <PlusIcon aria-hidden="true" />}
          {buttonLabel}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{dict.financeAccounts.newCategory}</DialogTitle>
          <DialogDescription>
            {dict.financeAccounts.expenseCategoriesSubtitle}
          </DialogDescription>
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
            id={`category-ar-${category?.id ?? "new"}`}
            label={dict.financeAccounts.fieldsCategory.nameAr}
            required
          >
            <Input
              id={`category-ar-${category?.id ?? "new"}`}
              value={nameAr}
              onChange={(event) => setNameAr(event.target.value)}
              disabled={submitting}
              required
            />
          </FormField>
          <FormField
            id={`category-en-${category?.id ?? "new"}`}
            label={dict.financeAccounts.fieldsCategory.nameEn}
            required
          >
            <Input
              id={`category-en-${category?.id ?? "new"}`}
              value={nameEn}
              onChange={(event) => setNameEn(event.target.value)}
              disabled={submitting}
              required
              dir="ltr"
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

export function ExpenseCategoryActiveButton({
  categoryId,
  active,
}: {
  categoryId: string;
  active: boolean;
}) {
  const { dict } = useI18n();
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function handleToggle() {
    setPending(true);
    try {
      const { setExpenseCategoryActiveAction } = await import(
        "@/server/finance/account-actions"
      );
      const result = await setExpenseCategoryActiveAction(categoryId, !active);
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
