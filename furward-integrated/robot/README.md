# 导盲机器狗后端 · v0.6

面向启元 T1 四足形态，默认 Mock，无真机也能演示。手机调试入口为 `/debug`，接口文档为 `/docs`，变更见 [API_CHANGELOG](backend/API_CHANGELOG.md)。

## 目录说明

- `backend/app/`：FastAPI 应用，`api/` 路由、`services/` 业务、`robot/` 网关、`static/debug.html` 单文件调试页。
- `backend/run.py`：局域网启动器，打印 IPv4 地址与二维码。
- `backend/data/`：室内航点地图和室外缓存路线。
- `backend/tests/`：离线自动化测试；`scripts/`：路线缓存和 LLM 验证工具；`models/`：检测模型说明。
- `bridge/`：WebSocket 桥接、MockAdapter 与 T1Adapter，详见 [桥接运行说明](bridge/README.md)。
- `docs/`：[后端开发计划](docs/后端开发计划.md)（接口规格）与[外部服务接入指南](docs/接入指南.md)。
- `.venv/`：Python 虚拟环境，不随压缩包分发，按下文创建。

## 环境准备与配置

Python 3.10+（开发机为 3.11）。在 ver2 根目录创建虚拟环境：

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r backend/requirements-lock.txt
```

`requirements-lock.txt` 是开发机上测试通过的精确版本；某个版本装不上时改用 `backend/requirements.txt`。
压缩包不含：`backend/.env`（自行从 `.env.example` 复制）、检测模型 `yolov8n.onnx`（见 [模型说明](backend/models/README.md)）、展示页素材（见 `backend/app/static/media/README.md`）、T1 SDK（仅机器狗端需要，见 [桥接运行说明](bridge/README.md)）。

在项目根目录首次配置（已有 `.env` 时不要覆盖）：

```sh
cd backend
cp .env.example .env
```

常用配置：`PORT=8000`、`ROBOT_BACKEND=mock`、`MOCK_TIME_SCALE=1.0`、`OBSTACLE_SOURCE=mock`。`MOCK_TIME_SCALE=0.01` 可加速测试，但现场演示宜保留 1.0，方便观察暂停。

无 Key 可演示室内导航、关键词助手及指定室外缓存。联网能力按需配置：

- `DEEPSEEK_API_KEY` 和 `LLM_ENABLED`：助手模型；`has_llm` 只表示已配置且启用，不保证外网或模型可用。
- `AMAP_KEY`：高德 **Web 服务** Key，用于后端搜索和规划。
- `AMAP_JS_KEY`、`AMAP_SECURITY_CODE`：高德 **JS API** Key 与安全密钥，用于页面地图。JS API 与 Web 服务是不同类型的 Key。安全密钥会通过公开配置下发给局域网页面，这是演示折中，不能用于公网部署。服务端高德和 DeepSeek Key 不下发。
- `OUTDOOR_DEFAULT_ORIGIN=121.5901,31.2032`：仅供仓库占位路线演示的 GCJ-02 起点，真实演示须改成现场坐标。

所有配置项说明见 [环境变量示例](backend/.env.example)。相对数据路径以 backend 为基准。不要提交真实 Key。

## 启动与扫码

在 `backend` 目录执行：

```sh
../.venv/bin/python run.py
# 已激活虚拟环境时也可执行 python run.py
```

监听 `0.0.0.0`，端口读取 `.env`。终端列出发现的非回环 IPv4 `/debug` 地址，并为主地址打印 ASCII 二维码；手机连同一热点扫码。自动排除代理保留段、链路本地地址及虚拟网卡，依次优先选择 iPhone 热点（172.20.10.0/28）、192.168、10、172.16–31 私网地址；同级私网优先使用通过过滤的 UDP 路由地址。可用 LAN_HOST 手动指定地址并跳过自动探测。没有发现地址时，检查热点；本机仍可打开 `http://localhost:8000/debug`。

`/api/health` 的 `lan_urls` 是启动时发现的地址列表；切换热点、IP 改变后重启服务。

