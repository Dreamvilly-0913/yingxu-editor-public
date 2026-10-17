'use strict';
const fs=require('node:fs');const path=require('node:path');const {spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),out=path.join(root,'assets','demo');
const ffmpeg=[process.env.YINGXU_FFMPEG,path.join(root,'tools','ffmpeg.exe'),require('./test-env.cjs').ffmpeg()].filter(Boolean).find(fs.existsSync);
if(!ffmpeg)throw new Error('FFmpeg is required');
function run(args){const r=spawnSync(ffmpeg,['-hide_banner','-loglevel','error','-y',...args],{windowsHide:true,encoding:'utf8'});if(r.status!==0)throw new Error(r.stderr);}
run(['-loop','1','-i',path.join(out,'source.png'),'-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=4','-vf','scale=1280:720,zoompan=z=1.02+0.0003*on:x=iw/2-iw/zoom/2:y=ih/2-ih/zoom/2:d=1:s=1280x720:fps=30','-af','volume=0.08','-t','4','-c:v','libx264','-preset','fast','-pix_fmt','yuv420p','-c:a','aac','-movflags','+faststart',path.join(out,'light.mp4')]);
run(['-f','lavfi','-i','sine=frequency=220:sample_rate=48000:duration=9','-af','volume=0.1,afade=t=in:d=0.4,afade=t=out:st=8:d=1','-c:a','pcm_s16le',path.join(out,'tone.wav')]);
fs.writeFileSync(path.join(out,'sample.srt'),'1\n00:00:00,400 --> 00:00:03,800\n把平凡的片刻，剪成故事。\n\n2\n00:00:04,300 --> 00:00:07,800\n导入 · 分割 · 字幕 · 导出\n','utf8');
console.log(JSON.stringify({demo:out,files:fs.readdirSync(out)}));
