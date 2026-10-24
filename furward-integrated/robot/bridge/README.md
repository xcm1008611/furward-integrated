# T1 WebSocket 桥接 · v0.6

桥接主动连接后端，默认使用内存 MockAdapter。Python 兼容 3.10；本机不安装依赖、不修改 `.venv`。
SDK 原始定义仅用作接口依据，未复制任何 SDK 实现，见 [vendor 说明](vendor/README.md)。

## 先在 Mac 验证链路

在 ver2/backend 终端启动：

```sh
ROBOT_BACKEND=bridge ../.venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000
```

另一个终端在 ver2 根目录启动：

```sh
.venv/bin/python bridge/bridge.py --adapter mock
```

已激活环境时可用 `python bridge/bridge.py --adapter mock`。打开 `/debug`，确认在线（bridge），
验证站起、移动、转向和停止。桥接 Mock 模拟耗时，不提供相机图片；后端默认 mock 视觉仍可展示画面。

## T1 大脑板 / Ubuntu 22.04 + ROS2 Humble

先确认设备负责人提供的 ROS2 与 aimdk_msgs 安装环境。工作区路径使用设备实际值：

```sh
source /opt/ros/humble/setup.bash
source /实际路径/aimdk工作区/install/setup.bash
python3 -c 'import rclpy, aimdk_msgs'
git clone https://github.com/PrimebotTech/primebot-t1-sdk.git
cd primebot-t1-sdk
git checkout a460300013003b29b9ad291b1b857b0afe295b22
export T1_SDK_PATH="$PWD"
cd /实际路径/Moonstone/ver2
export BACKEND_URL=ws://电脑热点IP:8000/ws/bridge
export BRIDGE_TOKEN='与后端一致的令牌'
python3 bridge/bridge.py --adapter t1 --sdk-path "$T1_SDK_PATH"
```

机器人 Python 环境需要 `websockets`；rclpy 和 aimdk_msgs 来自已 source 的 ROS2 环境。
后端配置 `ROBOT_BACKEND=bridge`，非空 `BRIDGE_TOKEN` 必须两端一致。
真机状态切换最多 30 秒、Mimic 还需等待完成，建议后端 `CMD_DEADLINE_S=60`，避免默认 20 秒提前取消较慢动作。

参数 / 环境变量：

| 参数 | 环境变量 | 默认 |
| --- | --- | --- |
| `--backend` | `BACKEND_URL` | `ws://127.0.0.1:8000/ws/bridge` |
| `--token` | `BRIDGE_TOKEN` | 空 |
| `--adapter` | `BRIDGE_ADAPTER` | `mock` |
| `--sdk-path` | `T1_SDK_PATH` | 空；t1 必填 |
| `--mimic-operation` | 无 | `0` 不设置；可选 `2`（EXECUTION） |
| `--camera-id` | `CAMERA_ID` | `head_stereo_left` |
| `--input-source-name` | `INPUT_SOURCE_NAME` | `moonstone_nav` |
| `--input-source-priority` | `INPUT_SOURCE_PRIORITY` | `30`，仅允许 SDK 建议的 20–39 |
| `--heartbeat-timeout` | `HEARTBEAT_TIMEOUT` | `3.0` 秒 |

输入源不能与 `rc`、`pnc`、`interaction`、`vr`、`app_proxy`、`coreon_fusion` 重名。
断线指数退避重连，最长 5 秒；token 错误时明确提示并改为每 10 秒重连；每秒报告状态，超过心跳阈值停止一次，收到新 ping 后重新布防。
Ctrl+C / SIGTERM 先停止，再删除输入源并释放节点。主节点在线程中 spin，状态机使用独立节点，避免 executor 冲突。

## 真机验证顺序

以下顺序来自 `../docs/后端开发计划.md` 第 7 节阶段 B（相对 ver2 根目录）：

1. 在大脑板或 Ubuntu 上确认 ROS2 环境和 `aimdk_msgs` 可用；运行 SDK 原版示例：`get_bms_state.py`、`get_asr_result.py`。
2. 只读状态：电量、`GetMcAction` 正常上报。
3. `speak`、`led`，不涉及运动。
4. `stand_up` 和 `posture` 状态切换（演示区清场，有人手持遥控器）。
5. `mimic` 准备动作（GREET / HEED / GLANCE），核对四足形态下动作能否执行、耗时多少。如果打招呼动作被接受但不执行，改用 `--mimic-operation 2` 再试。
6. `move` / `turn` 低速短距离测试，标定比例系数；验证 stop 与看门狗（主动断开后端连接，机器狗应停下）。
7. 室内整条路线连续跑 3 次。

## 安全与待验证事项

- 全程手持遥控器、清场。输入源优先级默认 30，低于遥控器 80。
- stop 仅置零速度，连续发布零速度 0.3 秒后停止发布；不切换阻尼或零力矩。不使用跳跃、后空翻或双足动作。
- 正角度左转，`angular_velocity` 正值为逆时针；**方向待真机确认**。距离与角度按后端标定系数换算，桥接不再标定。
- 速度流 50 Hz；任一分量必须为 0 或绝对值 ≥0.2；执行前必须已处于稳定四足行走状态。
- SDK 状态切换通过取消回调终止后续切换；已被底层接受的姿态/Mimic 动作不保证立即中断，仍需遥控器接管。
- TTS 成功代表入队，按 0.2 秒/字估时，`detail.estimated=true`。trace_id 使用桥接命令 ID；直接调用适配器时生成 UUID。
- 相机响应码和成功状态均检查，空图像失败；四足视角、ASR 与原厂语音 Agent 共存、实际停止延迟都待真机验证。
- 本次仅完成 Mac Mock 和纯逻辑测试，未连接真机。

## 测试

在 ver2/bridge 执行：

```sh
../.venv/bin/python -m pytest -q
```

测试仅用本地 `127.0.0.1` WebSocket 假后端，不访问外网，不需要 ROS2。
