# 映序剪辑 · Yingxu Editor

一个面向 Windows x64 的本地桌面视频编辑器，当前源码版本 **0.8.0**。Electron 界面、FFmpeg 媒体处理、本地 Whisper 字幕与 ONNX 图像前景提取组成独立工作流。

这是独立实现的软件。架构研究用于确定可验证的功能边界；仓库不含剪映安装包、商业素材、私有着色器、登录数据，也不宣称与剪映全部功能、算法或私有草稿格式兼容。

## 当前功能

- 视频多轨、自由时间线和主轨磁吸；首尾拖动修剪、吸附、多选、复制粘贴、成组、关键帧与转场。
- 曲线变速、裁剪、位置缩放与透明度动画；矩形/椭圆蒙版、扩张、圆角和蒙版关键帧。
- 独立音频轨、波形、静音/独听/锁轨、原声分离、音量包络、降噪与响度处理。
- 自动字幕、UTF-8 SRT 导入/导出、字幕样式、独立文字，以及字幕/文字的批量编辑。
- 基础/高级调色、Bezier RGB 与独立 Y 曲线、四个色轮、分区色彩、六维 HSL 选区、本地 `.cube` LUT 导入。
- 色度抠像、去溢色、边缘平滑，及 12 种透明混合模式。
- 显式素材预处理：运动插帧、防抖与 PQ/HLG 到 SDR 的独立转换文件；本地 U2NetP 前景提取输出透明素材。
- 缺失素材占位/重链接、另存为、素材归档、恢复副本和缓存管理；MP4/WAV、区间、质量与可用编码器设置。

具体数据和已测范围以 `docs/` 本轮验收说明、`docs/evidence/phase10/` 静态记录及本地生成的 `outputs/` 报告为准。大尺寸图片的动态蒙版导出仍有明确性能限制，不能沿用旧静态蒙版提速结论。**剩余边界**包括云端 AI、商业模板/特效库、任意第三方草稿兼容和全面的跨机器/长片验证。U2NetP 是通用显著前景模型，不保证所有人物/头发/半透明边缘的分割精度；当前透明视频链明确支持 VP9 alpha，PNG 支持原始透明度。HDR 需要先显式预处理，不是 HDR 编辑/监看/导出。

## 从源码启动

需要 **Windows 10/11 x64、Node.js 24 和 npm**。首次下载依赖时需要网络，正常本地剪辑和推理无需上传素材。

```powershell
git clone https://github.com/Dreamvilly-0913/yingxu-editor-public.git
cd yingxu-editor-public
npm ci
npm run setup:media
npm run setup:asr
npm run setup:ai
npm start
```

