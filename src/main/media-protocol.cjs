'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {Readable}=require('node:stream');
const types={mp4:'video/mp4',m4v:'video/mp4',mov:'video/quicktime',mkv:'video/x-matroska',webm:'video/webm',avi:'video/x-msvideo',mp3:'audio/mpeg',wav:'audio/wav',m4a:'audio/mp4',aac:'audio/aac',ogg:'audio/ogg',flac:'audio/flac',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',bmp:'image/bmp'};
// Serve only a path already resolved by the token registry in main.cjs.
// Explicit byte ranges preserve video seeking while allowing CORS-safe GPU sampling.
async function mediaResponse(request,file){
 const headers=new Headers({'Access-Control-Allow-Origin':'*','Access-Control-Expose-Headers':'Accept-Ranges,Content-Range,Content-Length','Accept-Ranges':'bytes'});
 if(request.method==='OPTIONS'){headers.set('Access-Control-Allow-Methods','GET,HEAD,OPTIONS');headers.set('Access-Control-Allow-Headers','Range');return new Response(null,{status:204,headers});}
 if(!['GET','HEAD'].includes(request.method)){headers.set('Allow','GET,HEAD,OPTIONS');return new Response(null,{status:405,headers});}
 let info;try{info=await fs.promises.stat(file);}catch{return new Response(null,{status:404,headers});}
 if(!info.isFile())return new Response(null,{status:404,headers});
 const size=info.size;let start=0,end=size-1,status=200;const range=request.headers.get('range');
 if(range){
  const match=/^bytes=(\d*)-(\d*)$/.exec(range.trim());
  const bad=()=>{headers.set('Content-Range',`bytes */${size}`);headers.set('Content-Length','0');return new Response(null,{status:416,headers});};
  if(!match||(!match[1]&&!match[2])||!size)return bad();
  if(!match[1]){const suffix=Number(match[2]);if(!Number.isSafeInteger(suffix)||suffix<=0)return bad();start=Math.max(0,size-suffix);}
  else{start=Number(match[1]);if(match[2])end=Math.min(size-1,Number(match[2]));if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>=size||start>end)return bad();}
  status=206;headers.set('Content-Range',`bytes ${start}-${end}/${size}`);
 }
 headers.set('Content-Type',types[path.extname(file).slice(1).toLowerCase()]||'application/octet-stream');
 headers.set('Content-Length',String(size?end-start+1:0));
 const body=request.method==='HEAD'||!size?null:Readable.toWeb(fs.createReadStream(file,{start,end}));
 return new Response(body,{status,headers});
}
module.exports={mediaResponse};
