import { hrStaffHistoryGet, hrStaffHistoryPost } from '@/lib/hr-temporal-http';
import { requireSession } from '@/lib/session';
export const dynamic = 'force-dynamic';
export const GET = async (request: Request, context: { params: Promise<{ id: string }> }) => hrStaffHistoryGet(request, context, 'employment', await requireSession());
export const POST = async (request: Request, context: { params: Promise<{ id: string }> }) => hrStaffHistoryPost(request, context, 'employment', await requireSession());
