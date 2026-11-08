import {isFiniteCephPoint,MEASUREMENTS,REQUIRED_LANDMARKS,type LandmarkCode,type LandmarkMap,type MeasurementResult} from './ceph';

export interface CephCalculationReadiness {
  ready:boolean;
  calibrationValid:boolean;
  missingRequired:LandmarkCode[];
  invalidLandmarks:LandmarkCode[];
  invalidResults:boolean;
  unavailable:string[];
  optionalMissing:{code:string;landmarks:LandmarkCode[]}[];
}

/** Current-draft computational gate, not a clinical judgment or authorization.
 * Consume the already computed results; never recompute or upgrade sealed history.
 * Missing optional inputs are allowed. Supplied inputs with unavailable results are
 * not assigned a guessed anatomical cause. Calibration provenance, manual review,
 * source identity and authority remain separate completion requirements.
 */
export function assessCephCalculationReadiness(
  landmarks:LandmarkMap,mmPerPixel:number,
  results:readonly Pick<MeasurementResult,'code'|'value'>[],
):CephCalculationReadiness {
  const calibrationValid=Number.isFinite(mmPerPixel)&&mmPerPixel>0;
  const missingRequired=REQUIRED_LANDMARKS.filter(code=>landmarks[code]==null);
  const invalidLandmarks=(Object.keys(landmarks) as LandmarkCode[])
    .filter(code=>landmarks[code]!=null&&!isFiniteCephPoint(landmarks[code]));
  const definitions=new Map(MEASUREMENTS.map(definition=>[definition.code,definition]));
  const resultCodes=new Set<string>();
  let invalidResults=false;
  for(const result of results){
    const definition=definitions.get(result.code);
    if(!definition||resultCodes.has(result.code)
      ||(result.value!=null&&(!Number.isFinite(result.value)
        ||!definition.needs.every(code=>landmarks[code]!=null)))) invalidResults=true;
    resultCodes.add(result.code);
  }
  const unavailable=MEASUREMENTS.filter(definition=>definition.needs.every(code=>landmarks[code]!=null)
    &&!Number.isFinite(results.find(result=>result.code===definition.code)?.value)).map(definition=>definition.code);
  const required=new Set<LandmarkCode>(REQUIRED_LANDMARKS);
  const optionalMissing=MEASUREMENTS.flatMap(definition=>{
    const missing=definition.needs.filter(code=>landmarks[code]==null&&!required.has(code));
    return missing.length?[{code:definition.code,landmarks:missing}]:[];
  });
  return {ready:calibrationValid&&!missingRequired.length&&!invalidLandmarks.length&&!invalidResults&&!unavailable.length,
    calibrationValid,missingRequired,invalidLandmarks,invalidResults,unavailable,optionalMissing};
}
