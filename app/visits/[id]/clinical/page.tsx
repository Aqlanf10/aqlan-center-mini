import { notFound, redirect } from "next/navigation";

/** Compatibility for previously emitted timeline links; the canonical visit owns all UI and authorization. */
export default async function LegacyClinicalVisitPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))) notFound();
  redirect(`/visits/${id}`);
}
