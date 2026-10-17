from pathlib import Path
import json
from PIL import Image, ImageDraw, ImageFont
root=Path(__file__).resolve().parents[1]
folder=root/'outputs/phase8-ui-color-diagnosis'
report=json.loads((folder/'diagnosis.json').read_text(encoding='utf-8'))
frame=next(item for item in report['frames'] if item['time']==0.8)
font=ImageFont.truetype('C:/Windows/Fonts/msyh.ttc',23)
small=ImageFont.truetype('C:/Windows/Fonts/msyh.ttc',18)
title=ImageFont.truetype('C:/Windows/Fonts/msyh.ttc',30)
gap=20;tile_width=640;tile_height=360;width=tile_width*3+gap*4;height=600
canvas=Image.new('RGB',(width,height),'#15191e');draw=ImageDraw.Draw(canvas)
draw.text((gap,14),'0.8 秒同源帧：预览、实际导出和颜色差',fill='#f0f3f5',font=title)
draw.text((gap,58),'0.6.0 独立程序实测 · 原片帧 12 / 输出帧 20 · 320×180 · 每像素完整 RGB 对照',fill='#b3bdc8',font=small)
items=[('preview-0.8.png','预览 Canvas RGB'),('actual-export-0.8.png','实际 MP4 / FFmpeg RGB 解码'),('difference-heatmap-0.8.png','绝对差热图：每像素最大通道差')]
for index,(name,label) in enumerate(items):
 x=gap+index*(tile_width+gap)
 draw.text((x,95),label,fill='#f0f3f5',font=font)
 image=Image.open(folder/name).convert('RGB').resize((tile_width,tile_height),Image.Resampling.NEAREST)
 canvas.paste(image,(x,131))
metric=frame['comparisons']['previewVsActual']
draw.text((gap,510),f"全图平均差 {metric['all']['mean']:.3f}/255，最大差 {metric['all']['max']}/255；输入平坦区平均差 {metric['flat']['mean']:.3f}，最大差 {metric['flat']['max']}。",fill='#f0f3f5',font=small)
draw.text((gap,543),'热图：黑=0，红=64，黄=128，白=255。源边缘色度重建差异已存在于调色前；GPU 与同源 CPU 计算最大差 1。',fill='#b3bdc8',font=small)
file=folder/'0.8秒-预览导出与差异热图.png';canvas.save(file)
print(file)
