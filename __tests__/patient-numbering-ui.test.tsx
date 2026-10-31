import {existsSync,readFileSync} from "node:fs";
import React from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {beforeEach,expect,it,vi} from "vitest";
const auth=vi.hoisted(()=>({session:null as null|{role:string;username:string}}));
vi.mock("../components/SessionProvider",()=>({useSession:()=>auth.session}));
import PatientNumberingPage from "../app/settings/patient-numbering/page";
beforeEach(()=>{auth.session=null;});
it.each([null,"doctor","reception","assistant","cashier","accountant"])("does not render future-floor controls for %s",role=>{
 auth.session=role?{role,username:"synthetic"}:null;
 expect(renderToStaticMarkup(<PatientNumberingPage/>)).toContain("لا توجد صلاحية");
});
it("explains future-only floor and fixed P-prefix without claiming an unverified next number",()=>{
 auth.session={role:"admin",username:"synthetic"};const html=renderToStaticMarkup(<PatientNumberingPage/>);
 expect(html).toContain('dir="rtl"');expect(html).toContain("P-07000");expect(html).toContain("لا يعيد هذا الإعداد ترقيم المرضى السابقين");expect(html).toContain("تحديث المعاينة");
});
it("does not ship or mount an existing-patient number editor",()=>{
 const source=readFileSync("app/patients/[id]/page.tsx","utf8");
 expect(source).not.toContain("PatientNumberEditor");
 expect(existsSync("components/patient/PatientNumberEditor.tsx")).toBe(false);
});
it("binds settings drafts to session ownership and fences queued loads during save",()=>{
 const settings=readFileSync("app/settings/patient-numbering/page.tsx","utf8");
 expect(settings).toContain('key={JSON.stringify([session.username, session.role, session.permissions ?? null])}');
 expect(settings).toContain('const load = useCallback(async () => {\n    if (saving.current) return;');
});
