# 障碍物检测模型

本仓库不附带或自动下载模型。请在有网的机器上安装 ultralytics，然后执行：

```sh
yolo export model=yolov8n.pt format=onnx
```

将导出的 `yolov8n.onnx` 复制到本目录。后端使用 onnxruntime CPU 推理，支持标准 YOLOv8 `(1,84,N)` 或 `(1,N,84)` 输出。文件缺失或加载失败时禁用检测，真实视频仍可查看；Mock 注入不依赖模型。

Ultralytics 使用 AGPL 许可证，比赛开源按其许可要求提交；商用前需要换模型或获得授权。

标准 COCO 80 类没有 `box`，默认白名单中的该类只用于 Mock；不能期待通用模型识别纸箱。现场应先用人、椅子等已支持类别验证。四足画面朝向、通行区域和阈值均需现场标定。
