'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{_electron}=require('./test-env.cjs').playwright();
const root=path.resolve(__dirname,'..'),env={...process.env,YINGXU_TEST:'1',YINGXU_TEST_PROFILE:path.join(root,'work/race-profile')};delete env.ELECTRON_RUN_AS_NODE;
(async()=>{const app=await _electron.launch({executablePath:require('electron'),args:[root],env});try{
 const page=await app.firstWindow();await page.waitForFunction(()=>window.editor);
 await page.evaluate(async()=>{window.qaProject=await window.editor.openDemo();window.qaEvents=[];window.editor.onTranscriptionProgress(e=>window.qaEvents.push(e));});
 await app.evaluate(({dialog})=>{globalThis.qaDialogCalls=0;dialog.showSaveDialog=()=>{globalThis.qaDialogCalls++;return new Promise(r=>{globalThis.qaResolveDialog=r;});};});
 await page.evaluate(()=>{window.qaFirstExport=window.editor.exportProject(window.qaProject,{}).then(result=>{window.qaExportResult=result;},error=>{window.qaExportResult={error:error.message};});});
 for(let i=0;i<50;i++){if(await app.evaluate(()=>globalThis.qaDialogCalls===1))break;await page.waitForTimeout(20);}
 assert.equal(await app.evaluate(()=>globalThis.qaDialogCalls),1);
 const rejected=await page.evaluate(async()=>Promise.all([window.editor.exportProject(window.qaProject,{}),window.editor.startTranscription(window.qaProject,{language:'en'})].map(p=>p.then(()=>null,e=>e.message))));
 assert.ok(rejected.every(e=>e&&e.includes('已有媒体任务')),JSON.stringify(rejected));assert.equal(await app.evaluate(()=>globalThis.qaDialogCalls),1);
 await app.evaluate(()=>globalThis.qaResolveDialog({canceled:true}));await page.waitForFunction(()=>window.qaExportResult?.canceled===true);
 const started=await page.evaluate(()=>window.editor.startTranscription(window.qaProject,{language:'en'}));assert.ok(started.jobId);
 await app.evaluate(({dialog})=>{dialog.showMessageBoxSync=()=>1;});const closed=app.waitForEvent('close',{timeout:30000});await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].close());await closed;
 const temp=path.join(root,'work/race-profile/export-work');assert.equal(fs.existsSync(temp)?fs.readdirSync(temp).length:0,0);
 const result={success:true,checks:['保存对话框期间拒绝第二导出与ASR请求','取消对话框后释放任务保留状态','识别期间关窗取消并等待临时文件清理'],createdAt:new Date().toISOString()};fs.writeFileSync(path.join(root,'outputs/task-race-acceptance.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
 }finally{await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().forEach(w=>w.destroy())).catch(()=>{});await app.close().catch(()=>{});}})().catch(e=>{console.error(e.stack);process.exitCode=1;});
