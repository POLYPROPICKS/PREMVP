export type StakeReferencePolicyId="CONTROL_ACTIVE3_SHRINKING_V1"|"UTC_DAY_FIXED_MAX3_V1"|"GLOBAL_INITIAL_FIXED_MAX3_V1"|"MINSK_NIGHT_FIXED_MAX3_V1";
export interface StakeReferenceSchedule{policyId:StakeReferencePolicyId;maximumStake:(decisionAtMs:number,realizedActiveEquity:number)=>number;referenceFor:(decisionAtMs:number,realizedActiveEquity:number)=>number;globalComparisonCounts:()=>{exceededCurrentThreePct:number;belowCurrentThreePct:number}}
const round=(x:number)=>Math.round(x*1e8)/1e8;
function minskParts(ms:number){const parts=new Intl.DateTimeFormat("en-CA",{timeZone:"Europe/Minsk",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",hourCycle:"h23"}).formatToParts(ms);const get=(type:string)=>parts.find(x=>x.type===type)?.value??"";return{date:`${get("year")}-${get("month")}-${get("day")}`,hour:Number(get("hour"))}}
function previousDate(date:string){const ms=Date.parse(`${date}T00:00:00Z`)-86_400_000;return new Date(ms).toISOString().slice(0,10)}
export function minskNightKey(ms:number):string{const p=minskParts(ms);return p.hour>=18?p.date:previousDate(p.date)}
export function isInsideMinskOperationalWindow(ms:number):boolean{const h=minskParts(ms).hour;return h>=18||h<9}
export function utcDayKey(ms:number):string{return new Date(ms).toISOString().slice(0,10)}
export function createStakeReferenceSchedule(policyId:StakeReferencePolicyId,initialActiveBankroll:number):StakeReferenceSchedule{
  const references=new Map<string,number>();let exceeded=0,below=0,calls=0;
  const referenceFor=(decisionAtMs:number,active:number)=>{let reference:number;if(policyId==="CONTROL_ACTIVE3_SHRINKING_V1")reference=active;else if(policyId==="GLOBAL_INITIAL_FIXED_MAX3_V1")reference=initialActiveBankroll;else{const key=policyId==="UTC_DAY_FIXED_MAX3_V1"?utcDayKey(decisionAtMs):minskNightKey(decisionAtMs);if(!references.has(key))references.set(key,active);reference=references.get(key)!}if(policyId==="GLOBAL_INITIAL_FIXED_MAX3_V1"&&calls++>0){const fixed=.03*reference,current=.03*active;if(fixed>current+1e-9)exceeded++;else if(fixed<current-1e-9)below++}return reference};
  return{policyId,referenceFor,maximumStake:(ms,active)=>round(.03*referenceFor(ms,active)),globalComparisonCounts:()=>({exceededCurrentThreePct:exceeded,belowCurrentThreePct:below})};
}
