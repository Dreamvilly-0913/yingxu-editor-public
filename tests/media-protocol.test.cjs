'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
const {mediaResponse}=require('../src/main/media-protocol.cjs');
test('media stream returns seekable byte-accurate full, bounded, open and suffix responses',{timeout:10000},async()=>{
 await fs.mkdir(path.resolve(__dirname,'../work'),{recursive:true});
 const dir=await fs.mkdtemp(path.resolve(__dirname,'../work/range-test-')),file=path.join(dir,'sample.mp4'),input=Buffer.from(Array.from({length:4096},(_,i)=>(i*17)%251));await fs.writeFile(file,input);
 try{for(const [range,status,start,end]of[[null,200,0,4095],['bytes=101-257',206,101,257],['bytes=4000-',206,4000,4095],['bytes=-128',206,3968,4095],['bytes=4090-9999',206,4090,4095]]){
  const r=await mediaResponse(new Request('https://asset.test/video',{headers:range?{Range:range}:{}}),file);assert.equal(r.status,status);assert.equal(r.headers.get('accept-ranges'),'bytes');assert.equal(r.headers.get('access-control-allow-origin'),'*');assert.equal(r.headers.get('content-length'),String(end-start+1));if(range)assert.equal(r.headers.get('content-range'),`bytes ${start}-${end}/4096`);assert.deepEqual(Buffer.from(await r.arrayBuffer()),input.subarray(start,end+1));
 }
 const head=await mediaResponse(new Request('https://asset.test/video',{method:'HEAD'}),file);assert.equal(head.headers.get('content-length'),'4096');assert.equal((await head.arrayBuffer()).byteLength,0);
 for(const range of ['bytes=4096-','bytes=200-100','bytes=-0','bytes=1-2,5-6','bytes=-','nonsense']){const r=await mediaResponse(new Request('https://asset.test/video',{headers:{Range:range}}),file);assert.equal(r.status,416);assert.equal(r.headers.get('content-range'),'bytes */4096');}
 assert.equal((await mediaResponse(new Request('https://asset.test/video',{method:'POST'}),file)).status,405);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
