# 人物与机器狗的 Blender 动画工程

打开 `Furward_Characters_Animated.blend`，在时间轴按空格即可播放两秒、2.4 米的直线行走预览。工程由 Blender 5.2.2 LTS 保存，贴图已打包；人物在机器狗后方 2.2 米。原城市工程仍在相邻的 `city/` 目录。

每个角色保留五个动作：`idle`、`walk`、`turn_left`、`turn_right`、`stop`。动作分别以 `human_`、`dog_` 开头。NLA 中的 `REVIEW — 1.2 m/s walk` 轨道负责当前短距离预览；查看或修改其他动作前先静音该轨道，再在动作编辑器中选择对应动作。需要原地查看时，再选中对应的 `human_route_translation` 或 `dog_route_translation` 父节点，静音其 `REVIEW — route translation` 轨道。

人物与机器狗的外形、材质、贴图来自原交付模型。骨架、权重与原地动作由 `scripts/rig-models.py` 生成；这个 Blender 工程导入最终 GLB，并增加可编辑的场景、摄影机、光照和直线路径父节点。它提供建模同学可继续编辑的工程，不会自动覆盖网页的 GLB。

网页使用 `web/public/city/animated/` 中的模型，路线控制整体位移；起停混合和逐脚贴地由网页运行时代码控制。此 Blender 场景只复现直线行走，不包含网页的城市地形约束。

在工程根目录复现：

```sh
blender --background --python-exit-code 1 --python scripts/build-blender-review.py
```

会重新生成 `.blend`、`blender-validation.json` 和 `docs/screenshots/blender-walk-*.png`。验证以 60Hz 采样 121 帧，确认两角色各移动 2.4 米，脚底没有穿过预览地面。覆盖前请另存你手动编辑过的 `.blend`。
