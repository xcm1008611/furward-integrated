# API 变更记录

## v0.1 — 2026-10-24

- 新增健康检查、模式 GET/POST、机器人状态/命令/停止、当前任务、`/ws/app`。
- REST 统一使用 `ok/data` 和 `ok/error/message`；请求校验错误返回 422 / `INVALID_ARGS`。
- 默认室内模式、Mock 后端。室外拒绝 move/turn（403）；忙时拒绝提交任务和切换模式（409）。
- 命令参数：posture `{name}`、mimic `{motion}`、led `{mode}` 均使用白名单字符串；move `{distance_m}`、turn `{angle_deg}`（正数左转）、speak `{text, interrupt?}`。stand_up/stop 不带参数。
- `/api/robot/command` 返回 Task；单独的 stop 命令立即停止并返回已完成的停止 Task，不等待运动结束。序列中混入 stop 会被拒绝，调用方应使用独立停止通道。
- `/api/robot/stop` 返回 `{task, completed_ratio}`；无活动任务时 task 为 null，无运动进度时 completed_ratio 为 null。
- `current_step` 从 0 起；当前任务保留最后一次终态，无历史任务时返回 null。
- WS 格式 `{type,data,ts}`，hello 的 data 为 `{mode,robot}`；ping 返回 pong。hello/pong 仅发给发起连接，其他事件广播。慢订阅者丢弃旧消息。
- 新增错误码 `NOT_READY`（尚未站起）、`MOCK_FAIL`（模拟故障）、`INTERNAL_ERROR`（未预期服务异常）。其余采用 AGENTS.md 的错误码。
- 为后续批次保留 RobotGateway、RobotEvent、Task.source、Task.step_started_at、任务结束监听器和 app.state 服务对象；bridge 暂抛出“批次5实现”。导航、助手、障碍物、调试页尚未开放。

## v0.2 — 2026-10-24

- 新增 `POST /api/nav/plan`、`GET /api/nav/current`、`POST /api/nav/next|repeat|execute|pause|resume|cancel|location`、`GET /api/indoor/map`、`POST /api/robot/prepare`；健康检查版本为 0.2.0。
- 规划请求：室外 `{mode:"outdoor", origin:[lng,lat]|null, origin_coord:"wgs84"|"gcj02", destination:"名称"|[lng,lat]}`；室内 `{mode:"indoor", from:"start"|null, to:"航点 id、名称或别名"}`。请求模式必须匹配演示模式。默认起点和坐标目的地均为 GCJ-02，`origin_coord` 仅转换显式传入的 origin。
- Route 统一包含 `route_id/mode/distance_m/duration_s/coord/polyline/steps/robot_plan/current_step/cached/destination_name`。室内每步包含 `robot_cmds`。缓存另保留 `aliases/sample/note`，占位示例明确标记 `sample:true`，不得当作真实路线使用。
- 高德地点搜索优先 v5 POI，再回退地理编码；步行规划使用 v5。网络/上游错误或没有 Key 时，仅匹配目的地名称/别名的缓存；无匹配保留原始错误。地点不存在返回 `NOT_FOUND`，不套用不相关缓存。
- 当前导航返回 `{route,status,current_step,pose,pause_reason}`；状态为 `IDLE/ACTIVE/PAUSED/DONE/CANCELLED/FAILED`。`pose` 为 `[x,y,heading_deg]`，单位米/度，是命令推算的位置，不是定位测量。
- `nav.route` 推送完整 Route；`nav.progress` 为 `{status,current_step,pose,pause_reason,remaining_m}`。步骤从 0 开始；规划后停在第 0 步，repeat 播报当前步骤，next 推进下一步，完成时 current_step 等于步骤数。室内执行中/暂停中禁止手动跳步。
- execute 仅室内有效，必要时自动站起，逐条执行 robot_plan；命令之间按 `NAV_SETTLE_S` 稳定等待。导航运动期间保留调度器使用权，间隙也拒绝外部普通任务和模式切换；stop 始终绕过此限制。
- pause 请求可省略，默认 `{reason:"user"}`，也支持 `obstacle`。暂停使用停止完成比例保留剩余距离/转角；resume 只接受 PAUSED，过小剩余量按配置跳过。外部机器人 stop 或独立 stop 命令将导航暂停为 `pause_reason:"stop"`。cancel 清空剩余命令；运动失败进入 FAILED 并记录 log。
- Task 新增 `cancel_reason`、`completed_ratio`。`scheduler.stop()` 默认原因改为 `stop`；导航暂停显式传入 `user/obstacle`。停止监听器在通知任务结束前完成导航进度保存，也覆盖两条命令间的停止。
- location 请求为 `{lng,lat,coord:"wgs84"|"gcj02"}`，仅室外；接近当前步骤终点自动推进，暂停、取消或完成后不自动推进。
- prepare 返回一个 `source:"sequence"` 的 Task，顺序为站起（已就绪则跳过）、绿色流水灯、GREET、路线摘要播报、HEED。两种演示模式都允许。
- 新增高德、默认室外起点、到达半径、数据路径及导航间隔/阈值配置，详见 `.env.example`。相对数据路径统一以 backend 目录解析。真实缓存用 `scripts/cache_route.py` 生成。
- StatePublisher 捕获取状态/发布事件异常，尝试记录 error 日志后继续推送。未新增错误码。

