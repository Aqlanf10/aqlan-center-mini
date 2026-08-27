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
  createServiceAction,
  createServiceCategoryAction,
  setServiceActiveAction,
  setServiceCategoryActiveAction,
  updateServiceAction,
  updateServiceCategoryAction,
} from "@/server/services/actions";

const CURRENCIES: Currency[] = ["YER", "SAR", "USD"];

export type ServiceFormValues = {
  code: string;
  nameAr: string;
  nameEn: string;
  categoryId: string;
  defaultPrice: string;
  currency: Currency;
  commissionEligible: "yes" | "no";
  defaultCommissionType: "" | "PERCENT" | "FIXED";
  defaultCommissionValue: string;
};

export function ServiceDialog({
  categories,
  service,
}: {
  categories: { id: string; label: string }[];
  service?: { id: string } & ServiceFormValues;
}) {
  const { dict } = useI18n();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const [values, setValues] = useState<ServiceFormValues>(
    service ?? {
      code: "",
      nameAr: "",
      nameEn: "",
      categoryId: "",
      defaultPrice: "",
      currency: "YER",
      commissionEligible: "no",
      defaultCommissionType: "",
      defaultCommissionValue: "",
    }
  );

  function set<K extends keyof ServiceFormValues>(key: K, value: ServiceFormValues[K]) {
    setValues((current) => ({ ...current, [key]: value }));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    setSubmitting(true);
    try {
      const result = service
        ? await updateServiceAction(service.id, values as unknown as Record<string, string>)
        : await createServiceAction(values as unknown as Record<string, string>);
      if (result.ok) {
        toast.success(dictPath(dict, result.messageKey));
        setOpen(false);
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
        <Button variant={service ? "outline" : "default"} size={service ? "sm" : "default"}>
          {service ? null : <PlusIcon aria-hidden="true" />}
          {service ? dict.common.edit : dict.services.newService}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{dict.services.newService}</DialogTitle>
          <DialogDescription>{dict.services.subtitle}</DialogDescription>
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
            <FormField id={`service-code-${service?.id ?? "new"}`} label={dict.services.fields.code} required error={errorFor("code")}>
              <Input
                id={`service-code-${service?.id ?? "new"}`}
                value={values.code}
                onChange={(event) => set("code", event.target.value)}
                disabled={submitting}
                dir="ltr"
                required
              />
            </FormField>
            <FormField id={`service-category-${service?.id ?? "new"}`} label={dict.services.fields.category}>
              <Select
                id={`service-category-${service?.id ?? "new"}`}
                value={values.categoryId}
                onChange={(event) => set("categoryId", event.target.value)}
                disabled={submitting}
              >
                <option value="">{dict.common.select}</option>
                {categories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.label}
                  </option>
                ))}
              </Select>
            </FormField>
          </div>

          <FormField id={`service-name-ar-${service?.id ?? "new"}`} label={dict.services.fields.nameAr} required error={errorFor("nameAr")}>
            <Input
              id={`service-name-ar-${service?.id ?? "new"}`}
              value={values.nameAr}
              onChange={(event) => set("nameAr", event.target.value)}
              disabled={submitting}
              required
            />
          </FormField>

          <FormField id={`service-name-en-${service?.id ?? "new"}`} label={dict.services.fields.nameEn} required error={errorFor("nameEn")}>
            <Input
              id={`service-name-en-${service?.id ?? "new"}`}
              value={values.nameEn}
              onChange={(event) => set("nameEn", event.target.value)}
              disabled={submitting}
              dir="ltr"
              required
            />
          </FormField>

          <div className="grid grid-cols-2 gap-3">
            <FormField id={`service-price-${service?.id ?? "new"}`} label={dict.services.fields.defaultPrice} error={errorFor("defaultPrice")}>
              <Input
                id={`service-price-${service?.id ?? "new"}`}
                type="number"
                inputMode="decimal"
                step="0.01"
                min="0"
                dir="ltr"
                value={values.defaultPrice}
                onChange={(event) => set("defaultPrice", event.target.value)}
                disabled={submitting}
              />
            </FormField>
            <FormField id={`service-currency-${service?.id ?? "new"}`} label={dict.services.fields.currency} required>
              <Select
                id={`service-currency-${service?.id ?? "new"}`}
                value={values.currency}
                onChange={(event) => set("currency", event.target.value as Currency)}
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

          <FormField id={`service-commission-${service?.id ?? "new"}`} label={dict.services.fields.commissionEligible} required>
            <Select
              id={`service-commission-${service?.id ?? "new"}`}
              value={values.commissionEligible}
              onChange={(event) =>
                set("commissionEligible", event.target.value as "yes" | "no")
              }
              disabled={submitting}
            >
              <option value="no">{dict.common.no}</option>
              <option value="yes">{dict.common.yes}</option>
            </Select>
          </FormField>

          {values.commissionEligible === "yes" ? (
            <div className="grid grid-cols-2 gap-3">
              <FormField id={`service-comm-type-${service?.id ?? "new"}`} label={dict.services.fields.defaultCommissionType}>
                <Select
                  id={`service-comm-type-${service?.id ?? "new"}`}
                  value={values.defaultCommissionType}
                  onChange={(event) =>
                    set("defaultCommissionType", event.target.value as "" | "PERCENT" | "FIXED")
                  }
                  disabled={submitting}
                >
                  <option value="">{dict.common.select}</option>
                  <option value="PERCENT">{dict.services.commissionTypes.PERCENT}</option>
                  <option value="FIXED">{dict.services.commissionTypes.FIXED}</option>
                </Select>
              </FormField>
              <FormField id={`service-comm-value-${service?.id ?? "new"}`} label={dict.services.fields.defaultCommissionValue}>
                <Input
                  id={`service-comm-value-${service?.id ?? "new"}`}
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  min="0"
                  dir="ltr"
                  value={values.defaultCommissionValue}
                  onChange={(event) => set("defaultCommissionValue", event.target.value)}
                  disabled={submitting}
                />
              </FormField>
            </div>
          ) : null}

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

export function ServiceCategoryDialog({
  category,
}: {
  category?: { id: string; nameAr: string; nameEn: string; sortOrder: number };
}) {
  const { dict } = useI18n();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [nameAr, setNameAr] = useState(category?.nameAr ?? "");
  const [nameEn, setNameEn] = useState(category?.nameEn ?? "");
  const [sortOrder, setSortOrder] = useState(String(category?.sortOrder ?? 100));

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    setSubmitting(true);
    try {
      const result = category
        ? await updateServiceCategoryAction(category.id, { nameAr, nameEn, sortOrder })
        : await createServiceCategoryAction({ nameAr, nameEn, sortOrder });
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
          {category ? dict.common.edit : dict.services.newCategory}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>
            {category ? dict.services.editCategory : dict.services.newCategory}
          </DialogTitle>
          <DialogDescription>{dict.services.subtitle}</DialogDescription>
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
          <FormField id={`category-name-ar-${category?.id ?? "new"}`} label={dict.suppliers.fields.nameAr} required>
            <Input
              id={`category-name-ar-${category?.id ?? "new"}`}
              value={nameAr}
              onChange={(event) => setNameAr(event.target.value)}
              disabled={submitting}
              required
            />
          </FormField>
          <FormField id={`category-name-en-${category?.id ?? "new"}`} label={dict.suppliers.fields.nameEn} required>
            <Input
              id={`category-name-en-${category?.id ?? "new"}`}
              value={nameEn}
              onChange={(event) => setNameEn(event.target.value)}
              disabled={submitting}
              dir="ltr"
              required
            />
          </FormField>
          <FormField id={`category-sort-${category?.id ?? "new"}`} label={dict.services.fields.sortOrder}>
            <Input
              id={`category-sort-${category?.id ?? "new"}`}
              type="number"
              dir="ltr"
              value={sortOrder}
              onChange={(event) => setSortOrder(event.target.value)}
              disabled={submitting}
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

export function ServiceActiveButton({
  serviceId,
  active,
}: {
  serviceId: string;
  active: boolean;
}) {
  const { dict } = useI18n();
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function handleToggle() {
    setPending(true);
    try {
      const result = await setServiceActiveAction(serviceId, !active);
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

export function ServiceCategoryActiveButton({
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
      const result = await setServiceCategoryActiveAction(categoryId, !active);
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