## Mock 演示

### 室内

1. 打开 `/debug`，确认“后端在线”“机器狗在线（mock）”，选择室内模式。
2. 点击“打招呼”或发送“你还有多少电”，观察任务、回复和日志；动作期间可点击急停。
3. 航点选择“服务台”或“咖啡桌”，点击“出发”，页面先规划再执行，也可发送“带我去服务台”。
4. 观察步骤高亮、估计位置和朝向；点击“暂停”“继续”验证剩余路线恢复。
5. 导航进行时点“模拟障碍”，等待确认后暂停；点“清除障碍”，默认连续清除 1.5 秒后提示，再点“继续”。默认不自动恢复。
6. “急停”立即调用停止接口并暂停导航；“取消”结束导航。ACTIVE / PAUSED 时需先取消，才能切换模式。

室内示例地图为 6×4 米，现场须实测并修改 `data/indoor_map.json`。原点在左下角，0° 朝 +x，逆时针为正。单段移动 ≤3 米，单次转向 ≤180°，超限拒绝。

### 室外

1. 配置上述 `OUTDOOR_DEFAULT_ORIGIN` 并重启。取消室内导航、等待任务结束，再切换室外。
2. 目的地输入“占位演示”，点击“规划”。无 Web 服务 Key 时加载内置缓存，显示“离线缓存路线”。这是占位示例，非真实路线。
3. 点击“准备动作”，等待站起、灯光、打招呼、播报和聆听结束。
4. 点击“重复”播报当前步骤，“下一步”手动推进。室外机器狗不移动；移动按钮禁用，后端也会拒绝移动、转向及导航执行。
5. 有 JS Key 时加载高德地图；无 Key 或加载失败显示 canvas 示意图。JS 地图 Key 与路线规划 Key 独立配置。

### 手机交互页 `/`（视障用户）

- 底部常驻红色“停止/停下”：立即停下，导航进入暂停；随后出现“继续走”和“结束导航”。
- “结束导航”直接调用 `/api/nav/cancel`，不经过语音理解，一定能结束；也可以说“结束导航”“停止导航”“不走了”“不去了”。
- 状态卡读出当前第几步和指令，进度条显示已走/全程；地图页的步骤列表供读屏使用。
- 室外切换后，“去哪里”里有“演示路线：去街心花园”，或说“带我去演示路线”。这条路线取自 Blender 演示城市（`city-art-v08` / `city-collision-v09`），不需要默认起点和高德 Key，地图页显示同一座城市的俯视图。它是虚构街区，不对应真实街道。
- 底图和路线已导出在 `backend/data/`，可以直接使用。压缩包不含 Blender 源文件，只有拿到 `city-art-v08` / `city-collision-v09` 后才需要重新导出：

```sh
../.venv/bin/python scripts/export_demo_city.py --glb ../../city-art-v08/city_visual_v08.glb --colliders ../../city-collision-v09/collision_manifest.json
```

真实路线缓存可在联网且已配置 Web 服务 Key 时生成：

```sh
../.venv/bin/python scripts/cache_route.py --origin '121.5901,31.2032' --destination '现场目的地名称' --name '演示终点' --alias '目的地简称'
```

仅匹配缓存名称或别名才会离线回退。替换坐标为现场 GCJ-02 坐标，不把仓库占位路线用于真实带路。

## 现场热点组网

推荐手机开热点，电脑和 T1 接同一热点，热点提供 4G/5G 外网。公共 Wi-Fi 可能启用客户端隔离，导致设备互不可达。macOS 防火墙需放行 Python 或配置端口。