## v0.3 — 2026-10-24

- 新增 `POST /api/voice/text`，请求 `{text}`；统一成功响应中的 data 为 `{text,intents,executed,via}`，via 为 `fast/llm/keywords`。Intent 为 `{tool,args}`；executed 按顺序记录 `{tool,ok,data}` 或 `{tool,ok,error,message}`。工具失败转为中文回复，停止本轮后续工具，HTTP 仍返回助手回复。
- 新增 `POST /api/voice/audio` multipart 占位接口，文件字段 `file`，返回 `NOT_SUPPORTED`。由于禁止新增依赖且环境未安装 python-multipart，当前用 multipart Body 与 OpenAPI 文件字段保留协议，不解析上传内容；未来真正识别时再接入 UploadFile。
- `voice.heard` 事件为 `{text,source}`，`assistant.reply` 为 `{text,via,intents}`，全部经 EventBus；保留 heard/understood/executed/error 日志。ASR 只处理最终结果，event_id 保留最近 50 个，重复事件忽略、不回复。
- 暂停、继续、停止优先规则解析，不经过模型；急停要求整句匹配（可带语气词），避免误判停车场。无 Key、禁用、超时和模型错误均使用关键词规则。LLM 工具参数严格验证并复用现有调度、导航、准备服务；超限拒绝、不截断。组合动作顺序等待完成，导航启动后异步执行。停止会使尚未返回的旧模型指令失效。
- 助手回复通过后台 gateway.speak 播报，不占用运动调度器；Mock 播报也与运动独立。Mock snapshot 返回生成的 JPEG；看图失败时使用可选 `app.state.obstacle_hints: Callable[[], str] | None`，无提示时提醒看不清。模型图片缩放至长边最多 1024，使用 image_url data URL，不输出具体距离。
- 增加 DeepSeek、LLM 超时、视觉超时、历史轮数配置及 `scripts/check_llm.py` 现场验证脚本。模型名与看图能力尚须真实 Key 验证，默认值不代表官方能力保证。健康版本为 0.3.0。
- 修复室内 DONE 位姿吸附至终点（heading 保留）；`/api/nav/current` 增加数值 `remaining_m`，与 nav.progress 共用计算，暂停后冻结剩余命令距离。
- 模式切换成功清空路线、恢复 IDLE，并发送 `nav.route`（data 为 null）。ACTIVE/PAUSED 时返回 ROBOT_BUSY，提示「导航进行中，请先取消导航」。未新增错误码。

## v0.4 — 2026-10-24

- 新增 GET `/api/vision/obstacle`：`level/detections/enabled/source/detector/frame_ts`；等级为 clear/caution/stop/unknown，detections 包含归一化 xyxy 框、label/conf 和中文 position。底边中点在梯形内才计入通行障碍。
- 新增 GET `/api/vision/stream`（MJPEG，boundary=frame）及 `/api/vision/snapshot.jpg`（标注 JPEG）。无新鲜快照返回 ROBOT_OFFLINE/503；none 来源时全部 vision 接口返回 NOT_SUPPORTED。
- 新增 POST `/api/debug/obstacle`：`{level:"stop"|"clear",label:"box",position:"left"|"center"|"right"}`，仅 mock 可用，响应 accepted 表示注入已接受，防抖状态随后更新。
- obstacle.update 经 EventBus 推送，变级立即发出，稳定时最多 2 Hz。仅新帧计入连续 stop 确认；断流、推理失败、模型不可用显示 unknown，不宣称通畅。每次执行导航且检测未启用时记录一次 info 日志。
- 室内 ACTIVE 遇障暂停，保留剩余运动，直接 gateway 播报。连续清除后默认提示用户继续；可配置自动恢复，仅恢复 obstacle 原因暂停。**偏离计划 §13：caution 仅发布事件，本批不在运动中降速。**
- 新增 mock/video/rtsp 帧源、旋转、区域/阈值/帧率等配置，见 .env.example。线程只保留最新帧；OpenCV 与 ONNX 不阻塞事件循环；不下载模型。box 不在 COCO 80 类中，仅 Mock 注入支持。
- describe_scene 优先 gateway.snapshot，返回 None 时使用监控原始 JPEG 兜底，检测中文提示接入 obstacle_hints。
- API、Assistant、导航共用自动站起编排：mimic/move/turn 前在需要时加入 stand_up。补充电量/问候关键词、航点及室外缓存目的地建议，运动回复使用开始执行措辞。Assistant 保留组合工具按顺序等待完成的语义。
- 健康版本更新为 0.4.0，无新增错误码。真实 RTSP、相机朝向、模型识别效果与总停止延迟仍需现场验证。

