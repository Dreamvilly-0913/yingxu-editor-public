'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
const {spawnSync}=require('node:child_process');const M=require('../src/shared/project.js'),Media=require('../src/main/media.cjs');
test('real FFmpeg matches analytical mask alpha, cropped/flip/pose space, easing timing and split output', {timeout:240000},async()=>{
 const ffmpeg=process.env.FFMPEG_PATH||require('../scripts/test-env.cjs').ffmpeg(),ffprobe=process.env.FFPROBE_PATH||require('ffprobe-static').path;
 const work=path.resolve(__dirname,'../work');await fs.mkdir(work,{recursive:true});const dir=await fs.mkdtemp(path.join(work,'phase7-test-')),W=96,H=96,fps=20;
 const options={ffmpeg,ffprobe,workDir:dir,cacheDir:path.join(dir,'cache')},records=[];
 function run(args){const r=spawnSync(ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-y',...args],{windowsHide:true,shell:false,timeout:120000,maxBuffer:160*1024*1024});assert.equal(r.status,0,r.stderr?.toString()||r.error?.message);return r.stdout;}
 const frames=file=>run(['-i',file,'-an','-f','rawvideo','-pix_fmt','rgb24','pipe:1']);
 const at=(bytes,frame,x,y)=>bytes[(frame*W*H+y*W+x)*3];
 function project(asset){let p=M.createProject('0.5真实蒙版缓动验收');p.width=W;p.height=H;p.fps=fps;p=M.addAsset(p,asset);return p;}
 try{
  const raw=Buffer.alloc(W*H*4,255);for(let i=3;i<raw.length;i+=4)raw[i]=128;const source=path.join(dir,'rgba.bin'),png=path.join(dir,'alpha.png');await fs.writeFile(source,raw);run(['-f','rawvideo','-pix_fmt','rgba','-s',`${W}x${H}`,'-i',source,'-frames:v','1',png]);const asset=await Media.probeMedia(png,options);
  const base={type:'rectangle',centerX:.5,centerY:.5,width:1,height:1,rotation:0,feather:0,invert:false};
  const cases=[
   {name:'full rectangle preserves source alpha',mask:base},
   {name:'inverse full rectangle is transparent',mask:{...base,invert:true}},
   {name:'rotated feathered ellipse',mask:{...base,type:'ellipse',width:.65,height:.6,rotation:37,feather:.2}},
   {name:'inverted rotated feathered rectangle',mask:{...base,width:.55,height:.35,rotation:-27,feather:.25,invert:true}},
   {name:'mask follows horizontal flip',mask:{...base,centerX:.3,width:.4,feather:.12},flipX:true},
   {name:'crop source coordinate and transparent fit',mask:{...base,type:'ellipse',width:.7,height:.6,feather:.2},crop:{left:.25,right:.25}},
   {name:'mask follows translated pose',mask:{...base,width:.5,height:.5,feather:.15},transform:{x:.125,y:-.125}},
   {name:'mask multiplies alpha after color',mask:{...base,type:'ellipse',width:.8,height:.7,feather:.3},color:{brightness:-.25}}
  ];let p=project(asset);for(const entry of cases){const {name,...patch}=entry;p=M.addClip(p,asset.id);p=M.updateClip(p,p.clips.at(-1).id,{duration:.6,...patch});}
  const file=path.join(dir,'masks.mp4');await Media.exportProject(p,file,options);const bytes=frames(file);assert.equal(bytes.length,W*H*3*cases.length*12);
  for(let index=0;index<cases.length;index++){const c=p.clips[index],entry=cases[index],rect=M.cropRect(asset,c);let max=0,sum=0,count=0;for(let y=4;y<H-4;y+=5)for(let x=4;x<W-4;x+=5){let sx=x+.5-(c.transform?.x||0)*W,sy=y+.5-(c.transform?.y||0)*H;let expected=0;
    const left=(W-rect.width)/2,top=(H-rect.height)/2;sx-=left;sy-=top;
    if(sx>=0&&sx<rect.width&&sy>=0&&sy<rect.height){if(c.flipX)sx=rect.width-sx;if(c.flipY)sy=rect.height-sy;expected=128*M.evaluateMaskAlpha(c.mask,sx,sy,rect.width,rect.height)*M.adjustRgb([1,1,1],c.color)[0];}
    const error=Math.abs(at(bytes,index*12+5,x,y)-expected);max=Math.max(max,error);sum+=error;count++;}
   records.push({name:entry.name,maxError:max,meanError:sum/count,samples:count});assert.ok(max<=6,`${entry.name}: max ${max}`);
  }
  // Opaque white lets encoded intensity directly measure the transform opacity curve.
  for(let i=3;i<raw.length;i+=4)raw[i]=255;await fs.writeFile(source,raw);const white=path.join(dir,'white.png');run(['-f','rawvideo','-pix_fmt','rgba','-s',`${W}x${H}`,'-i',source,'-frames:v','1',white]);const opaque=await Media.probeMedia(white,options);
  let animation=project(opaque);const curves=['linear','ease-in','ease-out','ease-in-out','hold'];for(const easing of curves){animation=M.addClip(animation,opaque.id);const id=animation.clips.at(-1).id;animation=M.updateClip(animation,id,{duration:1,transform:{opacity:0}});animation=M.setClipKeyframe(animation,id,.8,{opacity:1},{easing});}
  const animFile=path.join(dir,'easing.mp4');await Media.exportProject(animation,animFile,options);const animated=frames(animFile);let temporalMax=0;for(let index=0;index<curves.length;index++)for(const local of [.1,.2,.4,.6,.75,.8,.9]){const expected=255*M.evaluateTransform(animation.clips[index],local).opacity,actual=at(animated,index*20+Math.round(local*fps),48,48);temporalMax=Math.max(temporalMax,Math.abs(actual-expected));assert.ok(Math.abs(actual-expected)<=3,`${curves[index]}@${local}: ${actual} vs ${expected}`);}
  records.push({name:'5 easing/hold presets at 35 encoded frame times',maxError:temporalMax,samples:35});
  let split=animation;for(const original of animation.clips)split=M.splitClip(split,original.id,original.start+.4);const splitFile=path.join(dir,'split.mp4');await Media.exportProject(split,splitFile,options);const splitFrames=frames(splitFile);assert.equal(splitFrames.length,animated.length);let splitMax=0;for(let i=0;i<100;i++){const error=Math.abs(at(animated,i,48,48)-at(splitFrames,i,48,48));splitMax=Math.max(splitMax,error);assert.ok(error<=3,`split frame ${i}: ${error}`);}records.push({name:'nonlinear and hold split preserve all 100 frame intensities',maxError:splitMax,samples:100});
  let moving=project(opaque);for(const easing of curves){moving=M.addClip(moving,opaque.id);const id=moving.clips.at(-1).id;moving=M.updateClip(moving,id,{duration:1,transform:{x:-.25,y:-.15,scale:.2,rotation:0}});moving=M.setClipKeyframe(moving,id,.8,{x:.25,y:.15,scale:.35,rotation:70},{easing});}
  const geometryFile=path.join(dir,'moving.mp4');await Media.exportProject(moving,geometryFile,options);const geometry=frames(geometryFile);let centerMax=0,areaMax=0;
  for(let index=0;index<curves.length;index++)for(const local of [.1,.2,.4,.6,.75,.8,.9]){const pose=M.evaluateTransform(moving.clips[index],local),frame=index*20+Math.round(local*fps);let total=0,xx=0,yy=0;for(let y=0;y<H;y++)for(let x=0;x<W;x++){const value=at(geometry,frame,x,y)/255;total+=value;xx+=(x+.5)*value;yy+=(y+.5)*value;}const centerError=Math.max(Math.abs(xx/total-(W/2+pose.x*W)),Math.abs(yy/total-(H/2+pose.y*H))),areaError=Math.abs(total-W*H*pose.scale**2)/(W*H*pose.scale**2);centerMax=Math.max(centerMax,centerError);areaMax=Math.max(areaMax,areaError);assert.ok(centerError<=1.1,`${curves[index]} position@${local}: ${centerError}`);assert.ok(areaError<=.06,`${curves[index]} scaled/rotated area@${local}: ${areaError}`);}
  records.push({name:'5 easing presets position/scale/rotation use the same per-frame time',maxCenterErrorPixels:centerMax,maxRelativeAreaError:areaMax,samples:35});
  let narrow=project(opaque);const windows=[[1e-8,1.0001e-8],[.99999998,.999999980001],[.499999999999,.500000000001]],narrowCases=[];
  for(const easing of ['ease-in','ease-out','ease-in-out'])for(const easingWindow of windows){narrow=M.addClip(narrow,opaque.id);const id=narrow.clips.at(-1).id;narrow=M.updateClip(narrow,id,{duration:.5,transform:{opacity:0},keyframes:[{time:.4,x:0,y:0,scale:1,rotation:0,opacity:1,easing,easingWindow}]});narrowCases.push({easing,easingWindow});}
  const narrowFile=path.join(dir,'narrow.mp4');await Media.exportProject(narrow,narrowFile,options);const narrowFrames=frames(narrowFile);let narrowMax=0;
  for(let index=0;index<narrowCases.length;index++)for(const time of [.1,.2,.3]){const expected=255*M.evaluateTransform(narrow.clips[index],time).opacity,actual=at(narrowFrames,index*10+Math.round(time*fps),48,48),error=Math.abs(expected-actual);narrowMax=Math.max(narrowMax,error);assert.ok(error<=3,`narrow ${JSON.stringify(narrowCases[index])}: ${actual} vs ${expected}`);}
  records.push({name:'near-zero/one and midpoint tiny easing windows remain finite in actual export',maxError:narrowMax,samples:27});
  const output=path.resolve(__dirname,'../outputs');await fs.mkdir(output,{recursive:true});await fs.copyFile(file,path.join(output,'映序_0.5蒙版像素验收.mp4'));await fs.copyFile(animFile,path.join(output,'映序_0.5缓动时序验收.mp4'));await fs.writeFile(path.join(output,'phase7-media-acceptance.json'),JSON.stringify({success:true,checkedAt:new Date().toISOString(),reference:'Independent standard quadratic curves and the documented source-coordinate signed-distance masks; no claim of matching proprietary preset curves.',checks:records},null,2));
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
