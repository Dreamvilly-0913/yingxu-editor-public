/* Bounded cache management; only application-generated files inside the cache root. */
'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
async function inventory(root){
 root=path.resolve(root);await fs.mkdir(root,{recursive:true});const result=[];
 async function walk(dir){for(const entry of await fs.readdir(dir,{withFileTypes:true})){const file=path.join(dir,entry.name),s=await fs.lstat(file);if(s.isSymbolicLink())continue;if(s.isDirectory())await walk(file);else if(s.isFile())result.push({path:file,bytes:s.size,modified:s.mtimeMs});}}
 await walk(root);return result;
}
async function status(root){const files=await inventory(root);return{files:files.length,bytes:files.reduce((n,f)=>n+f.bytes,0)};}
async function trim(root,maxBytes,{preservePaths=[]}={}){
 if(!Number.isFinite(maxBytes)||maxBytes<0)throw new Error('缓存容量无效');root=path.resolve(root);const files=await inventory(root),keep=new Set(preservePaths.map(p=>path.resolve(p).toLowerCase()));let bytes=files.reduce((n,f)=>n+f.bytes,0),removed=0,freed=0;
 for(const row of files.sort((a,b)=>a.modified-b.modified)){
  if(bytes<=maxBytes)break;if(keep.has(row.path.toLowerCase()))continue;const rel=path.relative(root,row.path);if(!rel||rel.startsWith('..')||path.isAbsolute(rel))throw new Error('缓存路径越界');
  const stat=await fs.lstat(row.path).catch(()=>null);if(!stat||!stat.isFile()||stat.isSymbolicLink())continue;
  try{await fs.unlink(row.path);bytes-=row.bytes;freed+=row.bytes;removed++;}catch(e){if(!['EBUSY','EPERM','EACCES','ENOENT'].includes(e.code))throw e;}
 }
 return{removed,freed,bytes,limit:maxBytes};
}
module.exports={inventory,status,trim};
