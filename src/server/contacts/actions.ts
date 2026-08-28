"use server";

import { revalidatePath } from "next/cache";

import { db } from "@/lib/db";
import { patientContacts } from "@/db/schema";
import { requireUser } from "@/lib/auth/guards";
import { contactFormSchema, validateWith } from "@/lib/validation";
import { AUDIT_ACTIONS, recordAudit } from "@/server/audit";
import { failure, success, type ActionResult } from "@/server/types";

/** Log a contact attempt (phone / WhatsApp / in person / other). */
export async function logContactAction(
  input: Record<string, string>
): Promise<ActionResult> {
  const user = await requireUser("/follow-up");

  const validation = validateWith(contactFormSchema, input);
  if (!validation.ok) {
    return failure("common.serverError", validation.errors);
  }
  const data = validation.data;

  try {
    const [created] = await db
      .insert(patientContacts)
      .values({
        patientId: data.patientId,
        userId: user.id,
        contactType: data.contactType,
        result: data.result,
        note: data.note ?? null,
        contactedAt: new Date(),
      })
      .returning({ id: patientContacts.id });
    if (!created) {
      return failure("followUp.contactDialog.failed");
    }

    await recordAudit({
      userId: user.id,
      action: AUDIT_ACTIONS.PATIENT_CONTACTED,
      entityType: "contact",
      entityId: created.id,
      metadata: {
        patientId: data.patientId,
        contactType: data.contactType,
        result: data.result,
      },
    });

    revalidatePath("/follow-up");
    revalidatePath(`/patients/${data.patientId}`);
    revalidatePath("/dashboard");
    return success("followUp.contactDialog.saved", created.id);
  } catch {
    return failure("followUp.contactDialog.failed");
  }
}