## v0.5 — 2026-10-24

- 新增 GET `/api/config/public`：统一 `ok/data`，仅返回 `version/mode/amap_js_key/amap_security_code/has_llm/obstacle_source/indoor_waypoints`。航点是 `{id,name}` 列表；JS Key 与安全密钥默认空字符串；`has_llm` 表示已配置且启用。不会下发高德 Web 服务 Key 或 DeepSeek Key。
- 新增 GET `/debug` 单文件 HTML：手机布局、深色模式、固定急停、模式和状态、文字助手、机器人控制、室内/室外导航、canvas/可选高德地图、视觉与障碍注入、事件日志。所有操作复用已有 API，动态文本通过 textContent 写入。
- `/api/health` 新增 `lan_urls`（启动时发现的 IPv4 HTTP 调试页地址），版本和 OpenAPI 版本统一为 0.5.0。
- 新增 `backend/run.py`：监听 0.0.0.0，端口读取 Settings；标准库发现网卡地址，打印访问地址及主出口二维码。无网卡信息时保留本机访问提示。
- 新增 `AMAP_JS_KEY`、`AMAP_SECURITY_CODE`。安全密钥公开下发仅供局域网演示，不适用于公网部署。
- 修复 describe_scene 的无 LLM 兜底：监测健康、有检测帧且检测为空时返回“前方暂时没有检测到障碍物”；未启用或无画面仍提示看不清。模型请求失败也适用。
- 无新增错误码。桥接、手机录音与定位 UI 不在本批范围；保留 v0.4 caution 不降速的已知限制。

## v0.6 — 2026-10-24

- 实现 `ROBOT_BACKEND=bridge` 与 `/ws/bridge`；hello 需在 5 秒内到达，校验 robot、adapter、版本字段及可选 token；新连接替换旧连接。健康检查版本为 0.6.0。
- 命令使用递增 `c-` ID、args、deadline_ms；等待 deadline + 2 秒，超时补发一次 stop。断线立即结束挂起命令；超过存活阈值返回 ROBOT_OFFLINE。stop 离线记录遥控器接管提示。
- 新增配置 BRIDGE_TOKEN、BRIDGE_PING_INTERVAL_S（1 秒）、BRIDGE_STALE_S（3 秒）。hello 提供首个存活凭据，此后仅 state/pong 刷新。
- 新增 robot.connection `{online,adapter}` 事件；state 转为 robot.state，asr 保留 is_final/event_id，log/error 通过事件总线转发。
- move/turn 下发速度与标定后的 duration_s；导航执行进度估时同步使用标定。调度器外层超时保留桥接回执宽限。snapshot 解码 result.detail.jpeg_b64。
- 新增桥接程序、MockAdapter、T1Adapter；T1 只延迟导入 ROS2，SDK 状态机由 T1_SDK_PATH 引用，不复制无许可证代码。
- 新增错误码 AUTH（桥接握手令牌错误，WS 消息），ACTION_SWITCH_FAILED（T1 姿态切换失败）；其他失败复用已有错误码。
- 调试页仅整理 HTML/CSS/JS 排版；REST 请求与页面行为不变。真机接口、朝向与动作时序仍需阶段 B 验证。

## v0.6.1 — 2026-10-24

- 调度器在普通任务入队前检查连接，离线返回 503 / ROBOT_OFFLINE，提示「机器狗未连接」。导航 execute/resume 同样在启动前检查；prepare 与 Assistant 命令共用调度器，助手直接回复中文错误。stop 保持立即尝试下发及现有日志。
- `/api/robot/state` 与 StatePublisher 推送新增 `stale`：在线 false，离线 true；离线 busy/current_command 只取调度器，action_status 为 UNKNOWN，battery/action 保留最后已知值。
- 桥接收到 AUTH 错误后提示检查 token，并等待 10 秒再重连。
- T1Adapter 与桥接 CLI 新增 mimic_operation / `--mimic-operation`，仅允许 0（默认不设置）或 2（EXECUTION）；实际执行效果待真机验证。未新增错误码。

## v0.6.2 — 2026-10-24

