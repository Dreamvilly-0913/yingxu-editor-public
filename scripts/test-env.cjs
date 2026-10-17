/* Portable test tooling. Resolve explicit environment, project tools, npm dependencies and PATH. */
'use strict';const fs=require('node:fs'),path=require('node:path');const root=path.resolve(__dirname,'..');
function file(value){try{return typeof value==='string'&&fs.statSync(value).isFile();}catch{return false;}}
function onPath(name){const extensions=process.platform==='win32'?['.exe','.cmd','.bat','']:[''];for(const directory of (process.env.PATH||'').split(path.delimiter))for(const suffix of extensions){const candidate=path.join(directory,name+suffix);if(file(candidate))return candidate;}}
function executable(name){const override=process.env['YINGXU_'+name.toUpperCase()];if(override)return override;const local=path.join(root,'tools',name+(process.platform==='win32'?'.exe':''));if(file(local))return local;
 if(name==='ffprobe'){try{const probe=require('ffprobe-static').path;if(file(probe))return probe;}catch{}}
 const search=onPath(name);if(search)return search;
 return name;
}
function playwright(){if(process.env.YINGXU_PLAYWRIGHT)return require(process.env.YINGXU_PLAYWRIGHT);try{return require('playwright-core');}catch(error){throw new Error('缺少 playwright-core：请先 npm ci，或设置 YINGXU_PLAYWRIGHT。',{cause:error});}}
module.exports={root,ffmpeg:()=>executable('ffmpeg'),ffprobe:()=>executable('ffprobe'),playwright};
if(require.main===module){if(process.argv.includes('--ffmpeg'))console.log(executable('ffmpeg'));else if(process.argv.includes('--ffprobe'))console.log(executable('ffprobe'));else console.log(JSON.stringify({ffmpeg:executable('ffmpeg'),ffprobe:executable('ffprobe'),playwrightAvailable:(()=>{try{return Boolean(playwright());}catch{return false;}})()},null,2));}
