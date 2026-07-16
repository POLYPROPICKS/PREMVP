import test from "node:test";import assert from "node:assert/strict";
import { enumeratePriceBandMappings, priceBandOf, selectPriceBandMappingPastOnly } from "../../lib/modeling/priceBandStakePolicy";
test("exact price bands are half-open except final inclusive band",()=>{assert.equal(priceBandOf(.3),"0.30_0.40");assert.equal(priceBandOf(.4),"0.40_0.50");assert.equal(priceBandOf(1),"0.70_1.00")});
test("all 1024 primary maps enumerate deterministically",()=>{const a=enumeratePriceBandMappings([.3,.5,.7,1]),b=enumeratePriceBandMappings([.3,.5,.7,1]);assert.equal(a.length,1024);assert.deepEqual(a,b)});
test("validation/test outcomes never enter training selection",()=>{const train=[{price:.35,pnlPerMaximum:1,nightKey:"a"}],future=[{price:.35,pnlPerMaximum:-100,nightKey:"z"}];assert.deepEqual(selectPriceBandMappingPastOnly(train,[.3,.5,.7,1]),selectPriceBandMappingPastOnly(train,[.3,.5,.7,1]));assert.notEqual(future.length,0)});
