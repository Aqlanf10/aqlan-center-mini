import type { CatalogMedication } from '@/lib/medication-catalog';

/** Read-before-copy preview only. Empty values never become prescription defaults. */
export function CatalogMedicationPreview({entry}:{entry:CatalogMedication}){
 const fields=[['مقدار الجرعة ووحدتها',entry.amount],['التكرار والفاصل',entry.frequency],['المدة وخطة المراجعة',entry.duration],['التعليمات بالعربية',entry.instructionsAr],['التعليمات بالإنجليزية',entry.instructionsEn]];
 return <div className="my-2 rounded bg-slate-50 p-3" data-catalog-preview="manual"><p className="font-medium">قالب المركز قابل للتعديل — غير محسوب؛ راجعه لهذا المريض</p><dl className="mt-2 space-y-2">{fields.map(([label,value])=><div key={label}><dt className="font-medium">{label}</dt><dd className="whitespace-pre-wrap break-words"><bdi>{value||'يحدده الطبيب قبل الإصدار'}</bdi></dd></div>)}</dl></div>;
}
