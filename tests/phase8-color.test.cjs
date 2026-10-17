 'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const A=require('../src/shared/advanced-color.js');
const vm=require('node:vm');
const luminance=rgb=>rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722;
test('advanced defaults are exact identities, partial values are immutable and strict',()=>{
  assert.equal(A.validate(vm.runInNewContext('({exposureEV:1,hsl:{red:{hue:.5}}})')),true);
  assert.throws(()=>A.validate(new Date()));assert.throws(()=>A.validate(new (class Grade {})()));
  const input={temperature:.2,curves:{red:[[0,0],[.4,.3],[1,1]]}},before=JSON.stringify(input),normalized=A.normalize(input);
  assert.equal(JSON.stringify(input),before);normalized.curves.red[1][1]=.9;assert.equal(input.curves.red[1][1],.3);
  const f=A.createProcessor();for(let n=0;n<1000;n++){const rgb=[n/999,(n*37%1000)/999,(n*613%1000)/999];assert.deepEqual(f(rgb),rgb);assert.deepEqual(A.adjustRgb(rgb,A.defaults()),rgb);}
  for(const invalid of [{exposureEV:4.001},{exposureEV:NaN},{temperature:Infinity},{hsl:{red:{hue:2}}},{hsl:{pink:{hue:0}}},{curves:{master:[[0,0],[0,1],[1,1]]}},{curves:{master:[[.1,0],[1,1]]}},{curves:{master:[[0,-1],[1,1]]}},{curves:{master:Array.from({length:17},(_,i)=>[i/16,i/16])}},{exposure:1},null]) assert.throws(()=>A.validate(invalid));
});
test('exposure follows linear sRGB EV; tone, white balance and curves have useful direction',()=>{
  const decode=x=>x<=.04045?x/12.92:((x+.055)/1.055)**2.4,encode=x=>x<=.0031308?x*12.92:1.055*x**(1/2.4)-.055;
  for(const x of [0,.01,.04,.12,.2,.5,.8,1])assert.ok(Math.abs(A.adjustRgb([x,x,x],{exposureEV:1})[0]-encode(Math.min(1,2*decode(x))))<1e-12);
  const warm=A.adjustRgb([.4,.4,.4],{temperature:1}),green=A.adjustRgb([.4,.4,.4],{tint:-1});assert.ok(warm[0]>warm[2]);assert.ok(green[1]>green[0]&&green[1]>green[2]);
  for(const key of ['shadows','highlights','whites','blacks'])for(const v of [.1,.4,.9])assert.ok(luminance(A.adjustRgb([v,v,v],{[key]:.5}))>v);
  assert.deepEqual(A.adjustRgb([.25,.5,.75],{curves:{master:[[0,0],[.5,.25],[1,1]]}}),[.125,.25,.625]);
  assert.deepEqual(A.adjustRgb([.25,.5,.75],{curves:{red:[[0,1],[1,0]]}}),[.75,.5,.75]);
});
test('HSL hue uses circular red wrap, preserves achromatic inputs and targets color ranges',()=>{
  const red=[.8,.1,.1],blue=[.1,.1,.8],params={hsl:{red:{saturation:-1}}};
  const out=A.adjustRgb(red,params);assert.ok(Math.max(...out)-Math.min(...out)<.000001);assert.deepEqual(A.adjustRgb(blue,params),blue);
  assert.deepEqual(A.adjustRgb([.4,.4,.4],{hsl:{red:{hue:1,saturation:1,luminance:1}}}),[.4,.4,.4]);
  const rotate=A.adjustRgb(red,{hsl:{red:{hue:1}}});assert.ok(rotate[1]>red[1]&&Math.abs(rotate[2]-red[2])<1e-10);
  const nearLeft=A.adjustRgb([.8,.1,.10001],params),nearRight=A.adjustRgb([.8,.10001,.1],params);assert.ok(Math.abs(nearLeft[0]-nearRight[0])<.00002);
});
test('extreme controls and custom nonmonotone 16-point curves stay finite and bounded',()=>{
  let seed=47891;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
  for(const sign of [-1,1]){
    const input=Object.fromEntries(['temperature','tint','shadows','highlights','whites','blacks'].map(k=>[k,sign]));input.exposureEV=sign*4;input.hsl=Object.fromEntries(A.bands.map(b=>[b,{hue:sign,saturation:sign,luminance:sign}]));input.curves=Object.fromEntries(A.channels.map(c=>[c,Array.from({length:16},(_,i)=>[i/15,i%2])]));
    const f=A.createProcessor(input);for(let i=0;i<20000;i++){const out=f([random(),random(),random()]);assert.equal(out.length,3);for(const x of out)assert.ok(Number.isFinite(x)&&x>=0&&x<=1);}
  }
});
