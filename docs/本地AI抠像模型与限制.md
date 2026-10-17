# 本地 AI 背景去除

图片输出透明 PNG，视频输出保留透明通道的 VP9 WebM，可作为新素材继续裁剪、叠层、蒙版和导出。生成文件与原文件分开，原文件保持不变。

模型为 **U²-NetP**：在本机 CPU 上以 320 × 320 进行显著物体分割，再将软遮罩缩放到原画幅，并乘以原素材已有透明度。视频对每一帧独立推理，保留原声音轨；没有时序跟踪，快速动作、细发丝、透明物体、细小主体、多个主体及复杂背景可能出现误分或边缘闪动。它与剪映模型不同，不承诺与剪映的抠像结果相同。CPU 处理速度受时长、帧率、画幅和机器性能影响，处理过程可取消。

透明视频需要支持 alpha 的解码器。本软件使用 libvpx-vp9 解码进行输出处理；普通外部播放器可能显示黑底。最终普通 MP4 会把透明区域与工程中下方画面合成，没有下方画面处显示黑色。

## 来源与许可

- [U-2-Net 官方项目](https://github.com/xuebinqin/U-2-Net)，Apache-2.0；完整许可在 `tools/ai/LICENSE-U-2-Net.txt`。
- [rembg 的 U2NetP 会话与下载记录](https://github.com/danielgatis/rembg/blob/main/rembg/sessions/u2netp.py)提供 ONNX 转换模型和公布的 MD5。模型由维护者的 [GitHub Release](https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2netp.onnx)获取。
- [Microsoft ONNX Runtime Node.js](https://github.com/microsoft/onnxruntime/tree/main/js/node)，固定版本 1.30.0，MIT；完整许可在 `tools/ai/LICENSE-onnxruntime.txt`，依赖自带第三方声明。官方列明支持 Windows x64 CPU 与 Electron。

模型文件 4,574,861 字节；SHA-256 为 `309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8`。来源、哈希、推理尺寸和运行时版本记录在 `tools/ai/model-manifest.json`。模型、原生运行时依赖不进入 Git 源码仓库；从源码运行时执行 `node scripts/bootstrap-ai.cjs`，按锁文件安装依赖并校验模型。

## 本轮实际验证

`scripts/phase10-ai-smoke.cjs` 在真实 ONNX Runtime CPU 上验证透明 PNG 和有声音的移动视频，并检查原素材不变、输出 RGB 和 alpha、保留既有透明度、进度、推理中取消和拒绝覆盖已有文件。官方上游测试照片仅下载到忽略的 `work/` 供本机测试；首次没有测试照片时加 `--download-fixture`。实际结果以 `outputs/phase10-ai-source/acceptance.json` 及打包版对应报告为准。
