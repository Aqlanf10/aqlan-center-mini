import { beforeEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { decodeLeadershipPulse, leadershipVisitHref, leadershipWaitingMinutes, parsePulseQuery, type LeadershipPulse } from "../lib/leadership-pulse";
import { apiRouteVerdict } from "../lib/http-permissions";
const deps=vi.hoisted(()=>({session:vi.fn(),read:vi.fn(),pool:{}}));
vi.mock("../lib/session",()=>({requireSession:deps.session}));
vi.mock("../lib/db",()=>({CLINIC_TIME_ZONE:"Asia/Aden",getPool:()=>deps.pool}));
vi.mock("../lib/leadership-pulse-db",()=>({readLeadershipPulse:deps.read}));
import { GET } from "../app/api/executive/pulse/route";
const get=(query="")=>GET(new Request(`http://localhost/api/executive/pulse?${query}`));
export const emptyPulse=():LeadershipPulse=>({view:"day",scope:"selected_arrival_day",day:"2026-10-25",today:"2026-10-25",timeZone:"Asia/Aden",asOf:"2026-10-25T10:00:00Z",
 counts:{arrived:0,waiting:0,called:0,inChair:0,done:0,appointments:0,noShow:0,cancelled:0},total:0,page:0,hasMore:false,items:[]});
beforeEach(()=>{vi.clearAllMocks();deps.session.mockResolvedValue({userId:7,username:"synthetic",role:"admin"});deps.read.mockResolvedValue(emptyPulse());});
it.each([null,"doctor","reception","cashier","accountant","assistant","manager"])("denies %s before reading",async role=>{
 deps.session.mockResolvedValue(role?{role}:null);expect((await get()).status).toBe(role?403:401);expect(deps.read).not.toHaveBeenCalled();
});
it("registers only existing admin oversight",()=>{expect(apiRouteVerdict("/api/executive/pulse","GET")).toMatchObject({access:["admin"]});expect(apiRouteVerdict("/api/executive","GET")).toMatchObject({access:["admin","doctor"]});});
it.each(["day=2026-02-30","view=all","page=-1","page=1000000","day=2026-10-25&day=2026-10-26","view=tasks&day=2026-10-25","owner=3"])("rejects malformed or misleading scope %s",async q=>{expect((await get(q)).status).toBe(400);expect(deps.read).not.toHaveBeenCalled();});
it("returns exact scope with private no-store and current-principal recheck",async()=>{const r=await get("view=day&day=2026-10-25&page=2");expect(r.status).toBe(200);expect(r.headers.get("cache-control")).toBe("private, no-store");expect(deps.read).toHaveBeenCalledWith(deps.pool,{view:"day",day:"2026-10-25",page:2},"Asia/Aden",{userId:7,username:"synthetic",role:"admin"});expect(deps.session).toHaveBeenCalledTimes(2);});
it.each([null,{userId:8,username:"synthetic",role:"admin"},{userId:7,username:"other",role:"admin"},{userId:7,username:"synthetic",role:"doctor"}])("clears data when the current principal changes",async current=>{deps.session.mockResolvedValueOnce({userId:7,username:"synthetic",role:"admin"}).mockResolvedValueOnce(current);const r=await get();expect(r.status).toBe(401);expect(await r.json()).not.toHaveProperty("counts");});
it("reports unknown on source failure, never a successful zero",async()=>{deps.read.mockRejectedValue(new Error("private detail"));const r=await get();expect(r.status).toBe(503);expect(await r.text()).not.toContain("private detail");});
it("uses clinic day and exact temporal scope",()=>{expect(parsePulseQuery(new URLSearchParams(),new Date("2026-10-24T22:00:00Z"),"Asia/Aden")?.day).toBe("2026-10-25");expect(decodeLeadershipPulse(emptyPulse(),"day","2026-10-25")).not.toBeNull();expect(decodeLeadershipPulse(emptyPulse(),"day","2026-10-24")).toBeNull();});
it("rejects inconsistent counts, pages, identities and malformed source clocks",()=>{for(const patch of [{total:1},{page:1},{hasMore:true},{asOf:"bad"},{today:"2026-10-24"},{counts:{...emptyPulse().counts,waiting:1}},{items:[{id:1}]}])expect(decodeLeadershipPulse({...emptyPulse(),...patch},"day",null)).toBeNull();});
it("does not use the current clinical visit tab for historical cohort links",()=>{expect(leadershipVisitHref({id:8,patientId:2})).toBe("/patients/2?tab=summary");expect(leadershipVisitHref({id:8,patientId:null})).toBe("/visits/8");});
it("keeps the projection read-only with bounded enrichment and no financial readers",()=>{const s=readFileSync("lib/leadership-pulse-db.ts","utf8");expect(s).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|ALTER|ensureSchema|payments|invoices|journalEntries)\b/);expect(s).toContain("LIMIT $4");expect(s).toContain("NOT is_private OR owner_user_id=$5");});
it("preserves the application shell and lazy financial/attendance sources",()=>{const page=readFileSync("app/executive/page.tsx","utf8"),read=readFileSync("components/leadership/useLeadershipRead.ts","utf8");expect(page).toContain('section === "finance"');expect(page).toContain('dynamic(');expect(page).toContain('key={`${session.username}:${session.role}`}');expect(read).not.toMatch(/setInterval|localStorage|sessionStorage/);expect(page).not.toContain('AppShell');});

it("does not turn future or invalid arrival timestamps into zero waiting",()=>{expect(leadershipWaitingMinutes("2026-10-25T12:00:00Z","2026-10-25T11:59:00Z")).toBeNull();expect(leadershipWaitingMinutes("bad","2026-10-25T12:00:00Z")).toBeNull();expect(leadershipWaitingMinutes("2026-10-25T11:15:00Z","2026-10-25T12:00:00Z")).toBe(45);});
