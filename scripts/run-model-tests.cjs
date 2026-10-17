/* Explicit offline unit/FS set. No FFmpeg, Electron, ASR or AI process starts in this suite. */
'use strict';const path=require('node:path'),{spawnSync}=require('node:child_process');
const files=["media-protocol.test.cjs", "phase7-model.test.cjs", "phase8-color.test.cjs", "phase8-speed.test.cjs", "phase9-editing.test.cjs", "phase9-media.test.cjs", "phase9-project-files.test.cjs", "phase10-visual.test.cjs", "phase10-text.test.cjs", "phase10-preprocess.test.cjs", "phase10-workflow.test.cjs"];
const args=files.map(name=>path.join(__dirname,'../tests',name));
const result=spawnSync(process.execPath,['--test',...args],{stdio:'inherit',env:{...process.env,YINGXU_ALLOW_WORKSTATION_FALLBACK:'0'}});if(result.error)throw result.error;process.exitCode=result.status===null?1:result.status;
