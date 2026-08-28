"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { LoaderCircleIcon, PlusIcon, StethoscopeIcon } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { FormField, dictPath } from "@/components/shared/form-field";
import { Select } from "@/components/shared/select";
import { useI18n } from "@/i18n/provider";
import type { Currency } from "@/db/schema/enums";
import {
  addWorkItemAction,
  cancelWorkItemAction,
  updateWorkItemAction,
} from "@/server/services/actions";

const CURRENCIES: Currency[] = ["YER", "SAR", "USD"];

export type WorkItemRowClient = {
  id: string;
  serviceId: string;
  serviceLabel: string;
  doctorId: string;
  doctorName: string;
  quantity: string;
  unitPrice: string;
  discount: string;
  total: string;
  currency: Currency;
  notes: string | null;
  status: string;
};

export type WorkItemSource = {
  services: { id: string; label: string; defaultPrice: string | null; currency: Currency }[];
  doctors: { id: string; label: string }[];
};

/**
 * Work items editor for a visit. Draft visits allow add/edit/cancel;
 * completed visits render read-only (locked) — enforced server-side too.
 */
export function VisitWorkItems({
  visitId,
  items,
  source,
  locked,
  canEdit,
}: {
  visitId: string;
  items: WorkItemRowClient[];
  source: WorkItemSource;
  locked: boolean;
  /** DOCTOR may only record own items; ADMIN may edit all (server-enforced). */
  canEdit: boolean;
}) {
  const { dict } = useI18n();
  const [dialogItem, setDialogItem] = useState<WorkItemRowClient | null>(null);
  const [open, setOpen] = useState(false);

  function openNew() {
    setDialogItem(null);
    setOpen(true);
  }

  function openEdit(item: WorkItemRowClient) {
    setDialogItem(item);
    setOpen(true);
  }

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold">{dict.workItems.title}</h2>
          <p className="text-muted-foreground text-sm">{dict.workItems.subtitle}</p>
        </div>
        {!locked && canEdit ? (
          <Button onClick={openNew}>
            <PlusIcon aria-hidden="true" />
            {dict.workItems.addItem}
          </Button>
        ) : null}
      </div>

      {locked ? (
        <p className="text-muted-foreground bg-muted/40 rounded-lg border border-dashed px-3 py-2 text-sm">
          {dict.workItems.lockedHint}
        </p>
      ) : null}

      {items.length === 0 ? (
        <div className="bg-muted/50 flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed p-6 text-center">
          <StethoscopeIcon className="text-muted-foreground size-6" aria-hidden="true" />
          <p className="text-sm font-medium">{dict.workItems.empty}</p>
          <p className="text-muted-foreground text-xs">{dict.workItems.emptyHint}</p>
        </div>
      ) : (
        <div className="bg-card overflow-x-auto rounded-xl border">
          <table className="w-full min-w-[760px] text-sm">
            <thead className="text-muted-foreground bg-muted/50 border-b">
              <tr>
                <th className="px-3 py-2.5 text-start font-medium">
                  {dict.workItems.columns.service}
                </th>
                <th className="px-3 py-2.5 text-start font-medium">
                  {dict.workItems.columns.doctor}
                </th>
                <th className="px-3 py-2.5 text-start font-medium">
                  {dict.workItems.columns.quantity}
                </th>
                <th className="px-3 py-2.5 text-start font-medium">
                  {dict.workItems.columns.price}
                </th>
                <th className="px-3 py-2.5 text-start font-medium">
                  {dict.workItems.columns.discount}
                </th>
                <th className="px-3 py-2.5 text-start font-medium">
                  {dict.workItems.columns.total}
                </th>
                <th className="px-3 py-2.5 text-start font-medium">
                  {dict.workItems.columns.status}
                </th>
                {!locked && canEdit ? (
                  <th className="px-3 py-2.5 text-start font-medium">{dict.common.actions}</th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id} className="border-b last:border-0">
                  <td className="px-3 py-2.5 font-medium">{item.serviceLabel}</td>
                  <td className="px-3 py-2.5">{item.doctorName}</td>
                  <td className="px-3 py-2.5" dir="ltr">
                    {item.quantity}
                  </td>
                  <td className="px-3 py-2.5" dir="ltr">
                    {item.unitPrice}
                  </td>
                  <td className="px-3 py-2.5" dir="ltr">
                    {item.discount}
                  </td>
                  <td className="px-3 py-2.5 font-semibold" dir="ltr">
                    {item.total} {item.currency}
                  </td>
                  <td className="px-3 py-2.5">
                    {item.status === "CANCELLED" ? (
                      <span className="text-destructive text-xs font-medium">
                        {dict.workItems.statuses.CANCELLED}
                      </span>
                    ) : (
                      <span className="text-xs font-medium">{dict.workItems.statuses.ACTIVE}</span>
                    )}
                  </td>
                  {!locked && canEdit ? (
                    <td className="px-3 py-2.5">
                      <div className="flex flex-wrap gap-1.5">
                        {item.status === "ACTIVE" ? (
                          <>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => openEdit(item)}
                            >
                              {dict.common.edit}
                            </Button>
                            <CancelWorkItemButton visitId={visitId} workItemId={item.id} />
                          </>
                        ) : null}
                      </div>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!locked && canEdit ? (
        <WorkItemDialog
          visitId={visitId}
          source={source}
          item={dialogItem}
          open={open}
          onOpenChange={setOpen}
        />
      ) : null}
    </section>
  );
}

function CancelWorkItemButton({
  visitId,
  workItemId,
}: {
  visitId: string;
  workItemId: string;
}) {
  const { dict } = useI18n();
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function handleCancel() {
    setPending(true);
    try {
      const result = await cancelWorkItemAction(workItemId, visitId);
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
    <Button variant="outline" size="sm" onClick={handleCancel} disabled={pending}>
      {dict.workItems.cancelItem}
    </Button>
  );
}

function WorkItemDialog({
  visitId,
  source,
  item,
  open,
  onOpenChange,
}: {
  visitId: string;
  source: WorkItemSource;
  item: WorkItemRowClient | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { dict } = useI18n();
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const [serviceId, setServiceId] = useState(item?.serviceId ?? "");
  const [doctorId, setDoctorId] = useState(item?.doctorId ?? "");
  const [quantity, setQuantity] = useState(item?.quantity ?? "1");
  const [unitPrice, setUnitPrice] = useState(item?.unitPrice ?? "");
  const [discount, setDiscount] = useState(item?.discount ?? "");
  const [currency, setCurrency] = useState<Currency>(item?.currency ?? "YER");
  const [notes, setNotes] = useState(item?.notes ?? "");

  function handleServiceChange(nextServiceId: string) {
    setServiceId(nextServiceId);
    const service = source.services.find((entry) => entry.id === nextServiceId);
    if (service) {
      if (service.defaultPrice) {
        setUnitPrice(service.defaultPrice);
      }
      setCurrency(service.currency);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    setSubmitting(true);
    try {
      const result = item
        ? await updateWorkItemAction(item.id, visitId, {
            serviceId,
            doctorId,
            quantity,
            unitPrice,
            discount,
            currency,
            notes,
          })
        : await addWorkItemAction(visitId, {
            serviceId,
            doctorId,
            quantity,
            unitPrice,
            discount,
            currency,
            notes,
          });
      if (result.ok) {
        toast.success(dictPath(dict, result.messageKey));
        onOpenChange(false);
        setFieldErrors({});
        setNotes("");
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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {item ? dict.workItems.editItem : dict.workItems.addItem}
          </DialogTitle>
          <DialogDescription>{dict.workItems.subtitle}</DialogDescription>
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
            id={`work-service-${item?.id ?? "new"}`}
            label={dict.workItems.fields.service}
            required
            error={errorFor("serviceId")}
          >
            <Select
              id={`work-service-${item?.id ?? "new"}`}
              value={serviceId}
              onChange={(event) => handleServiceChange(event.target.value)}
              disabled={submitting}
            >
              <option value="">{dict.common.select}</option>
              {source.services.map((service) => (
                <option key={service.id} value={service.id}>
                  {service.label}
                </option>
              ))}
            </Select>
          </FormField>

          <FormField
            id={`work-doctor-${item?.id ?? "new"}`}
            label={dict.workItems.fields.doctor}
            required
            error={errorFor("doctorId")}
          >
            <Select
              id={`work-doctor-${item?.id ?? "new"}`}
              value={doctorId}
              onChange={(event) => setDoctorId(event.target.value)}
              disabled={submitting}
            >
              <option value="">{dict.common.select}</option>
              {source.doctors.map((doctor) => (
                <option key={doctor.id} value={doctor.id}>
                  {doctor.label}
                </option>
              ))}
            </Select>
          </FormField>

          <div className="grid grid-cols-2 gap-3">
            <FormField
              id={`work-quantity-${item?.id ?? "new"}`}
              label={dict.workItems.fields.quantity}
              required
              error={errorFor("quantity")}
            >
              <Input
                id={`work-quantity-${item?.id ?? "new"}`}
                type="number"
                inputMode="decimal"
                step="0.01"
                min="0.01"
                dir="ltr"
                value={quantity}
                onChange={(event) => setQuantity(event.target.value)}
                disabled={submitting}
                required
              />
            </FormField>
            <FormField
              id={`work-price-${item?.id ?? "new"}`}
              label={dict.workItems.fields.unitPrice}
              required
              error={errorFor("unitPrice")}
            >
              <Input
                id={`work-price-${item?.id ?? "new"}`}
                type="number"
                inputMode="decimal"
                step="0.01"
                min="0.01"
                dir="ltr"
                value={unitPrice}
                onChange={(event) => setUnitPrice(event.target.value)}
                disabled={submitting}
                required
              />
            </FormField>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <FormField
              id={`work-discount-${item?.id ?? "new"}`}
              label={dict.workItems.fields.discount}
              error={errorFor("discount")}
            >
              <Input
                id={`work-discount-${item?.id ?? "new"}`}
                type="number"
                inputMode="decimal"
                step="0.01"
                min="0"
                dir="ltr"
                value={discount}
                onChange={(event) => setDiscount(event.target.value)}
                disabled={submitting}
              />
            </FormField>
            <FormField id={`work-currency-${item?.id ?? "new"}`} label={dict.financeVouchers.fields.currency} required>
              <Select
                id={`work-currency-${item?.id ?? "new"}`}
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
          </div>

          <FormField id={`work-notes-${item?.id ?? "new"}`} label={dict.workItems.fields.notes}>
            <Textarea
              id={`work-notes-${item?.id ?? "new"}`}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              disabled={submitting}
              rows={2}
            />
          </FormField>

          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
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
