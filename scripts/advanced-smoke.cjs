'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {_electron}=require('./test-env.cjs').playwright();
const root=path.resolve(__dirname,'..'),out=path.join(root,'outputs'),work=path.join(root,'work');
const version=require('../package.json').version,packaged=process.argv.includes('--packaged');
const label='v'+version.split('.')[1]+'-advanced-'+(packaged?'packaged':'desktop'),checks=[],errors=[];
const env={...process.env,YINGXU_TEST:'1',YINGXU_TEST_PROFILE:path.join(work,label+'-profile')};delete env.ELECTRON_RUN_AS_NODE;
const executable=packaged?path.join(out,`映序剪辑-${version}-win-x64`,'映序剪辑.exe'):require('electron');
function passed(message){checks.push(message);console.log('PASS '+message);}
(async()=>{
 const app=await _electron.launch({executablePath:executable,args:packaged?[]:[root],env,timeout:30000});let page;
 const save=path.join(work,label+'.yxproj'),output=path.join(out,label+'.mp4');
 async function shot(name){await app.evaluate(async({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0].webContents;w.invalidate();await w.capturePage(undefined,{stayHidden:false,stayAwake:true});});await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));const png=await app.evaluate(async({BrowserWindow})=>(await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined,{stayHidden:false,stayAwake:true})).toPNG().toString('base64'));fs.writeFileSync(path.join(out,name),Buffer.from(png,'base64'));}
 async function saveProject(){await page.click('#saveProject');await page.waitForFunction(()=>document.querySelector('#dirtyDot').hidden,null,{timeout:30000});return JSON.parse(fs.readFileSync(save,'utf8'));}
 async function change(selector,value){await page.locator(selector).fill(String(value));await page.locator(selector).press('Tab');}
 try{
  page=await app.firstWindow();page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept().catch(()=>{}));
  await page.waitForFunction(()=>window.editor&&window.EditorModel);
  const environment=await page.evaluate(()=>window.editor.getEnvironment());assert.equal(environment.version,version);
  const asr=await page.evaluate(()=>window.editor.getAsrStatus());assert.equal(asr.available,true,JSON.stringify(asr));passed('桌面桥、'+version+'版本及内置本地识别模型就绪');
  const fixture=await page.evaluate(async({root})=>{
   const M=window.EditorModel,assets=await window.editor.importPaths([root+'/assets/demo/light.mp4',root+'/assets/demo/texture.png',root+'/assets/asr-test/speech-en.wav']);
   let p=M.createProject('叠层 · 动画 · 自动字幕验收');p.width=640;p.height=360;p.fps=25;p.subtitleStyle.fontSize=24;
   for(const a of assets)p=M.addAsset(p,a);
   p=M.addClip(p,assets[0].id);p=M.updateClip(p,p.clips[0].id,{duration:3,volume:0});
   p=M.addClip(p,assets[1].id);const second=p.clips.at(-1).id;p=M.updateClip(p,second,{duration:3});p=M.setClipTransition(p,second,{type:'crossfade',duration:.6});
   p=M.addClip(p,assets[1].id,1,{layer:1});const overlay=p.clips.at(-1).id;p=M.updateClip(p,overlay,{duration:2,transform:{x:-.25,y:-.2,scale:.35,rotation:0,opacity:1}});
   p=M.setClipKeyframe(p,overlay,0,{x:-.25,y:-.2,scale:.35,rotation:0,opacity:1});
   p=M.setClipKeyframe(p,overlay,2,{x:.25,y:.2,scale:.55,rotation:30,opacity:.7});
   p=M.addClip(p,assets[2].id,0);p=M.addSubtitle(p,{start:0,end:1,text:'识别前的手动字幕'});
   return {project:p,overlay,second,texture:assets[1].id,audioDuration:assets[2].duration};
  },{root:root.replace(/\\/g,'/')});
  fs.writeFileSync(save,JSON.stringify(fixture.project,null,2));
  await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});dialog.showSaveDialog=async()=>({canceled:false,filePath:file});},save);
  await page.click('#openProject');await page.waitForFunction(()=>document.querySelector('#projectName').value==='叠层 · 动画 · 自动字幕验收',null,{timeout:30000});
  assert.equal(await page.locator('#videoTrack [data-clip-id]').count(),2);assert.equal(await page.locator('#videoTrack1 [data-clip-id]').count(),1);passed('主轨转场、独立视频叠层与关键帧工程重开');
  await page.locator('#videoTrack1 [data-clip-id]').click();
  await change('[data-transform-prop="scale"]',45);
  const zoom=Number(await page.locator('#timelineZoom').inputValue());await page.locator('#timelineRuler').click({position:{x:1.9*zoom,y:12}});await page.click('#addKeyframe');
  let stored=await saveProject();const animated=stored.clips.find(c=>c.id===fixture.overlay);assert.ok(animated.keyframes.length>=3);passed('属性面板缩放修改、播放头添加动画关键帧并持久化');
  await page.locator(`#videoTrack [data-clip-id="${fixture.second}"]`).click();await page.selectOption('[data-transition-prop="type"]','fadeblack');await change('[data-transition-prop="duration"]',.4);
  stored=await saveProject();assert.equal(stored.clips.find(c=>c.id===fixture.second).transition.type,'fadeblack');assert.ok(Math.abs(stored.clips.find(c=>c.id===fixture.second).start-2.6)<.001);
  await page.selectOption('[data-transition-prop="type"]','crossfade');await change('[data-transition-prop="duration"]',.6);passed('叠化与淡黑切换及转场时长影响时间线');
  await page.click('#addVideoTrack');await page.waitForSelector('#videoTrack2');
  await page.evaluate(({id})=>{const target=document.querySelector('#videoTrack2'),r=target.getBoundingClientRect(),dt=new DataTransfer();dt.setData('application/x-yingxu-asset',id);target.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt,clientX:r.left+10,clientY:r.top+15}));},{id:fixture.texture});
  await page.waitForSelector('#videoTrack2 [data-clip-id]');await page.locator('#videoTrack2 [data-clip-id]').click();await change('[data-prop="duration"]',1);await change('[data-transform-prop="scale"]',25);
  stored=await saveProject();assert.ok(stored.clips.some(c=>c.layer===2&&c.duration===1));passed('新增第三视频轨、拖入素材并独立裁剪与缩放');
  const thirdClip=stored.clips.find(c=>c.layer===2).id;
  await page.evaluate(({id})=>{const target=document.querySelector('#videoTrack'),r=target.getBoundingClientRect(),dt=new DataTransfer();dt.setData('application/x-yingxu-clip',id);target.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt,clientX:r.left+5,clientY:r.top+15}));},{id:thirdClip});
  assert.equal(await page.locator('#videoTrack [data-clip-id]').count(),3);assert.equal(await page.locator('#videoTrack2 [data-clip-id]').count(),0);
  await page.click('#undo');assert.equal(await page.locator('#videoTrack2 [data-clip-id]').count(),1);await page.click('#redo');assert.equal(await page.locator('#videoTrack [data-clip-id]').count(),3);await page.click('#undo');passed('叠层拖回主轨、重新排列并支持撤销重做');

  await page.click('#goStart');await page.click('#playPause');await page.waitForTimeout(950);await page.click('#playPause');assert.notEqual(await page.locator('#currentTime').innerText(),'00:00:00:00');
  await shot(label+'-editor.png');passed('含多层画面的播放预览与实际窗口截图');
  await page.evaluate(()=>{window.qaAsrEvents=[];window.editor.onTranscriptionProgress(e=>window.qaAsrEvents.push(e));});
  await page.click('#subtitleTab');await page.click('#autoSubtitle');await page.selectOption('#asrLanguage','en');await page.click('#startAsr');await page.waitForFunction(()=>!document.querySelector('#cancelAsr').disabled);await page.click('#cancelAsr');
  await page.waitForFunction(()=>window.qaAsrEvents.some(e=>e.status==='canceled'),null,{timeout:60000});passed('从界面取消本地识别任务');
  await page.click('#retryAsr');await page.click('#startAsr');
  await page.waitForFunction(()=>window.qaAsrEvents.some(e=>e.status==='completed'||e.status==='error'),null,{timeout:180000});
  const recognition=await page.evaluate(()=>window.qaAsrEvents.find(e=>e.status==='completed'||e.status==='error'));assert.equal(recognition.status,'completed',recognition.error);
  assert.ok(recognition.cues.length>0);const recognized=recognition.cues.map(c=>c.text).join(' ').toLowerCase();assert.ok(/video/.test(recognized)&&/subtitles/.test(recognized),recognized);
  await page.waitForFunction(()=>!document.querySelector('#applyAsr').hidden);await shot(label+'-recognition.png');await page.click('#applyAsr');
  stored=await saveProject();assert.equal(stored.subtitles.length,recognition.cues.length);assert.ok(stored.subtitles.every(c=>c.text!=='识别前的手动字幕'));passed('真实口播自动识别、校对结果呈现并写入可编辑字幕');
  await page.click('#undo');assert.ok((await page.locator('#subtitleTrack').innerText()).includes('识别前的手动字幕'));await page.click('#redo');stored=await saveProject();assert.equal(stored.subtitles.length,recognition.cues.length);passed('自动字幕写入支持撤销和重做');
  await page.click('#openProject');await page.waitForFunction(()=>document.querySelector('#projectSaveState').textContent==='项目已保存',null,{timeout:30000});
  assert.equal(await page.locator('#videoTrack2 [data-clip-id]').count(),1);passed('多轨、转场、动画及识别字幕整体保存后重开');
  await app.evaluate(({dialog},file)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:file});},output);
  await page.click('#openExport');await page.click('#startExport');await page.waitForFunction(()=>!document.querySelector('#revealExport').hidden||document.querySelector('#exportStatus').textContent==='导出未完成',null,{timeout:240000});
  assert.equal(await page.locator('#exportStatus').innerText(),'导出完成',await page.locator('#exportDetail').innerText());assert.ok(fs.statSync(output).size>10000);
  const result=await require('../src/main/media.cjs').probeMedia(output,{ffprobe:require('ffprobe-static').path,ffmpeg:require('./test-env.cjs').ffmpeg(),cacheDir:path.join(work,label+'-probes')});assert.equal(result.width,640);assert.equal(result.height,360);assert.ok(Math.abs(result.duration-fixture.audioDuration)<.12);assert.equal(result.hasAudio,true);passed('多轨、转场、关键帧及自动字幕共同导出为真实有声MP4');await shot(label+'-export.png');await page.click('#closeExport');
  await page.setViewportSize({width:1080,height:760});await page.locator('#videoTrack1 [data-clip-id]').click();await shot(label+'-compact.png');assert.ok(await page.evaluate(()=>document.body.scrollWidth<=innerWidth+1));passed('1080×760窗口布局检查');assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(out,label+'-acceptance.json'),JSON.stringify({success:true,version,packaged,checks,errors,recognized,output,createdAt:new Date().toISOString()},null,2));
 }catch(e){if(page)await shot(label+'-failure.png').catch(()=>{});fs.writeFileSync(path.join(out,label+'-acceptance.json'),JSON.stringify({success:false,version,packaged,checks,errors,error:e.stack},null,2));throw e;}
 finally{await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().forEach(w=>w.destroy())).catch(()=>{});await app.close().catch(()=>{});}
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
