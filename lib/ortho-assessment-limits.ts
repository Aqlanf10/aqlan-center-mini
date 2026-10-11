/** Canonical server admission bounds. Raising these requires a reviewed resource
 * budget change; no request or environment value can disable them. Limits refuse
 * the whole read/write, never return a truncated history as a complete record. */
export const ASSESSMENT_HISTORY_MAX_REVISIONS=5000;
export const ASSESSMENT_HISTORY_MAX_BYTES=8*1024*1024;
export const ASSESSMENT_SOURCE_GRAPH_MAX_BYTES=4*1024*1024;
export const ASSESSMENT_EXTERNAL_SOURCE_MAX_BYTES=4*1024*1024;
export const ASSESSMENT_CEPH_SOURCE_MAX_CHILD_ROWS=2048;
export function assessmentStoredByteCount(value:unknown):number|null{
  if(typeof value!=="string"||!/^(0|[1-9]\d{0,15})$/.test(value))return null;
  const count=Number(value);return Number.isSafeInteger(count)&&count>=0?count:null;
}