`setup:media` 显式下载约 110 MB 的 Gyan FFmpeg 9.0.2 essentials Windows 构建，校验固定大小与 SHA-256 后装入 `tools/`，保留已有工具。FFmpeg 上游[下载页](https://ffmpeg.org/download.html)列出该[Windows 构建提供方](https://www.gyan.dev/ffmpeg/builds/)；上游只直接发布源码。锁定地址与校验值见 [`docs/media-dependencies.json`](docs/media-dependencies.json)，它们不是旧版本测试输出逐字节复现的保证。

如已安装 FFmpeg，可自行放置 `tools/ffmpeg.exe` / `tools/ffprobe.exe`，或设置环境变量。建议 FFmpeg 构建包含 libx264、libass、libvpx、libvidstab、libzimg 与 rubberband。执行下列命令检查：

```powershell
$env:YINGXU_FFMPEG = 'C:/path/to/ffmpeg.exe'
$env:YINGXU_FFPROBE = 'C:/path/to/ffprobe.exe'
node scripts/bootstrap-media.cjs --check
```

`ffprobe-static` 与 Electron 在 `package-lock.json` 锁定；Playwright Core 只供测试使用，不必另装浏览器，GUI 测试启动项目自带的 Electron。环境发现集中在 `scripts/test-env.cjs`：显式变量、项目 `tools/`、npm/PATH 优先；旧开发机器路径仅为末尾兼容回退，`YINGXU_ALLOW_WORKSTATION_FALLBACK=0` 可禁用。

`setup:asr` 安装已锁定并校验的 Whisper CPU 工具、多语言 base 模型和 VAD（模型约 149 MB），来源/许可写在安装脚本及安装后清单中。`setup:ai` 使用 `tools/ai/runtime/package-lock.json` 安装固定 ONNX Runtime Node 依赖，并校验约 4.6 MB 的 U2NetP 模型；不需要 Python 或独立虚拟环境。AI 模型说明/许可保存在 `tools/ai/model-manifest.json` 和相邻许可文本。缺少这些可选工具时，普通编辑仍可启动，相应功能会显示依赖说明。

## 测试与构建

```powershell
npm run test:model
npm test
node scripts/phase10-visual-signals.cjs
node scripts/phase10-visual-controls.cjs
node scripts/phase10-blend-export.cjs
npm run package
```

`test:model` 是明确列举的纯算法/文件系统测试集，**不启动 FFmpeg、Electron、ASR 或 AI**。GitHub Actions 仅运行此集合，不把未运行的媒体、显示器色彩、硬件编码、GUI、ASR/AI 测试列为通过。`npm test` 包含真实媒体处理测试，需要 FFmpeg/FFprobe；部分历史验证脚本还需要本地生成的演示和旧版本，不能当作新克隆的通用 CI。

历史 JSON 验收记录中的 `<project-root>`、`<research-root>` 和 `<tool-root>` 是移除原机器路径后的脱敏标记，记录对应原验收快照。它们不表示当前源码已重新运行全部历史测试，也不表示本公开仓库附带工具、安装包或模型。

三个 `phase10-visual-*` / `phase10-blend-export` 脚本分别验证 GPU/FFmpeg 信号、真实鼠标控件与预览/导出透明混合；其他本轮脚本覆盖音频、文字、预处理和 AI。测试使用独立隐藏窗口和 `work/` 用户目录。加 `--packaged` 时检查当前版本独立包，需先成功构建。

`npm run package` 生成 `outputs/映序剪辑-0.8.0-win-x64/`，需要完整的 Electron、FFmpeg、ASR 和 AI 运行时。输出目录已存在时会拒绝覆盖；构建物和模型不提交 Git。首次生成演示可运行 `npm run demo`，已有示例工程从界面“打开”选择 `assets/demo/*.yxproj`。

## 色彩与工程边界

工作链为显示 RGB 的 SDR 兼容模式。预览与导出共享独立调色参数，但导出 65³ LUT、缩放、文字栅格化、H.264 4:2:0 和显示器 ICC 不保证逐像素等价。专业调色 GPU 与导出均使用四面体插值；受测复杂 HSL 选区对直接数学值的最大差为 14/255，而同场景 GPU 对实际 FFmpeg LUT 最大差为 1/255。详细解释见 [`docs/专业调色与视觉效果算法说明.md`](docs/专业调色与视觉效果算法说明.md)。这些是指定场景的数据，不是对任意素材的上界承诺。

`.yxproj` 保存编辑数据与素材路径，不包含原视频。转移工程建议使用界面“归档工程”；LUT 数据嵌入工程，素材仍需归档。新版本字段请用当前版本打开，旧版不承诺前向兼容。用户工程、缓存、测试 profile 和最终成片应保留在本机。

## 仓库范围

公开展示仓库：[Dreamvilly-0913/yingxu-editor-public](https://github.com/Dreamvilly-0913/yingxu-editor-public)。此仓库以当前源码快照建立独立提交历史，不包含旧私有仓库的 Git 历史或 Release；程序、模型和测试输出需按上文在本地获取或生成。

保留 `src/`、`tests/`、可复现脚本、项目自建演示、文档与本轮验收记录，以及必要的模型来源/许可/锁文件。排除 `node_modules/`、`work/`、`outputs/`、程序二进制、模型权重、用户凭据和原软件资源。第三方组件遵守各自许可；本仓库名称与原软件不存在官方关联。
