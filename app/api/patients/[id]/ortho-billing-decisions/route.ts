import {NextResponse} from 'next/server';
import {requireSession} from '@/lib/session';
import {getSessionBillingReview,SessionBillingReviewError} from '@/lib/ortho-session-billing-review';
export const dynamic='force-dynamic';
const headers={'Cache-Control':'private, no-store','Vary':'Cookie'};
export async function GET(request:Request,context:{params:Promise<{id:string}>}){
 const session=await requireSession();if(!session)return NextResponse.json({message:'انتهت الجلسة.'},{status:401,headers});
 const id=(await context.params).id,query=new URL(request.url).searchParams,caseId=query.get('orthoCaseId');
 if(!/^[1-9]\d*$/.test(id)||!caseId||!/^[1-9]\d*$/.test(caseId)||[...query.keys()].length!==1||!Number.isSafeInteger(Number(id))||!Number.isSafeInteger(Number(caseId)))return NextResponse.json({message:'مرجع غير صالح.'},{status:400,headers});
 try{return NextResponse.json(await getSessionBillingReview({session,patientId:Number(id),orthoCaseId:Number(caseId)}),{headers});}
 catch(error){return NextResponse.json({message:'تعذّر قراءة قرارات الجلسات.'},{status:error instanceof SessionBillingReviewError?error.status:500,headers});}
}
