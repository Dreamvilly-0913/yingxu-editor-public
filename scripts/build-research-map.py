from pathlib import Path
import json,hashlib,html,shutil,re,os
from datetime import datetime,timezone
P=Path(__file__).resolve().parents[1];R=Path(os.environ.get('YINGXU_RESEARCH_ROOT',P/'research')).expanduser().resolve();D=P/'docs';E=D/'evidence';E.mkdir(exist_ok=True)
run=R/'outputs/native-phase4-core';summary=json.loads((run/'results/targeted-summary.json').read_text(encoding='utf-8'));inv=json.loads((run/'invocation-final.json').read_text(encoding='utf-8'))
assert inv['success'] and inv['target_unchanged'] and summary['verified_functions']==6
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
def evidence(file,lines):
 src=run/'results'/file;shutil.copyfile(src,E/file)
 return {'file':'evidence/'+file,'lines':lines,'sha256':sha(src)}
facts=[
 {'id':'CORE01','module':'时间区间','observation':'TimeRange::patch_from_json 分别检测 start 和 duration 键，存在时更新 this+0x38 与 this+0x40 的64位值；缺键分支跳过对应更新。仅值变化后设置局部状态字段。','evidence':[evidence('TimeRange_patch_from_json-0x180b57820.c',[90,118])],'crosschecks':{'start_literal_va':'0x182ea11cc','duration_literal_va':'0x182ea11c0'},'inference':'支持独立的起点/时长字段与局部更新模型。','unknown':'时间单位、字段全部校验规则以及状态整数枚举未恢复。','implementation':'映序使用秒数 start/duration、sourceIn 与 speed；秒数及换算公式是独立设计，以测试验证。'},
 {'id':'CORE02','module':'片段源区间','observation':'SegmentVideo 与 SegmentAudio 的 source_time_range getter 同址0x1801a80c0；机器码488d8138010000c3，返回this+0x138成员地址，导出类型为const shared_ptr<TimeRange>&。','evidence':[evidence('Segment_source_time_range-0x1801a80c0.c',[69,77])],'inference':'源区间是可独立引用的对象；它不同于实际编码文件。','unknown':'大量其它类getter因相同机器码共享地址，不能将成员类型推广到所有别名。未由此证明目标区间或分割算法。','implementation':'素材保存原文件信息；片段单独记录sourceIn和时间线start/duration，分割时按speed换算源入点。'},
 {'id':'CORE03','module':'播放控制','observation':'Play/Pause分别构造不同回调表引用，在_Thrd_id及原子状态/计数控制区内调用虚表+0x10，然后降低计数并清理。','evidence':[evidence('PlayerWin_Play-0x1815597e0.c',[25,55]),evidence('PlayerWin_Pause-0x181559710.c',[25,55])],'inference':'公开播放接口通过内部回调转交，不是单个标志赋值。','unknown':'回调目标、底层解码器状态机、精确同步保证未恢复；负偏移来自接口this语境，不能直接作为全类字段。','implementation':'独立预览控制器以时间线时钟同步video/image/audio，并按片段源区间定位。'},
 {'id':'CORE04','module':'分割请求','observation':'VideoClient::splitVideo 调用内部0x1810565f0，再检查结果对象+0x4c；零或空的分支转交原结果，其它分支构造响应并复制此状态值。','evidence':[evidence('VideoClient_splitVideo-0x1817f8800.c',[57,119])],'inference':'该入口是请求/响应适配层；实际片段变换在更低层。','unknown':'状态码业务含义、分割算法及原始请求布局未恢复。反编译参数也少于导出签名，不能据此重建完整ABI。','implementation':'映序自有不可变模型将一个片段拆为两段，原素材不变，撤销保留前一快照。'},
 {'id':'CORE05','module':'导出入口','observation':'NewVEWrapper::export_start 先调用PlayerWin::Stop，准备关联对象，再依据ExportConfig+0xc的条件调用addWaterMark，最终转交0x18156cd50。导出签名含进度double回调及bool/Error*完成回调。','evidence':[evidence('NewVEWrapper_export_start-0x1815ad700.c',[65,75]),evidence('NewVEWrapper_export_start-0x1815ad700.c',[146,176])],'inference':'预览与导出具有不同生命周期；导出配置和回调是明确接口边界。','unknown':'底层编码参数、具体完成时机、条件字段正式名字均未恢复；代码中回调参数还有遗漏，不能声称完整调用约定已知。','implementation':'映序使用独立FFmpeg任务，进度事件/完成事件/取消，输出先到暂存路径，成功后发布到用户选择文件。'},
 {'id':'CORE06','module':'工程持久化','observation':'前一轮已经核实保存前路径占位符处理、临时/备份复制方向和事务登记。','evidence':[],'prior_record':str(R/'outputs/phase3-fileops-findings.json'),'inference':'素材引用与编辑状态可单独持久化，保存流程需考虑中断结果。','unknown':'剪映原生草稿编码和完整兼容协议未恢复。','implementation':'映序采用独立.yxproj JSON，素材相对路径；写入临时文件、sync、保留.bak再替换。没有声称原生草稿兼容。'}
]
for name in ['phase4-core-address-references.json','phase4-core-targets.json']:
 shutil.copyfile(R/'outputs'/name,E/name)
