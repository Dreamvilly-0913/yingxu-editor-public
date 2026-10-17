/* Builds the current release report from completed final-package evidence. */
'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),out=path.join(root,'outputs'),version=require('../package.json').version;assert.equal(version,'0.7.0');
function read(name){const d=JSON.parse(fs.readFileSync(path.join(out,name),'utf8'));assert.equal(d.success,true,name);assert.equal(d.version,version,name);return d;}
const color=read('phase9-legacy-color-packaged/acceptance.json'),frames=color.scenarios.flatMap(s=>s.frames),engine=read('phase9-engine/packaged/acceptance.json'),ui=read('phase9-ui-packaged/acceptance.json'),layout=read('phase9-ui-packaged/layout-acceptance.json'),grade=read('phase9-curve-grade-packaged/acceptance.json'),gpu=read('phase9-advanced-color-gpu-packaged/acceptance.json'),media=read('phase9-advanced-color-media-packaged/acceptance.json'),demo=read('phase9-delivery-demo.json'),asr=read('phase9-curve-asr-packaged/acceptance.json');
for(const name of ['phase9-gesture-guards-packaged.json','phase9-project-files-packaged.json','phase9-recovery-packaged.json','phase9-recovery-ui-races-packaged.json','phase9-project-switch-guard-packaged.json','phase9-legacy-ui-packaged-acceptance.json','phase9-mask-seek-packaged.json','v7-packaged-acceptance.json','v7-advanced-packaged-acceptance.json','v7-bundled-demo-acceptance.json','v7-media-lifecycle-packaged.json','v7-preview-reuse-acceptance-packaged.json'])read(name);
const canvasMax=Math.max(...frames.map(f=>f.compositeCanvasExportDelta.max)),displayMax=Math.max(...frames.map(f=>f.previewExportDelta.max)),movingMax=Math.max(...grade.comparisons.map(f=>f.max)),movingMean=Math.max(...grade.comparisons.map(f=>f.mean));
const text=`# 映序剪辑 0.7.0 · 时间线与素材管理验收

本轮完成安装包差距清单中的 W01 时间线基础编辑与 W02 素材和工程管理，交付独立 Windows 0.7.0 程序。保留 0.6.0 及其历史证据。本轮没有重新执行原剪映全部功能的整机等价比较，不宣称兼容剪映私有草稿。

## 已补足的功能

| 类别 | 0.7 行为 |
| --- | --- |
| 时间线直接编辑 | 拖动移动、首尾手柄修剪；向外延伸受源素材边界约束；单次拖动对应一次撤销 |
| 多选 | Ctrl／Shift 点击、空白框选、Ctrl+A；一起移动／删除；Ctrl+C／V 复制粘贴快照，保留相对位置并创建新 ID |
| 排列与吸附 | 主轨磁吸可关闭，自由时间线保留空隙；独立边缘／播放头吸附，Alt 临时关闭 |
| 离线素材 | 打开／恢复仍保留占位、路径和原因；支持单文件重链接、文件夹按原名匹配；重名不猜选 |
| 工程文件 | 另存为；独立文件夹归档工程和全部原素材，相对路径可搬运，附素材 SHA-256 清单 |
| 操作保护 | Esc／失焦取消草稿、无效落点拒绝、模态期间不提交、打开另一工程后旧拖动失效；边界不产生空撤销 |
| 素材栏 | 按名称搜索，离线状态和工程工具入口 |

修剪在保留区间内保持曲线变速、关键帧和音量包络映射；向外扩展新增区间使用端点速度、姿态和音量。已裁掉的内部曲线形状可通过撤销恢复，重新延伸不自动恢复它。

另存为只在成功后切换当前工程路径。归档新建目录并复制素材，不覆盖原文件或切换当前工程保存位置。缺失素材占位可继续编辑和保存；有被使用的离线素材时阻止导出／识别并说明原因，未使用的离线素材不阻止导出。归档要求全部素材在线。

## 实际验收

单元测试 **73/73** 通过，失败、跳过和取消均为 0，日志为源码项目的 \`work/unit-v7.log\`。最终包另外完成下列实际 Electron／FFmpeg／Whisper 检查；各行是不同范围的检查组，不能视为原剪映功能覆盖率。

| 验收范围 | 结果 |
| --- | --- |
| 新时间线与工程 UI | ${ui.checks.length} 组，真实鼠标和快捷键；另完整／紧凑布局 ${layout.checks.length} 组 |
| 新媒体引擎 | ${engine.checks.length} 组，使用包内 FFmpeg 与 FFprobe |
| 拖动与异步切换保护 | 8 组 |
| 工程文件／恢复／保存竞态／切换锁 | 12／12／8／6 组 |
| 原导入编辑与多轨字幕 | 10／13 组 |
| 原蒙版缓动／曲线变速高级调色 UI | 11／11 组，实际导出 MP4 |
| 媒体生命周期／预览复用 | 6／20 组，另 4 组 Range 请求 |
| 蒙版快速定位 | 8 个时间点 |
| 五个随包工程 | 18 项打开／预览／参数检查 |
| 高级调色 GPU／编码媒体 | ${gpu.cases.length}／${media.cases.length} 组 |
| SDR 预览与导出 | ${color.scenarios.length} 个场景、${frames.length} 个采样帧 |
| 曲线变速后的真实自动字幕 | ${asr.checks.length} 组，生成可编辑字幕 |

新引擎的 54 帧主轨空隙样片中，空隙区 516,096 个解码 RGB 通道值全部为 0；对应没有音频的 WAV 时间段为精确静音。双端非整帧修剪后 44 个保留画面帧和头部扩展后的 4 个新增帧／44 个保留帧均对应正确。受测的一个旧磁吸工程导出 MP4 与 0.6 的 SHA-256 完全相同。取消导出保留已有目标文件，清理本次任务的中间文件。

## 色彩与比较的范围

本轮保持 0.6 的 SDR 显示兼容策略。静态色卡内部采样：Canvas 与解码导出最大差 ${canvasMax}/255，同一显示环境的预览截图与导出最大差 ${displayMax}/255。高级调色 GPU 与 CPU 公式受测最大差 1/255，五组编码媒体的平坦色块内部最大差 3/255。

这些数据不能推广到高频画面全幅。曲线＋高级调色运动短片的 ${grade.comparisons.length} 个采样画面，本轮受测区域最大差 ${movingMax}/255、各帧平均差最大 ${movingMean.toFixed(3)}/255；细线、色块边界、缩放与 H.264 4:2:0 色度采样会放大局部差异。完整数字与采样定义保存在原始报告中。本轮没有重跑 0.6 的高分辨率蒙版性能基准，历史 5.5–6.3 倍数据仍只属于原测试条件。

## 试用与演示

先保存并关闭仍在使用的旧版，再运行新版目录里的 \`映序剪辑.exe\`；不移动单个 exe，保留整个独立目录。源码项目根目录的启动脚本在最终校验成功后指向 0.7。

在“打开”里选择 \`resources/app/assets/demo/自由时间线与素材管理演示.yxproj\`。它包含自由主轨空隙、第二视频轨、曲线变速、蒙版、音频和操作提示字幕。工具栏“打开演示”仍为原基础示例。

随包 \`演示成片/自由时间线与素材管理演示.mp4\` 为真实导出：1280×720、30 fps、${demo.actual.video.nb_frames||demo.expected.frames} 帧，${Number(demo.actual.duration).toFixed(3)} 秒；与模型时长误差 ${(demo.validation.modelDurationErrorSeconds*1000).toFixed(2)} ms，小于一帧。H.264／AAC、48 kHz 双声道，BT.709／sRGB／全范围标签，faststart 和整段音视频解码均通过。

[完整界面截图](evidence/phase9/phase9-ui-packaged/时间线完整界面.png) · [紧凑界面截图](evidence/phase9/phase9-ui-packaged/时间线紧凑界面.png) · [工程管理截图](evidence/phase9/phase9-ui-packaged/工程管理与重链接.png)

## 可复查证据与继续开发

本版原始报告、界面截图和索引在 \`docs/evidence/phase9/\`。源码和正式包的 \`src/\`、\`assets/\`、\`docs/\` 必须逐文件一致；最终门禁另核对完整交付目录的文件集合、字节数与 SHA-256，并核验被测源码、包内工具、演示视频和旧 0.6 的 537 个文件。

最终记录为源码项目 \`outputs/final-acceptance-v0.7.0.json\`。它不放进其自身校验的包内，避免循环哈希。归档后如修改说明，运行 \`scripts/finalize-v7.cjs --sync-docs\` 并重新执行门禁；产品源码变动必须重建和重测，不能借同步说明替换。

当前边界：自由主轨仅允许显式转场的重叠，修改转场须先开启磁吸；混合主轨与其它类型片段一起移动时需自由主轨；多选尚不支持批量属性或批量分割。下一批是独立音频轨和波形、更完整的字幕编辑等剩余差距；HDR／任意 ICC／广色域、外部 LUT／色轮／示波器、任意 Bézier 变速手柄、复杂特效和云端 AI 仍未完成。当前机器的合成短片验收不代表任意长片、多机器或全功能等价。
`;
fs.writeFileSync(path.join(root,'docs/0.7.0-时间线与素材管理验收.md'),text);console.log(JSON.stringify({written:true,version,scenarios:color.scenarios.length,frames:frames.length,canvasMax,displayMax,movingMax}));
