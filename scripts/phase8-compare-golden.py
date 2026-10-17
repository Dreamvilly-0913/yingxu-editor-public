"""Streaming decoded RGB/PCM comparison with the retained 0.5 demonstration."""
from pathlib import Path
import subprocess,json,hashlib,os,shutil
import numpy as np
root=Path(__file__).resolve().parents[1]
ff=os.environ.get('YINGXU_FFMPEG') or (str(root/'tools/ffmpeg.exe') if (root/'tools/ffmpeg.exe').is_file() else shutil.which('ffmpeg')) or 'ffmpeg'
old=root/'outputs/0.5.0-蒙版与缓动演示.mp4';new=root/'outputs/0.6.0-蒙版导出对比.mp4'
def compare(args,align):
 processes=[subprocess.Popen([ff,'-v','error','-i',str(p),*args,'pipe:1'],stdout=subprocess.PIPE,stderr=subprocess.PIPE,creationflags=subprocess.CREATE_NO_WINDOW) for p in (old,new)]
 count=0;total=0;maximum=0;unequal=0
 try:
  while True:
   blocks=[p.stdout.read(align) for p in processes]
   if not any(blocks):break
   if len(blocks[0])!=len(blocks[1]):raise AssertionError('Decoded lengths differ')
   a=np.frombuffer(blocks[0],dtype=np.uint8).astype(np.int16);b=np.frombuffer(blocks[1],dtype=np.uint8).astype(np.int16);d=np.abs(a-b)
   count+=d.size;total+=int(d.sum());maximum=max(maximum,int(d.max(initial=0)));unequal+=int(np.count_nonzero(d))
  for p in processes:
   assert p.wait()==0,p.stderr.read().decode('utf-8',errors='replace')
 finally:
  for p in processes:
   if p.poll() is None:p.kill();p.wait()
 return {'bytes':count,'maxByteDifference':maximum,'meanByteDifference':total/max(count,1),'unequalBytes':unequal,'exact':unequal==0}
video=compare(['-an','-pix_fmt','rgb24','-f','rawvideo'],1280*720*3)
audio=compare(['-vn','-ar','48000','-ac','2','-c:a','pcm_s16le','-f','s16le'],192000)
assert video['maxByteDifference']<=4,video
assert audio['exact'],audio
report={'success':True,'baseline':str(old),'optimized':str(new),'method':'Streaming all decoded RGB bytes and PCM s16le bytes; no patch-only comparison. Same retained 7.4s/720p project.','video':video,'audio':audio,'baselineSha256':hashlib.sha256(old.read_bytes()).hexdigest(),'optimizedSha256':hashlib.sha256(new.read_bytes()).hexdigest()}
(root/'outputs/phase8-golden-demo-comparison.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
print(json.dumps(report))