shutil.copyfile(run/'invocation-final.json',E/'phase4-invocation-final.json');shutil.copyfile(run/'results/targeted-summary.json',E/'phase4-summary.json')
pe=json.loads((R/'outputs/pe_dependencies.json').read_text(encoding='utf-8'));binary=next(x for x in pe['records'] if x['path']=='videoeditor.dll')
patterns={'媒体信息':r'^\?get_(path|duration|width|height)@Material(Video|Audio)@','时间线':r'^\?get_(target_time_range|segments)@(Segment|Track)@','字幕文本':r'^\?get_(content|font_size|text_color)@MaterialText@'}
symbols={k:[x for x in binary['exports'] if re.search(pattern,x['name'])][:8] for k,pattern in patterns.items()}
record={'version':1,'created_at_utc':datetime.now(timezone.utc).isoformat(),'goal':'核心剪辑优先，后续按模块扩展；全面逆向与全模块复现仍未完成','target_version':'11.4.1.14443','target_sha256':summary['source_sha256'],'method':'Independent Ghidra 12.1.4 selected-function analysis plus saved PE exports; no target execution','rea_evidence':False,'new_entries':6,'completed':6,'facts':facts,'additional_symbol_inventory':symbols,'symbol_inventory_limit':'这组仅证明导出接口存在，不能证明其内部实现、功能完整性或运行行为。','evidence_base_directory':str(D),'prior_research':str(R),'source_repository_design':'Independent Electron/FFmpeg implementation; no Jianying binaries, private drafts or branded resources included.'}
(D/'reverse-engineering-map.json').write_text(json.dumps(record,ensure_ascii=False,indent=2),encoding='utf-8')
(R/'outputs/phase4-core-findings.json').write_text(json.dumps(record,ensure_ascii=False,indent=2),encoding='utf-8')
backlog={
 'goal':'按已验证行为构建独立Windows视频编辑器，优先完成核心剪辑闭环，再逐模块扩展','user_priority':['导入','时间线','预览','字幕','导出'],
 'core_acceptance':[{'area':'导入','criteria':'本地视频/图片/音频可探测、缩略图、加入素材库，无网络依赖'},{'area':'时间线','criteria':'分割/裁剪/排序/删除/恒定变速/音量/撤销重做；源区间不越界'},{'area':'预览','criteria':'播放暂停、时间定位、视频与图片跨片段切换、字幕与音轨同步'},{'area':'字幕','criteria':'手动编辑或UTF-8 SRT导入；时间与文字进入预览及实际成片'},{'area':'导出','criteria':'真实H264/AAC MP4；分辨率/帧率/进度/取消；失败不覆盖既有输出'},{'area':'工程','criteria':'.yxproj保存重开，素材相对路径、备份、未保存提示'}],
 'next_stages':[{'area':'剪辑精度与性能','todo':['逐帧同步/代理素材/长片和大量片段压力测试','拖动裁剪、吸附与多轨剪辑策略','预览与渲染色彩/字体/音频一致性']},{'area':'多层画面','todo':['多视频轨、叠加与透明度','变换/裁切/转场','关键帧与曲线变速']},{'area':'视觉与声音','todo':['调色、滤镜、音频淡入淡出和降噪','文字样式、动画与模板','自动语音识别及字幕编辑']},{'area':'高级素材与AI','todo':['素材管理与自有资源库','可替代的本地或授权AI服务设计','网络/账号/云端需独立实现和真实服务验收，不能从客户端恢复服务端源码']}],
 'completion_rule':'每个模块同时记录静态/运行证据、实现状态与可重现测试；符号名/反编译数量不能充当完成率。当前总体状态为进行中。'}
