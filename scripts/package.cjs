'use strict';
const fs=require('node:fs');const path=require('node:path');const crypto=require('node:crypto');const {spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),pkg=require(path.join(root,'package.json'));
const out=path.join(root,'outputs',`映序剪辑-${pkg.version}-win-x64`);
if(fs.existsSync(out))throw new Error('该版本输出已存在，请使用新版本目录或先审阅现有产物');
const asr=path.join(root,'tools','asr');
for(const name of ['whisper-cli.exe','ggml-base.bin','ggml-silero-v6.2.0.bin'])if(!fs.existsSync(path.join(asr,name)))throw new Error('缺少本地识别依赖：'+name);
const electron=path.join(root,'node_modules','electron','dist');
const toolEnv=require('./test-env.cjs'),ffmpeg=toolEnv.ffmpeg(),ffprobe=toolEnv.ffprobe();
for(const f of [path.join(electron,'electron.exe'),ffmpeg,ffprobe])if(!fs.existsSync(f))throw new Error(`缺少依赖：${f}`);
fs.cpSync(electron,out,{recursive:true,filter:src=>path.basename(src)!=='default_app.asar'});
fs.renameSync(path.join(out,'electron.exe'),path.join(out,'映序剪辑.exe'));
const bundle=path.join(out,'resources','app');fs.mkdirSync(bundle,{recursive:true});
for(const folder of ['src','assets','docs'])fs.cpSync(path.join(root,folder),path.join(bundle,folder),{recursive:true,filter:file=>{if(folder!=='docs')return true;const rel=path.relative(path.join(root,'docs'),file).split(path.sep).join('/');return !rel.startsWith('evidence/')||rel==='evidence/phase10'||rel.startsWith('evidence/phase10/');}});
fs.writeFileSync(path.join(bundle,'package.json'),JSON.stringify({name:pkg.name,productName:pkg.productName,version:pkg.version,main:pkg.main},null,2));
fs.mkdirSync(path.join(bundle,'tools'),{recursive:true});fs.copyFileSync(ffmpeg,path.join(bundle,'tools','ffmpeg.exe'));fs.copyFileSync(ffprobe,path.join(bundle,'tools','ffprobe.exe'));
fs.cpSync(asr,path.join(bundle,'tools','asr'),{recursive:true});
const ai=path.join(root,'tools/ai');
if(!fs.existsSync(path.join(ai,'u2netp.onnx')))throw new Error('缺少本地AI模型，请先运行node scripts/bootstrap-ai.cjs');
fs.cpSync(ai,path.join(bundle,'tools/ai'),{recursive:true,filter:source=>{const parts=path.relative(ai,source).split(path.sep),index=parts.findIndex(p=>p.startsWith('napi-v'));return !(index>=0&&(['darwin','linux'].includes(parts[index+1])||parts[index+1]==='win32'&&parts[index+2]==='arm64'))&&!parts.includes('.cache');}});

const guide=fs.readFileSync(path.join(root,'README_继续项目.md'),'utf8').replace(/\(docs\//g,'(resources/app/docs/').replace(/运行 `outputs\/映序剪辑-[^`]+`，或双击项目根目录 `启动映序剪辑.cmd`。/,'运行本目录内的 `映序剪辑.exe`。');
fs.writeFileSync(path.join(out,'使用说明.md'),guide);
const licenses=path.join(out,'第三方许可');fs.mkdirSync(licenses,{recursive:true});
for(const [name,file] of [['FFmpeg',ffmpeg],['FFprobe',ffprobe]]){const license=spawnSync(file,['-L'],{windowsHide:true,encoding:'utf8'});fs.writeFileSync(path.join(licenses,name+'-license.txt'),license.stdout+'\n'+license.stderr);}
for(const license of ['LICENSE-U-2-Net.txt','LICENSE-onnxruntime.txt'])fs.copyFileSync(path.join(ai,license),path.join(licenses,license));
if(fs.existsSync(path.join(asr,'licenses')))fs.cpSync(path.join(asr,'licenses'),path.join(licenses,'ASR'),{recursive:true});
const ffmpegBuild=spawnSync(ffmpeg,['-version'],{windowsHide:true,encoding:'utf8'});
fs.writeFileSync(path.join(licenses,'来源.txt'),'Electron: https://www.electronjs.org/ (MIT; Chromium licenses included in root)\nFFmpeg: https://ffmpeg.org/download.html\nActual bundled build: '+ffmpegBuild.stdout.split(/\r?\n/)[0]+'\nWindows FFmpeg build provider: https://www.gyan.dev/ffmpeg/builds/\nffprobe-static 3.1.0: https://github.com/joshwnj/ffprobe-static\n');
const manifest={version:pkg.version,createdAt:new Date().toISOString(),electron:require(path.join(root,'node_modules/electron/package.json')).version,files:[]};
function walk(dir){for(const f of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,f.name);if(f.isDirectory())walk(file);else manifest.files.push({path:path.relative(out,file),bytes:fs.statSync(file).size,sha256:crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')});}}
walk(out);fs.writeFileSync(path.join(out,'build-manifest.json'),JSON.stringify(manifest,null,2));
console.log(JSON.stringify({output:out,files:manifest.files.length,bytes:manifest.files.reduce((n,f)=>n+f.bytes,0)}));