- 修复局域网二维码误选代理 TUN 地址：排除 198.18.0.0/15、169.254.0.0/16 和指定虚拟网卡前缀；解析 macOS ifconfig 与 Linux ip -4 addr 时保留网卡名。
- 主地址按 iPhone 热点、192.168、10、172.16–31、其他可用地址排序；UDP 路由地址仅在通过过滤且属于 RFC1918 私网时作为同级首选。
- 新增 LAN_HOST（默认空），手动配置时跳过探测，启动二维码和健康接口 lan_urls 均采用该地址。
- 启动器打印被忽略的代理/虚拟网卡地址及防火墙提示；README 增加 NSURLErrorDomain 排查说明。无新增接口或错误码。

## v0.6.3 — 2026-10-24（真实 Key 联调修复）

- 配置：`FRAME_ROTATE` 改为整数加取值校验。此前从 `.env` 读入字符串 `'0'` 会校验失败，导致 `run.py` 和 `check_llm.py` 无法启动。
- 高德：步行规划请求加上 `show_fields=navi`；`navi` 缺失时，从指令末尾推断转向。此前真实响应中所有步骤的 `action` 都是 `other`。
- 语音助手：
  - 按模式分别给出提示：室外明确要求用 `nav_go` / `nav_plan` 规划真实地名，不能拒绝；室内只列出航点。
  - 要求组合口令按顺序调用多个工具。
  - 不再向模型暴露 `robot_speak`，回复文字会自动播报。
  - 修复前的问题：室外问路被拒绝，「先打招呼再带我去门口」只执行了打招呼。

## v0.7 — 2026-10-24（展示页）

- 新增 `/` 与 `/app` 展示页（`app/static/app.html`）：
  - 首屏、产品价值、语音交互（实时控制机器狗）、完整演示、工作原理与当前能力（标注人工辅助）、团队与进展。
  - 室内显示航点路线和机器狗估计位置；室外显示高德地图路线。
- 新增 `/media/{name}`（GET/HEAD）：只读取 `app/static/media/` 目录下的图片和视频，其他文件一律返回 404。
- `run.py` 的二维码改为指向展示页，同时打印 `/debug` 调试台地址；`/api/health` 的 `lan_urls` 仍指向 `/debug`。

## v0.8 — 2026-10-24（视障用户手机页）

- `/` 改为视障用户的手机交互页（`app/static/assist.html`），分「对话」「地图」两个页签：
  - 大字、高对比度，适配 VoiceOver：状态变化通过 aria-live 播报，遇到障碍时用 assertive 级别立即播报。
  - 语音输入：直接对机器狗说（ASR 话题）；或者在输入框里用 iOS 键盘听写，不需要 HTTPS。
  - 可选「手机也朗读回复」（浏览器 speechSynthesis），默认关闭，避免和读屏重复。
  - 底部常驻停止键，导航中显示「停一下 / 继续」。
- 展示页从 `/` 移到 `/showcase`（`showcase.html`），删除 `/app`。
- `run.py` 的二维码仍指向 `/`，现在打开的是手机交互页。

## v0.9 — 2026-10-24（手机页定稿、结束导航修复）

- 修复“结束导航”：
  - 现象：手机页的“停止”只会暂停导航，只有“取消导航”“不去了”两种说法能结束；“结束导航”“停止导航”“不走了”在无模型时回复“没听懂”，有模型时可能被当成暂停。
  - 修复：结束类说法（取消/结束/停止/退出/关闭导航、不去了、不走了、别去了）走快速通道，直接调用 `nav_cancel`；同一句还要去别处时（“不去了，带我去门口”）交给逐句解析，两件事都执行。`nav_cancel` 工具描述同步说明与暂停的区别。
  - 手机页底栏在有路线时常驻“结束导航”，直接调用 `/api/nav/cancel`。
- 新增 `GET /api/demo/city`：返回离线演示城市底图（`data/demo_city.json`，可用 `DEMO_CITY_PATH` 配置）。文件缺失时返回 `NOT_FOUND`。
- 新增缓存路线 `data/demo_routes/city_demo.json`（`route_id=demo-city`，终点“街心花园”，别名“演示路线”“演示城市”“城市演示”，约 150 米，4 步）。两份文件都由 `scripts/export_demo_city.py` 从 Blender 场景导出。
- 室外规划：目的地名与 `sample: true` 的缓存路线完全一致时，直接使用缓存，不再要求默认起点，也不查询高德，避免演示路线被同名真实地点替换。其他目的地的行为不变。
- 手机页 `/` 定稿：
  - 状态卡显示当前步骤与已走/全程进度，进入新步骤时播报并振动。
  - 地图改为暖色微缩城市风格：路线带白色描边，已走灰、未走蓝，带方向箭头、拐点编号、起终点标记、指北针和比例尺，图例用文字说明。
  - 室内地图按房间比例显示 1 米网格；演示城市支持“看全图 / 看路线”。
  - 高德地图只在路线变化时重画，进度刷新只移动当前位置点。
  - 适配深色模式。

