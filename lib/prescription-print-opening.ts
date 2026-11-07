/** Opening a saved record never issues a second prescription. The URL contains
 * only verified positive record identifiers, never patient-authored draft text. */
export function openSavedPrescriptionPrint(patientId:number,prescriptionId:number,open:(url:string,target:string)=>unknown):{url:string;opened:boolean}|null {
 if(!Number.isSafeInteger(patientId)||patientId<=0||!Number.isSafeInteger(prescriptionId)||prescriptionId<=0)return null;
 const url=`/print/prescription/${patientId}?rx=${prescriptionId}`;
 try{return {url,opened:!!open(url,'_blank')};}catch{return {url,opened:false};}
}