(D/'scope-and-acceptance.json').write_text(json.dumps(backlog,ensure_ascii=False,indent=2),encoding='utf-8')
h=html.escape
parts=['<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>映序 · 逆向证据与实现映射</title><style>body{font:16px/1.85 Segoe UI,Microsoft YaHei,sans-serif;background:#f3f5f1;color:#263b37;margin:0}main{max-width:980px;margin:auto;padding:40px 24px}h1{font-size:32px}article{background:white;padding:24px;margin:20px 0;border:1px solid #cedbd3;border-radius:10px}.note{border-left:4px solid #658879;padding-left:18px;color:#4c5f56}code{font:13px Consolas,monospace;overflow-wrap:anywhere}a{color:#247064}small{color:#687c73}</style><main><h1>从逆向证据到独立实现</h1><p>本轮补充 6 个原生入口，完成情况为 6/6，目标 DLL 哈希未改变。结合此前的草稿分析，明确核心编辑器的模块边界。</p><p class="note">当前交付目标是可使用的核心剪辑初版。全面逆向与完整剪映复现尚未完成；客户端安装包也不包含云端服务实现。以下分别记录事实、解释、实现选择和剩余问题。</p>']
for f in facts:
 parts.append('<article><small>'+f['id']+'</small><h2>'+h(f['module'])+'</h2><p><b>观察：</b>'+h(f['observation'])+'</p><p><b>解释：</b>'+h(f['inference'])+'</p><p><b>映序实现：</b>'+h(f['implementation'])+'</p><p class="note"><b>边界：</b>'+h(f['unknown'])+'</p>')
 for e in f['evidence']:parts.append('<p><a href="'+h(e['file'])+'">'+h(Path(e['file']).name)+'</a> · L'+str(e['lines'][0])+'–'+str(e['lines'][-1])+'</p>')
 parts.append('</article>')
parts.append('<h2>证据和任务清单</h2><p><a href="reverse-engineering-map.json">完整映射 JSON</a> · <a href="scope-and-acceptance.json">范围与验收清单</a> · <a href="evidence/phase4-summary.json">函数体校验摘要</a></p><p>技术参考：<a href="https://www.electronjs.org/docs/latest/tutorial/context-isolation">Electron 进程隔离</a>、<a href="https://www.electronjs.org/docs/latest/api/protocol">媒体协议</a>、<a href="https://ffmpeg.org/ffmpeg-filters.html">FFmpeg 滤镜文档</a>。这些文档指导独立实现，不是剪映行为证据。</p><p><small>独立 Ghidra 结果，非 REA Evidence。所有 VA 仅适用于记录的目标哈希。</small></p></main></html>')
(D/'逆向证据与实现映射.html').write_text(''.join(parts),encoding='utf-8')
print(json.dumps({'facts':len(facts),'new_entries':6,'map':str(D/'逆向证据与实现映射.html')},ensure_ascii=False))
