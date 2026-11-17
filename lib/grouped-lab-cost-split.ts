/** 0136: one grouped order's cost split over its members' doctors by each tooth's price weight (equal weights
 * when none is known), largest remainder first — the parts always add up to the order's cost exactly. Members
 * without a doctor carry no share. */
export function splitGroupedLabCost(costMinor: number, members: readonly { doctorId: number | null; weight: string | number }[]) {
  const withDoctor = members.filter((member): member is { doctorId: number; weight: string | number } => member.doctorId !== null);
  if (!withDoctor.length || costMinor <= 0) return [];
  const weights = withDoctor.map((member) => Math.max(0, Number(member.weight) || 0));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const effective = total > 0 ? weights : weights.map(() => 1);
  const effectiveTotal = effective.reduce((sum, weight) => sum + weight, 0);
  const raw = effective.map((weight) => Math.floor((costMinor * weight) / effectiveTotal));
  let remainder = costMinor - raw.reduce((sum, part) => sum + part, 0);
  const order = effective.map((_, index) => index).sort((a, b) => effective[b] - effective[a] || a - b);
  for (let i = 0; remainder > 0; i = (i + 1) % order.length) { raw[order[i]] += 1; remainder -= 1; }
  const byDoctor = new Map<number, number>();
  withDoctor.forEach((member, index) => byDoctor.set(member.doctorId, (byDoctor.get(member.doctorId) ?? 0) + raw[index]));
  return [...byDoctor].map(([doctorId, part]) => ({ doctorId, costMinor: part })).filter((part) => part.costMinor > 0);
}
