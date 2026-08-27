"use client";

import { useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { LoaderCircleIcon, PlusIcon, TrashIcon } from "lucide-react";
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
  cancelPurchaseInvoiceAction,
  createMaterialAction,
  createPurchaseInvoiceAction,
  createSupplierAction,
  setMaterialActiveAction,
  setSupplierActiveAction,
  updateMaterialAction,
  updateSupplierAction,
} from "@/server/suppliers/actions";

const CURRENCIES: Currency[] = ["YER", "SAR", "USD"];

export function SupplierDialog({
  supplier,
  buttonLabel,
}: {
  supplier?: {
    id: string;
    name: string;
    phone: string | null;
    address: string | null;
    notes: string | null;
  };
  buttonLabel: string;
}) {
  const { dict } = useI18n();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [name, setName] = useState(supplier?.name ?? "");
  const [phone, setPhone] = useState(supplier?.phone ?? "");
  const [address, setAddress] = useState(supplier?.address ?? "");
  const [notes, setNotes] = useState(supplier?.notes ?? "");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    setSubmitting(true);
    try {
      const result = supplier
        ? await updateSupplierAction(supplier.id, { name, phone, address, notes })
        : await createSupplierAction({ name, phone, address, notes });
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
        <Button variant={supplier ? "outline" : "default"} size={supplier ? "sm" : "default"}>
          {supplier ? null : <PlusIcon aria-hidden="true" />}
          {buttonLabel}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{dict.suppliers.newSupplier}</DialogTitle>
          <DialogDescription>{dict.suppliers.subtitle}</DialogDescription>
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
          <FormField id={`supplier-name-${supplier?.id ?? "new"}`} label={dict.suppliers.fields.name} required>
            <Input
              id={`supplier-name-${supplier?.id ?? "new"}`}
              value={name}
              onChange={(event) => setName(event.target.value)}
              disabled={submitting}
              required
            />
          </FormField>
          <FormField id={`supplier-phone-${supplier?.id ?? "new"}`} label={dict.suppliers.fields.phone}>
            <Input
              id={`supplier-phone-${supplier?.id ?? "new"}`}
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              disabled={submitting}
              dir="ltr"
            />
          </FormField>
          <FormField id={`supplier-address-${supplier?.id ?? "new"}`} label={dict.suppliers.fields.address}>
            <Input
              id={`supplier-address-${supplier?.id ?? "new"}`}
              value={address}
              onChange={(event) => setAddress(event.target.value)}
              disabled={submitting}
            />
          </FormField>
          <FormField id={`supplier-notes-${supplier?.id ?? "new"}`} label={dict.suppliers.fields.notes}>
            <Textarea
              id={`supplier-notes-${supplier?.id ?? "new"}`}
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

export function SupplierActiveButton({
  supplierId,
  active,
}: {
  supplierId: string;
  active: boolean;
}) {
  const { dict } = useI18n();
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function handleToggle() {
    setPending(true);
    try {
      const result = await setSupplierActiveAction(supplierId, !active);
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

export function MaterialDialog({
  material,
  suppliers,
  buttonLabel,
}: {
  material?: {
    id: string;
    code: string;
    nameAr: string;
    nameEn: string;
    unit: string | null;
    defaultSupplierId: string | null;
  };
  suppliers: { id: string; label: string }[];
  buttonLabel: string;
}) {
  const { dict } = useI18n();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [code, setCode] = useState(material?.code ?? "");
  const [nameAr, setNameAr] = useState(material?.nameAr ?? "");
  const [nameEn, setNameEn] = useState(material?.nameEn ?? "");
  const [unit, setUnit] = useState(material?.unit ?? "");
  const [defaultSupplierId, setDefaultSupplierId] = useState(material?.defaultSupplierId ?? "");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    setSubmitting(true);
    try {
      const result = material
        ? await updateMaterialAction(material.id, {
            code,
            nameAr,
            nameEn,
            unit,
            defaultSupplierId,
          })
        : await createMaterialAction({ code, nameAr, nameEn, unit, defaultSupplierId });
      if (result.ok) {
        toast.success(dictPath(dict, result.messageKey));
        setOpen(false);
        setCode("");
        setNameAr("");
        setNameEn("");
        setUnit("");
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
        <Button variant={material ? "outline" : "default"} size={material ? "sm" : "default"}>
          {material ? null : <PlusIcon aria-hidden="true" />}
          {buttonLabel}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{dict.suppliers.newMaterial}</DialogTitle>
          <DialogDescription>{dict.suppliers.subtitle}</DialogDescription>
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
          <FormField id={`material-code-${material?.id ?? "new"}`} label={dict.suppliers.fields.code} required>
            <Input
              id={`material-code-${material?.id ?? "new"}`}
              value={code}
              onChange={(event) => setCode(event.target.value)}
              disabled={submitting}
              dir="ltr"
              required
            />
          </FormField>
          <FormField id={`material-ar-${material?.id ?? "new"}`} label={dict.suppliers.fields.nameAr} required>
            <Input
              id={`material-ar-${material?.id ?? "new"}`}
              value={nameAr}
              onChange={(event) => setNameAr(event.target.value)}
              disabled={submitting}
              required
            />
          </FormField>
          <FormField id={`material-en-${material?.id ?? "new"}`} label={dict.suppliers.fields.nameEn} required>
            <Input
              id={`material-en-${material?.id ?? "new"}`}
              value={nameEn}
              onChange={(event) => setNameEn(event.target.value)}
              disabled={submitting}
              dir="ltr"
              required
            />
          </FormField>
          <div className="grid grid-cols-2 gap-3">
            <FormField id={`material-unit-${material?.id ?? "new"}`} label={dict.suppliers.fields.unit}>
              <Input
                id={`material-unit-${material?.id ?? "new"}`}
                value={unit}
                onChange={(event) => setUnit(event.target.value)}
                disabled={submitting}
              />
            </FormField>
            <FormField
              id={`material-supplier-${material?.id ?? "new"}`}
              label={dict.suppliers.fields.defaultSupplier}
            >
              <Select
                id={`material-supplier-${material?.id ?? "new"}`}
                value={defaultSupplierId}
                onChange={(event) => setDefaultSupplierId(event.target.value)}
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
          </div>
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

export function MaterialActiveButton({
  materialId,
  active,
}: {
  materialId: string;
  active: boolean;
}) {
  const { dict } = useI18n();
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function handleToggle() {
    setPending(true);
    try {
      const result = await setMaterialActiveAction(materialId, !active);
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

type InvoiceLine = {
  materialId: string;
  quantity: string;
  unitPrice: string;
  discount: string;
};

/** Multi-line purchase invoice dialog with a server-computed total. */
export function PurchaseInvoiceDialog({
  suppliers,
  materials,
}: {
  suppliers: { id: string; label: string }[];
  materials: { id: string; label: string }[];
}) {
  const { dict } = useI18n();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [supplierId, setSupplierId] = useState("");
  const [supplierRef, setSupplierRef] = useState("");
  const [currency, setCurrency] = useState<Currency>("YER");
  const [invoiceDate, setInvoiceDate] = useState("");
  const [lines, setLines] = useState<InvoiceLine[]>([
    { materialId: "", quantity: "1", unitPrice: "", discount: "" },
  ]);

  const idempotencyKey = useRef(crypto.randomUUID());

  function setLine(index: number, patch: Partial<InvoiceLine>) {
    setLines((current) =>
      current.map((line, i) => (i === index ? { ...line, ...patch } : line))
    );
  }

  const linesTotalMinor = lines.reduce((sum, line) => {
    const qty = Math.round(parseFloat(line.quantity || "0") * 100);
    const price = Math.round(parseFloat(line.unitPrice || "0") * 100);
    const discount = Math.round(parseFloat(line.discount || "0") * 100);
    return sum + Math.max(Math.round((qty * price) / 100) - discount, 0);
  }, 0);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    const validLines = lines.filter((line) => line.materialId && line.unitPrice);
    if (validLines.length === 0) {
      setFormError(dictPath(dict, "suppliers.errors.itemsRequired"));
      return;
    }
    setSubmitting(true);
    try {
      const result = await createPurchaseInvoiceAction({
        supplierId,
        supplierRef,
        currency,
        invoiceDate,
        items: validLines,
      } as unknown as Record<string, string> & {
        items?: { materialId: string; quantity: string; unitPrice: string; discount?: string }[];
      });
      if (result.ok) {
        toast.success(dictPath(dict, result.messageKey));
        setOpen(false);
        setSupplierId("");
        setSupplierRef("");
        setInvoiceDate("");
        setLines([{ materialId: "", quantity: "1", unitPrice: "", discount: "" }]);
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
        <Button>
          <PlusIcon aria-hidden="true" />
          {dict.suppliers.newInvoice}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{dict.suppliers.newInvoice}</DialogTitle>
          <DialogDescription>{dict.suppliers.subtitle}</DialogDescription>
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

          <div className="grid gap-3 sm:grid-cols-2">
            <FormField id="invoice-supplier" label={dict.suppliers.fields.supplier} required>
              <Select
                id="invoice-supplier"
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
            <FormField id="invoice-currency" label={dict.financeVouchers.fields.currency} required>
              <Select
                id="invoice-currency"
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

          <div className="grid gap-3 sm:grid-cols-2">
            <FormField id="invoice-ref" label={dict.suppliers.fields.supplierRef}>
              <Input
                id="invoice-ref"
                value={supplierRef}
                onChange={(event) => setSupplierRef(event.target.value)}
                disabled={submitting}
                dir="ltr"
              />
            </FormField>
            <FormField id="invoice-date" label={dict.suppliers.fields.invoiceDate}>
              <Input
                id="invoice-date"
                type="date"
                value={invoiceDate}
                onChange={(event) => setInvoiceDate(event.target.value)}
                disabled={submitting}
              />
            </FormField>
          </div>

          {/* Invoice lines */}
          <div className="space-y-3">
            {lines.map((line, index) => (
              <div key={index} className="rounded-lg border p-3">
                <div className="grid gap-2 sm:grid-cols-2">
                  <FormField
                    id={`line-material-${index}`}
                    label={dict.suppliers.invoiceFields.material}
                    required
                  >
                    <Select
                      id={`line-material-${index}`}
                      value={line.materialId}
                      onChange={(event) => setLine(index, { materialId: event.target.value })}
                      disabled={submitting}
                    >
                      <option value="">{dict.common.select}</option>
                      {materials.map((material) => (
                        <option key={material.id} value={material.id}>
                          {material.label}
                        </option>
                      ))}
                    </Select>
                  </FormField>
                  <div className="grid grid-cols-3 gap-2">
                    <FormField id={`line-qty-${index}`} label={dict.suppliers.invoiceFields.quantity} required>
                      <Input
                        id={`line-qty-${index}`}
                        type="number"
                        inputMode="decimal"
                        step="0.01"
                        min="0.01"
                        dir="ltr"
                        value={line.quantity}
                        onChange={(event) => setLine(index, { quantity: event.target.value })}
                        disabled={submitting}
                      />
                    </FormField>
                    <FormField id={`line-price-${index}`} label={dict.suppliers.invoiceFields.unitPrice} required>
                      <Input
                        id={`line-price-${index}`}
                        type="number"
                        inputMode="decimal"
                        step="0.01"
                        min="0.01"
                        dir="ltr"
                        value={line.unitPrice}
                        onChange={(event) => setLine(index, { unitPrice: event.target.value })}
                        disabled={submitting}
                      />
                    </FormField>
                    <FormField id={`line-discount-${index}`} label={dict.suppliers.invoiceFields.discount}>
                      <Input
                        id={`line-discount-${index}`}
                        type="number"
                        inputMode="decimal"
                        step="0.01"
                        min="0"
                        dir="ltr"
                        value={line.discount}
                        onChange={(event) => setLine(index, { discount: event.target.value })}
                        disabled={submitting}
                      />
                    </FormField>
                  </div>
                </div>
                {lines.length > 1 ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="mt-2"
                    onClick={() =>
                      setLines((current) => current.filter((_, i) => i !== index))
                    }
                    disabled={submitting}
                  >
                    <TrashIcon aria-hidden="true" />
                    {dict.common.cancel}
                  </Button>
                ) : null}
              </div>
            ))}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                setLines((current) => [
                  ...current,
                  { materialId: "", quantity: "1", unitPrice: "", discount: "" },
                ])
              }
              disabled={submitting}
            >
              <PlusIcon aria-hidden="true" />
              {dict.suppliers.invoiceFields.addItem}
            </Button>
          </div>

          <p className="text-sm font-semibold" dir="ltr">
            {dict.suppliers.invoiceFields.linesTotal}: {(linesTotalMinor / 100).toFixed(2)}{" "}
            {currency}
          </p>

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

export function CancelInvoiceButton({ invoiceId }: { invoiceId: string }) {
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
      const result = await cancelPurchaseInvoiceAction(invoiceId, { reason });
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
          {dict.suppliers.cancelInvoice}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{dict.suppliers.cancelInvoiceTitle}</DialogTitle>
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
          <FormField id={`cancel-reason-${invoiceId}`} label={dict.financeVouchers.reversalReason} required>
            <Textarea
              id={`cancel-reason-${invoiceId}`}
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
              {dict.common.confirm}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
