import type { Pool } from "pg";
export const SYNTHETIC_PLAN_TEMPLATES = [{ id: "syn_template", specialty: "تقويم اصطناعي", name: "قالب خطة اصطناعي", description: "SYN current catalogue description",
  steps: [{ key: "syn_step", title: "خطوة علاج اصطناعية", category: "SYN-therapy", preferredService: "خدمة اصطناعية", perTooth: false, optional: false, billingRule: "per_session", labWork: false,
    sessions: [{ title: "جلسة اصطناعية أولى", minutes: 30, afterDays: 0 }, { title: "جلسة اصطناعية ثانية", minutes: 20, afterDays: 7 }] }] }];
export async function seedCanonicalPlanTemplateCatalog(q: Pick<Pool, "query">) {
  await q.query("UPDATE services SET is_active=FALSE");
  const service = (await q.query("INSERT INTO services(name,category,price_minor,price_sar_minor,price_usd_minor,is_active,sort_order,price_configured,price_provisional) VALUES('خدمة اصطناعية','SYN-therapy',9900123,8800123,7700123,TRUE,1,TRUE,TRUE) RETURNING id")).rows[0].id;
  const inactive = (await q.query("INSERT INTO services(name,category,price_minor,is_active,sort_order) VALUES('SYN inactive private service','SYN inactive',6600123,FALSE,2) RETURNING id")).rows[0].id;
  await q.query("INSERT INTO settings(key,value) VALUES('plans.specialty_templates',$1) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [JSON.stringify(SYNTHETIC_PLAN_TEMPLATES)]);
  await q.query("INSERT INTO settings(key,value) VALUES('SYN.private.setting','SYN private setting payload') ON CONFLICT(key) DO UPDATE SET value=excluded.value");
  return { service: Number(service), inactive: Number(inactive) };
}
