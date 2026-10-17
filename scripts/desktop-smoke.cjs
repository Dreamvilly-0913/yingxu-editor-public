'use strict';
const fs=require('node:fs');const path=require('node:path');const assert=require('node:assert/strict');
const {_electron}=require('./test-env.cjs').playwright();
const root=path.resolve(__dirname,'..'),work=path.join(root,'work'),out=path.join(root,'outputs');
const packaged=process.argv.includes('--packaged');
const executable=packaged?path.join(out,`映序剪辑-${require('../package.json').version}-win-x64`,'映序剪辑.exe'):require('electron');
const env={...process.env,YINGXU_TEST:'1',YINGXU_TEST_PROFILE:path.join(work,packaged?'packaged-profile':'desktop-profile')};delete env.ELECTRON_RUN_AS_NODE;
const checks=[],errors=[];
(async()=>{
 const application=await _electron.launch({executablePath:executable,args:packaged?[]:[root],env,timeout:30000});
 let page;
 async function shot(file){await application.evaluate(async({BrowserWindow})=>{const wc=BrowserWindow.getAllWindows()[0].webContents;wc.invalidate();await wc.capturePage(undefined,{stayHidden:false,stayAwake:true});});await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));const data=await application.evaluate(async({BrowserWindow})=>{const image=await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined,{stayHidden:false,stayAwake:true});return image.toPNG().toString('base64');});fs.writeFileSync(file,Buffer.from(data,'base64'));}
 try{
  page=await application.firstWindow();page.on('pageerror',e=>errors.push(e.message));
  await page.waitForFunction(()=>window.editor&&window.EditorModel&&document.querySelector('#statusMessage').textContent!=='正在连接桌面引擎…',null,{timeout:30000});
  const environment=await page.evaluate(()=>window.editor.getEnvironment());assert.equal(environment.ffmpegAvailable,true);checks.push('桌面桥与本地FFmpeg就绪');
  await page.click('#openDemo');
  await page.waitForFunction(()=>document.querySelector('#assetCount').textContent.trim()==='3',null,{timeout:30000});
  await page.waitForFunction(()=>document.querySelector('#previewVideo').readyState>=2,null,{timeout:30000});
  const preview=await page.evaluate(()=>{const v=document.querySelector('#previewVideo');return {width:v.videoWidth,height:v.videoHeight,error:v.error?.message};});assert.equal(preview.width,1280);assert.equal(preview.height,720);assert.ok(!preview.error);checks.push('原创演示视频/图片/音频导入与协议解码');
  await shot(path.join(out,packaged?'映序_打包版界面.png':'映序_编辑器界面.png'));
  await page.click('#playPause');await page.waitForFunction(()=>document.querySelector('#currentTime').textContent!=='00:00:00:00',null,{timeout:10000});await page.waitForTimeout(600);
  let t=await page.locator('#currentTime').innerText();assert.notEqual(t,'00:00:00:00');await page.click('#playPause');checks.push('播放时钟与暂停');
  await shot(path.join(out,packaged?'映序_打包版界面.png':'映序_编辑器界面.png'));
  if(!packaged){
   const savePath=path.join(work,'desktop-roundtrip.yxproj');
   await application.evaluate(({dialog},p)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:p});},savePath);
   await page.click('#saveProject');await page.waitForFunction(()=>document.querySelector('#dirtyDot').hidden,null,{timeout:30000});
   assert.ok(fs.existsSync(savePath));let stored=JSON.parse(fs.readFileSync(savePath,'utf8'));assert.equal(stored.assets.length,3);assert.ok(stored.assets.every(a=>a.pathMode==='relative'&&!a.previewUrl));checks.push('工程保存为相对素材路径');
   await page.locator('#projectName').fill('保存往返测试');await page.locator('#projectName').press('Tab');
   page.on('dialog',async d=>d.accept());
   await application.evaluate(({dialog},p)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[p]});},savePath);
   await page.click('#openProject');await page.waitForFunction(()=>document.querySelector('#projectName').value==='片刻 · 剪辑练习',null,{timeout:30000});checks.push('工程打开并重新绑定素材');
  }
  const exportPath=path.join(out,packaged?'映序_打包版验收.mp4':'映序_桌面导出验收.mp4');
  await application.evaluate(({dialog},p)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:p});},exportPath);
  await page.click('#openExport');await page.selectOption('#resolutionPreset','custom');await page.fill('#exportWidth','640');await page.fill('#exportHeight','360');await page.click('#startExport');
  await page.waitForFunction(()=>!document.querySelector('#revealExport').hidden,null,{timeout:180000});assert.ok(fs.existsSync(exportPath));assert.ok(fs.statSync(exportPath).size>10000);checks.push('界面真实导出H264/字幕/混音并反馈完成');
  const probe=await require('../src/main/media.cjs').probeMedia(exportPath,{ffprobe:require('ffprobe-static').path,ffmpeg:require('./test-env.cjs').ffmpeg(),cacheDir:path.join(work,'qa-thumbnails')});assert.equal(probe.width,640);assert.equal(probe.height,360);assert.ok(Math.abs(probe.duration-9)<0.1);assert.equal(probe.hasAudio,true);checks.push('成片探测640×360/9秒/音轨存在');
  await shot(path.join(out,packaged?'映序_打包版导出完成.png':'映序_导出完成.png'));
  await page.click('#closeExport');
  if(!packaged){
   await page.setViewportSize({width:1080,height:760});await shot(path.join(out,'映序_紧凑窗口.png'));
   const layout=await page.evaluate(()=>({w:innerWidth,scroll:document.body.scrollWidth,h:innerHeight,height:document.body.scrollHeight}));assert.ok(layout.scroll<=layout.w+1);checks.push('1080×760窗口布局无页面横向溢出');
  }
  assert.deepEqual(errors,[]);checks.push('渲染器无未捕获异常');
  const result={success:true,packaged,environment,checks,exportPath,errors,createdAt:new Date().toISOString()};fs.writeFileSync(path.join(out,packaged?'packaged-acceptance.json':'desktop-acceptance.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
 }catch(e){if(page)await shot(path.join(work,'desktop-failure.png')).catch(()=>{});const result={success:false,packaged,checks,errors,error:e.stack,createdAt:new Date().toISOString()};fs.writeFileSync(path.join(out,packaged?'packaged-acceptance.json':'desktop-acceptance.json'),JSON.stringify(result,null,2));throw e;
 }finally{await application.evaluate(({BrowserWindow})=>{for(const w of BrowserWindow.getAllWindows())w.destroy();}).catch(()=>{});await application.close();}
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