- T1 的 Wi-Fi 设置方式向设备负责人确认，连接后用 `hostname -I` 查看地址；`10.1.1.100/101` 是内部有线网地址，不直接当热点地址使用。
- 桥接主动连接 `ws://电脑IP:端口/ws/bridge`；真机运行前按桥接 README 的阶段 B 顺序验证。
- 若 T1 无法连接热点，电脑用有线或机器狗 Wi-Fi 连接 T1，另用第二网卡接热点；也可后续将后端部署到 T1 大脑板，手机接机器人 Wi-Fi，外网另行解决。
- iPhone 热点访问设备需提前实测；不可达时换另一手机开热点或备用随身路由器。手机接电、关闭省电模式，必要时保持热点页面打开。
- 演示前检查：组网 → 启动扫码 → 确认后端与机器人状态 → 打招呼 → 测急停。真机桥接完成后还需现场验证画面和停止延迟。

### 手机打不开（NSURLErrorDomain）

- 先确认手机与电脑在同一网络，直接在浏览器输入电脑的热点地址，例如 `http://172.20.10.14:8000/debug`（按实际地址和端口修改），不要使用 `198.18.0.1` 等代理虚拟地址。
- 在 macOS 防火墙中允许 Python 接受传入连接。
- 关闭 Clash、Surge 等代理软件的 TUN 模式，或在 `backend/.env` 设置 `LAN_HOST=172.20.10.14` 后重启服务。此配置用于访问地址及二维码，不改变监听地址。
- 开热点的 iPhone 本机可能无法访问连到热点上的电脑，换另一台连接该热点的设备试。

### HTTPS、定位与录音

HTTP 局域网地址不能使用浏览器定位和麦克风；当前页面使用预设起点与文字输入，语音可由未来真机 ASR 接入。手机音频接口目前返回 `NOT_SUPPORTED`，启用 HTTPS 也不会自动获得录音识别能力。

需要调试手机定位/麦克风的后续功能时，准备手机信任的证书，改用：

```sh
../.venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000 --ssl-keyfile /path/to/key.pem --ssl-certfile /path/to/cert.pem
```

手机需信任证书并实测；此方式手动打开 `https://电脑IP:8000/debug`，`run.py` 的二维码仅用于 HTTP。定位上报接口 `/api/nav/location` 已有，当前调试页采用手动“下一步”。

## 相机与已知限制

- 默认 mock 帧源；`OBSTACLE_SOURCE=none` 关闭视觉，页面隐藏画面并显示原因。video / rtsp 配置见 `.env.example`，模型见 [模型说明](backend/models/README.md)。
- 地图上的位置和朝向是命令推算的**估计位置**，不是真实定位；没有里程计修正。
- 障碍检测不报距离；caution 仅提示，当前未实现降速。断流或模型不可用为 unknown，不能当作无障碍。
- LLM 不可用时，监测正常且检测为空回复“前方暂时没有检测到障碍物”；监测未启用或无画面则提示看不清。
- 室外只展示路线和准备动作，不移动。LLM 和在线高德服务需要联网；关键词与指定缓存可离线使用。
- 调试页最近 5 条对话和 100 条日志仅保存在当前页面；重连补拉当前导航状态，不补历史日志。并发客户端的助手事件无请求 ID，对话按事件到达顺序展示。
- 真机桥接尚未上机验证，手机录音识别尚未实现；DeepSeek 模型名和图片能力需用真实 Key 运行 `scripts/check_llm.py` 验证。

## 运行测试

```sh
cd backend
../.venv/bin/python -m pytest -q
```

不访问网络，高德和 LLM 使用替身；局域网发现使用假命令输出与假路由地址。测试不修改虚拟环境、不下载模型。

## 桥接模式启动

先在 backend 目录启动后端：

```sh
ROBOT_BACKEND=bridge ../.venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000
```

另一个终端在 ver2 根目录运行：

```sh
.venv/bin/python bridge/bridge.py --adapter mock
# 已激活虚拟环境：python bridge/bridge.py --adapter mock
```

后端与桥接的 `BRIDGE_TOKEN` 保持一致；默认空值不鉴权。打开 `/debug` 验证 bridge 在线、命令和停止。
真机使用 `--adapter t1`，需外部 SDK 与 ROS2，详见 [桥接运行说明](bridge/README.md)。
桥接测试：`cd bridge && ../.venv/bin/python -m pytest -q`，只监听本地回环地址。
