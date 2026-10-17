from pathlib import Path
import json, shutil, subprocess, hashlib, datetime, sys, os
root=Path(__file__).resolve().parents[1]; research=Path(os.environ.get('YINGXU_RESEARCH_ROOT',root/'research')).expanduser().resolve(); ro=research/'outputs/phase6-gui'; out=root/'outputs'; assets=out/'phase6-comparison-assets'; source=out/'phase6-original-comparison-packaged/acceptance.json'; source=source if source.exists() else out/'phase6-original-comparison/acceptance.json'; probe=root/'node_modules/ffprobe-static/bin/win32/x64/ffprobe.exe'
if not source.exists():raise SystemExit('Awaiting real replica acceptance.json; no placeholder report generated.')
a=json.loads(source.read_text(encoding='utf-8-sig'));
if a.get('packaged') and not all(a.get(k) is True for k in ['success','sourceUnchanged','bundleMatchesSource']):raise SystemExit('Final package acceptance is incomplete; refusing to present it as passed.')
original=json.loads((ro/'original-gui-comparison.json').read_text(encoding='utf-8-sig'));assets.mkdir(exist_ok=True);manifest=[]
def resolve(value,base):
 p=Path(value)
 if p.is_absolute():return p
 for b in [base,source.parent,root,research,ro]:
  q=b/p
  if q.exists():return q
 raise FileNotFoundError(value)
def copy(value,name,base=ro):
 p=resolve(value,base);target=assets/name
 if not p.is_file():raise FileNotFoundError(p)
 shutil.copyfile(p,target);manifest.append({'file':name,'source':str(p),'bytes':target.stat().st_size,'sha256':hashlib.sha256(target.read_bytes()).hexdigest()});return 'phase6-comparison-assets/'+name
def metadata(p):
 if Path(p).suffix.lower() not in ['.mp4','.mov','.mkv']:return None
 j=json.loads(subprocess.check_output([str(probe),'-v','error','-select_streams','v:0','-show_entries','stream=width,height,pix_fmt,color_range,color_space,color_transfer,color_primaries,r_frame_rate','-of','json',str(p)]));return j['streams'][0]
titles={'image-neutral':('图片 · 默认','图片默认导入与导出','原始RGB色卡，不应用调色。'), 'image-brightness20':('图片 · 亮度 +20','相同界面亮度 +20','两软件实际界面均设为 +20，归一化强度为 0.4。'), 'video709-neutral':('视频 · BT.709','完整 BT.709 视频往返','输入视频有限范围，矩阵/原色/传递函数均有 BT.709 标记。'), 'video601-neutral':('视频 · BT.601','完整 BT.601 视频往返','输入有限范围 SMPTE170M；检验矩阵转换后是否保留RGB编码值。')}
data={'generated':datetime.datetime.now().astimezone().isoformat(timespec='minutes'),'cases':[],'evidence':[],'packaged':bool(a.get('packaged')),'acceptanceFile':str(source),'sourceUnchanged':a.get('sourceUnchanged'),'bundleMatchesSource':a.get('bundleMatchesSource')}
for c in a['cases']:
 o=next(x for x in original['cases'] if x['id']==c['id']);id=c['id'];short,title,note=titles[id];inp=resolve(c['input'],root);r=c['replica'];oi=resolve(o['inputDecoded'],ro) if 'inputDecoded'in o else inp
 da={'input':{'frame':copy(oi,id+'-input.png')},'original':{'frame':copy(o['decoded'],id+'-jianying-frame.png'),'video':copy(o['output'],id+'-jianying.mp4'),'screenshot':copy(o['preview'],id+'-jianying-gui.png')},'replica':{'frame':copy(r['decoded'],id+'-yingxu-frame.png',root),'video':copy(r['output'],id+'-yingxu.mp4',root),'screenshot':copy(r['previewScreenshot'],id+'-yingxu-gui.png',root),'canvas':copy(r['previewCanvasPng'],id+'-yingxu-canvas.png',root)}}
 if inp.suffix.lower()=='.mp4':da['input']['video']=copy(inp,id+'-input.mp4')
 rows=[]
 for p in c['samples']:
  q=dict(p);q['sourceRGB']=next(s['sourceRGB'] for s in o['samples'] if s['index']==p['index']);rows.append(q)
 data['cases'].append({'id':id,'shortTitle':short,'title':title,'note':note,'pass':bool(c['pass']),'assets':da,'inputMetadata':metadata(inp),'originalMetadata':metadata(ro/o['output']),'replicaMetadata':metadata(resolve(r['output'],root)),'metrics':c['metrics'],'originalSelf':o['metrics']['exportVsPreview'],'samples':rows,'replicaCanvasKind':c.get('replicaCanvasKind')})
for p,name,label in [(source,'replica-acceptance.json','最终交付包与原软件对比 JSON' if a.get('packaged') else '映序源码版与原软件对比 JSON'),(ro/'original-gui-comparison.json','original-gui-comparison.json','剪映原GUI与SPS证据'),(ro/'gui-color-samples.json','gui-color-samples.json','原GUI参数范围与色块数值'),(ro/'README_整机比较.md','original-gui-method.md','原软件操作与方法记录')]:data['evidence'].append({'label':label,'path':copy(p,name)})
for name,label in [('phase6-color-root-cause.md','色差根因与修复记录'),('phase6-color-normalized.json','输入规范化对照')]:
 p=out/name
 if p.exists():data['evidence'].append({'label':label,'path':copy(p,name)})
html=(root/'work/phase6-comparison-template.html').read_text(encoding='utf-8-sig').replace('__COMPARISON_DATA__',json.dumps(data,ensure_ascii=False,separators=(',',':')).replace('</','<\\/'))
p=out/'0.4.0-色彩与整机对比.html';p.write_text(html,encoding='utf8');(assets/'file-manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf8');(assets/'page-data.json').write_text(json.dumps(data,ensure_ascii=False,indent=2),encoding='utf8');print(json.dumps({'page':str(p),'cases':len(data['cases']),'files':len(manifest),'allPassed':all(c['pass']for c in data['cases'])},ensure_ascii=False))
