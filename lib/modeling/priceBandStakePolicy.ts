import type { StakeTier } from "./stakeCalibration";
export const PRICE_BANDS=["0.30_0.40","0.40_0.50","0.50_0.60","0.60_0.70","0.70_1.00"] as const;
export type PriceBand=typeof PRICE_BANDS[number];export type PriceBandMapping=Record<PriceBand,StakeTier>;
export interface PriceBandTrainingRow{price:number;pnlPerMaximum:number;nightKey:string}
export function priceBandOf(price:number):PriceBand|null{if(price>=.3&&price<.4)return"0.30_0.40";if(price>=.4&&price<.5)return"0.40_0.50";if(price>=.5&&price<.6)return"0.50_0.60";if(price>=.6&&price<.7)return"0.60_0.70";if(price>=.7&&price<=1)return"0.70_1.00";return null}
export function enumeratePriceBandMappings(tiers:readonly StakeTier[]):PriceBandMapping[]{const out:PriceBandMapping[]=[];for(const a of tiers)for(const b of tiers)for(const c of tiers)for(const d of tiers)for(const e of tiers)out.push({"0.30_0.40":a,"0.40_0.50":b,"0.50_0.60":c,"0.60_0.70":d,"0.70_1.00":e});return out}
export function mappingPnl(rows:readonly PriceBandTrainingRow[],mapping:PriceBandMapping):number{return rows.reduce((sum,row)=>{const band=priceBandOf(row.price);return sum+(band?row.pnlPerMaximum*mapping[band]:0)},0)}
export function selectPriceBandMappingPastOnly(trainingRows:readonly PriceBandTrainingRow[],tiers:readonly StakeTier[]):PriceBandMapping{return enumeratePriceBandMappings(tiers).sort((a,b)=>mappingPnl(trainingRows,b)-mappingPnl(trainingRows,a)||PRICE_BANDS.reduce((s,k)=>s+Math.abs(1-a[k]),0)-PRICE_BANDS.reduce((s,k)=>s+Math.abs(1-b[k]),0)||JSON.stringify(a).localeCompare(JSON.stringify(b)))[0]}
