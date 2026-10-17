'use strict';
const fs=require('node:fs');const path=require('node:path');const assert=require('node:assert/strict');const {_electron}=require('./test-env.cjs').playwright();
const root=path.resolve(__dirname,'..'),work=path.join(root,'work'),out=path.join(root,'outputs');const env={...process.env,YINGXU_TEST:'1',YINGXU_TEST_PROFILE:path.join(work,'interaction-profile')};delete env.ELECTRON_RUN_AS_NODE;
const checks=[],errors=[];const recordPush=checks.push.bind(checks);checks.push=(item)=>{console.log('PASS '+item);return recordPush(item);};
(async()=>{const app=await _electron.launch({executablePath:require('electron'),args:[root],env});let page;
try{
 page=await app.firstWindow();page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept().catch(()=>{}));
 await page.click('#openDemo');await page.waitForFunction(()=>document.querySelector('#assetCount').textContent==='3');
 const count=()=>page.locator('#videoTrack [data-clip-id]').count();assert.equal(await count(),2);
 await page.locator('#videoTrack [data-clip-id]').first().click();
 await page.locator('[data-prop="duration"]').fill('2');await page.locator('[data-prop="duration"]').press('Tab');assert.equal(await page.locator('[data-prop="duration"]').inputValue(),'2');
 await page.locator('[data-prop="speed"]').fill('2');await page.locator('[data-prop="speed"]').press('Tab');assert.equal(await page.locator('[data-prop="duration"]').inputValue(),'1');checks.push('片段裁剪与变速同步调整时长');
 await page.click('#undo');await page.click('#undo');
 const zoom=Number(await page.locator('#timelineZoom').inputValue());await page.locator('#timelineRuler').click({position:{x:zoom*1.5,y:12}});await page.click('#splitClip');assert.equal(await count(),3);checks.push('播放头处分割产生两段');
 await page.click('#undo');assert.equal(await count(),2);await page.click('#redo');assert.equal(await count(),3);await page.click('#undo');checks.push('撤销与重做片段操作');
 await page.locator('#videoTrack [data-clip-id]').first().click();await page.click('#moveRight');assert.ok((await page.locator('#videoTrack [data-clip-id]').first().innerText()).includes('texture.png'));await page.click('#undo');checks.push('时间线顺序调整');
 await page.locator('#assetList [data-asset-id]').first().dblclick();assert.equal(await count(),3);await page.click('#undo');checks.push('双击素材加入时间线');
 await page.click('#addSubtitleTimeline');const ta=page.locator('#inspectorBody textarea');await ta.fill('字幕交互验收');await ta.press('Tab');assert.ok((await page.locator('#subtitleTrack').innerText()).includes('字幕交互验收'));await page.click('#undo');await page.click('#undo');checks.push('字幕添加与文字编辑');
 await app.evaluate(({dialog},p)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[p]});},path.join(root,'assets/demo/sample.srt'));
 await page.click('#subtitleTab');await page.click('#importSrt');await page.waitForFunction(()=>document.querySelector('#subtitleCount').textContent==='4');await page.click('#undo');checks.push('SRT字幕导入与撤销');
 const cancelPath=path.join(work,'cancel-from-ui.mp4');await app.evaluate(({dialog},p)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:p});},cancelPath);
 await page.click('#openExport');await page.click('#startExport');await page.waitForFunction(()=>!document.querySelector('#cancelExport').disabled);await page.click('#cancelExport');await page.waitForFunction(()=>document.querySelector('#exportStatus').textContent==='导出已取消',null,{timeout:30000});await page.waitForTimeout(400);assert.equal(fs.existsSync(cancelPath),false);checks.push('界面取消导出，无最终半成品');await page.click('#closeExport');
 // Confirm close waits for an active exporter and its temporary job directory cleanup.
 const closePath=path.join(work,'cancel-on-close.mp4');await app.evaluate(({dialog},p)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:p});dialog.showMessageBoxSync=()=>1;},closePath);
 await page.click('#openExport');await page.click('#exportAgain');await page.click('#startExport');await page.waitForFunction(()=>!document.querySelector('#cancelExport').disabled);
 const closed=app.waitForEvent('close',{timeout:30000});await app.evaluate(({BrowserWindow})=>{BrowserWindow.getAllWindows()[0].close();});await closed;
 assert.equal(fs.existsSync(closePath),false);const renderRoot=path.join(work,'interaction-profile','export-work');const leftovers=fs.existsSync(renderRoot)?fs.readdirSync(renderRoot):[];assert.equal(leftovers.length,0);checks.push('关闭窗口时等待取消完成，渲染临时目录已清理');
 assert.deepEqual(errors,[]);const result={success:true,checks,errors,createdAt:new Date().toISOString()};fs.writeFileSync(path.join(out,'interaction-acceptance.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}catch(e){fs.writeFileSync(path.join(out,'interaction-acceptance.json'),JSON.stringify({success:false,checks,errors,error:e.stack},null,2));throw e;}finally{await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().forEach(w=>w.destroy())).catch(()=>{});await app.close().catch(()=>{});}
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
