# 绒途城市演示接口

独立演示服务只控制虚拟城市角色，不调用 `robot/`。公网只代理本服务；原手机、调试和真机桥接使用原服务。会话存储在单个进程内，启动时必须使用一个 worker。

## 公共数据与会话

- `GET /api/demo/health`：服务健康，返回 `mode: "simulation"`。
- `GET /api/demo/world`：读取共享 `shared/route.json`，成功返回 `{ "ok": true, "data": world }`。
- `POST /api/demo/sessions`：创建会话，返回 `{ "ok": true, "data": { "session_id", "token", "state" } }`。每次创建都使用新的随机凭据。
- `GET /api/demo/sessions/{id}`：读取当前快照。
- `POST /api/demo/sessions/{id}/actions`：请求 `{ "action": "start" }`，返回 `{ "ok": true, "data": state }`。
- `POST /api/demo/sessions/{id}/text`：请求 `{ "text": "带我去街心花园" }`，返回 `{ "ok": true, "data": { "reply", "state" } }`。

三个带 ID 的接口要求 `Authorization: Bearer <token>`。浏览器将 ID 与 token 保存到 `sessionStorage`，不放在 URL 或日志中。服务端仅存 token 摘要。token 只允许控制对应会话。

浏览器的 `Origin` 主机和端口必须与请求 `Host` 一致；反向代理须保留 `Host` 和 `Origin`。允许 HTTP 或 HTTPS，以兼容本地入口及 TLS 反向代理。其他站点的 HTTP 请求返回 403，WS 连接以 1008 关闭。无 Origin 的命令行客户端仍须提供会话凭据。

world 格式：

```json
{
  "version": 1,
  "coordinate_system": "Y-up metres",
  "route": {
    "route_id": "demo-city",
    "points": [{"x": 0, "y": 0, "z": 0}],
    "steps": [{"index": 0, "instruction": "…", "action": "straight", "start_m": 0, "end_m": 57.6, "distance_m": 57.6}],
    "total_distance_m": 150,
    "speed_mps": 1.2,
    "start_name": "西街口",
    "destination_name": "街心花园",
    "obstacle_distance_m": 32
  },
  "assets": {"city": "…", "periphery": "…", "human": "…", "dog": "…"},
  "transform": {},
  "map": {},
  "detour_blockers": []
}
```

上述 points、steps 和空对象仅展示字段，完整有效数据以 `/api/demo/world` 为准。`route.points` 是未绕行的原路线；会话开始后角色、路线线条和二维地图均从快照的 `navigation.points` 计算。二维地图使用 `transform` 投影世界 X/Z，不能使用旧手机页中的虚拟经纬度直接定位。

`detour_blockers` 为世界 X/Z 平面的凸多边形数组，每个顶点是 `[x, z]`。当前导出包含 159 个非地面碰撞体的保守凸包，来源为原城市 `collision_manifest.json`，不是从显示贴图猜测。局部绕行检查路径至这些轮廓及本会话固定障碍轮廓的最小距离，要求不小于 0.65 米；更换城市场景后应重新运行 `scripts/export-world.py`。

## 状态与操作

所有快照包含：`session_id`、`revision`、`status`、`distance_m`、`current_step`、`pause_reason`、`obstacle_active`、`obstacle_triggered`、`navigation`、`obstacles`、`detour_until_m`、`message`。

`distance_m` 是沿当前 `navigation.points` 实际弧长计算的已走米数；`current_step` 从 0 开始，到达时等于 steps 数量；`revision` 在同一会话内单调递增。前端先核对当前身份和生命周期代次，再丢弃同会话较旧快照；旧 HTTP 响应、旧连接消息和错误回调不能覆盖新会话。状态为 `IDLE`、`ACTIVE`、`PAUSED`、`DONE`、`CANCELLED`；暂停原因是 `user`、`obstacle` 或 `disconnected`，其余状态为 null。

| 新增或调整字段 | 含义 |
|---|---|
| `navigation.points` | 当前路线的世界坐标点数组，元素为 `{x,y,z}`；包含已走路径和后续绕行，不改变已走部分 |
| `navigation.total_distance_m` | 当前路线总弧长；绕行后通常大于原路线的 150 米 |
| `navigation.step_end_distances` | 四个步骤在当前路线上的结束里程；进度、步骤完成状态和播报距离应使用该数组 |
| `obstacles` | 固定障碍数组，元素为 `{id,point:{x,y,z},heading}`；heading 为弧度，零指向世界 +Z，保持到 `reset` |
| `obstacle_active` | 是否遇障停下、等待绕行；变成 false 不表示障碍消失 |
| `detour_until_m` | 当前绕行完成里程或 null；包含狗回到原路后额外 2.2 米，确保跟随人物也通过 |

绕行只替换当前前方 12 米直线路段，使用 64 小段近似平滑侧移，最大侧移 2.4 米。障碍放在停下位置前方 5 米；检查左右候选路径，选择满足净空要求且余量较大的一侧。当前直线剩余不足 15 米或两侧均无足够空间时拒绝放置；这不是任意城市场景的通用寻路。

| action | 行为 |
|---|---|
| `start` | 待命时开始；已经行进则保持当前路线 |
| `pause` | 原地暂停，重复暂停不改变障碍原因 |
| `resume` | 普通暂停后沿当前路径继续；遇障等待时启动绕行，障碍仍留在原位 |
| `cancel` | 原地结束并保留已走距离，不能继续；到达后不改成取消 |
| `reset` | 返回起点和 IDLE，恢复原路线、清空本轮障碍、重新安排自动遇障 |
| `obstacle` | 行进或暂停时，在前方放置可绕行障碍并暂停，标记本轮已触发；未完成上一段绕行或空间不足时拒绝 |
| `obstacle_bypass` | 遇障等待时切入绕行路径并前进；没有待绕行障碍时不改变路径，也不解除用户暂停 |
| `obstacle_clear` | 旧接口兼容名，行为与 `obstacle_bypass` 一致，不再删除障碍 |

按 1.2 米/秒推进，每 0.1 秒发布状态。首次走到 32 米时自动遇障一次，准确停止于该位置。手动添加障碍也算本轮已触发，之后不会在 32 米再次触发。绕行途中可以暂停、继续、结束；刷新恢复完整路径和所有障碍。到终点精确停在 `navigation.total_distance_m`；结束后需 `reset` 开始新一轮。前端不以原 150 米作为绕行后的结束条件。

文字入口复用原关键词规则中的“结束导航优先于暂停”原则，但只执行本会话允许的演示操作。不启动大模型或相机，不接受任意机器人运动指令。支持去街心花园、暂停、继续、结束、绕行、添加演示障碍、重新体验、重复步骤和查询状态。旧“清除障碍”类指令兼容为绕行，不移除障碍。连续自动行进时“下一步”只重读当前指引，不跳过路段。

## WebSocket 与连接恢复

连接 `/ws/demo` 后必须在 5 秒内发送首包：

```json
{"session_id":"…","token":"…"}
```

验证后立即返回完整快照，再在状态更新时发送：

```json
{
  "type": "demo.state",
  "data": {
    "session_id": "…", "revision": 1, "status": "ACTIVE", "distance_m": 0,
    "current_step": 0, "pause_reason": null, "obstacle_active": false,
    "obstacle_triggered": false,
    "navigation": {
      "points": [
        {"x":165.852004,"y":0.025,"z":-86.2632899},
        {"x":201.314105,"y":0.025,"z":-40.8738705},
        {"x":166.9568361,"y":0.025,"z":-14.0310302},
        {"x":186.2886064,"y":0.025,"z":10.7125075},
        {"x":199.9999935,"y":0.025,"z":-0.0000022}
      ],
      "total_distance_m": 150,
      "step_end_distances": [57.6,101.2,132.6,150]
    },
    "obstacles": [], "detour_until_m": null, "message": "…"
  },
  "ts": 1790000000.123
}
```

`ts` 是服务器 Unix 秒。前端按最新有效快照和接收时间做有限插值；暂停、取消和终点快照应立即停止外推，不逐帧重放积压的历史进度。

当前网页每 5 秒发送 `{ "type": "ping" }`，服务端回复 `{ "type": "pong", "data": {}, "ts": … }`。每条 WS 连接有独立的 15 秒心跳期限：新连接鉴权时启动期限，仅该连接的有效 ping 可以续期。其他连接的 ping、HTTP 活动及无关消息都不能续期这条连接。过期连接会从观察者集合移除，并以 WS 4000 关闭；4000 应用原身份重新连接，不创建新会话。

会话允许多个观察连接。最后一条有效连接正常关闭后，保留 10 秒重连宽限，再以 `pause_reason: "disconnected"` 暂停。网络丢包而没有关闭通知时，先等 15 秒心跳期限，再保留 10 秒宽限；正常调度下，从最后一次有效 ping 起约 25 秒内暂停。即使一次服务端 tick 延迟，距离也只推进至这个期限。这里不是物理断网后精确 10 秒的保证；浏览器休眠、定时器节流及服务进程停顿会影响察觉和显示时间。

前端连续 15 秒未收到 pong，就立即显示“连接恢复中”、禁止新操作，并重新读取服务快照后连接 WS；不依赖浏览器先发出 close 事件。旧连接的回调不能重新把界面标记为在线。宽限期内恢复连接可保持原有行进；如果服务已经暂停，重连只恢复状态，需用户主动继续。

有效 ping 和读取/操作 HTTP 接口会延长会话的 30 分钟有效期；服务端主动发送进度不延长期限。30 分钟无活动会清理会话并关闭连接。服务重启后原会话失效；重新创建即可。

首包认证缺失、无效、超时或会话过期会以 WS 1008 关闭。普通非法操作通过 HTTP 返回，不中断已认证的 WS。客户端不自动重试动作请求（尤其是 reset），避免在新的导航轮次重复执行旧操作。

## 错误

错误格式统一为 `{ "ok": false, "error": "CODE", "message": "中文说明" }`。

| HTTP | error | 含义 |
|---|---|---|
| 400 / 422 | `INVALID_ARGS` | 操作名、请求结构或文字不合法 |
| 401 | `AUTH` | 凭据缺失或不匹配 |
| 403 | `ORIGIN_FORBIDDEN` | 请求来自其他站点 |
| 404 | `NOT_FOUND` | 会话不存在或已过期 |
| 409 | `INVALID_STATE` | 当前状态不允许该操作 |
| 409 | `DETOUR_IN_PROGRESS` | 人和狗尚未完成当前绕行，不能再添加障碍 |
| 409 | `NO_DETOUR_SPACE` | 直路余量不足 15 米、净空数据缺失，或左右候选路径均不满足 0.65 米净空 |
| 429 | `SESSION_LIMIT` | 已达到 100 个会话上限 |

遇到会话 404 或 WS 1008 时提示旧会话已过期，创建新的独立会话，旧操作不会自动重放。网络或心跳失活保留身份重连，不反复创建会话。部署仅暴露本演示 API；不包含 `/api/robot/*`、`/api/voice/*`、`/ws/bridge`、`/debug`。

## 已运行站点的验收

工程根目录执行：

```sh
demo-service/.venv/bin/python -m pip install -r demo-service/requirements-dev-lock.txt
demo-service/.venv/bin/python scripts/check-live.py http://localhost:3000
demo-service/.venv/bin/python scripts/check-live.py http://localhost:3000 --full-route
```

前者检查统一入口下的访客隔离、HTTP 与 WS 鉴权、跨站拒绝、心跳、暂停、文字控制及状态恢复。完整路线模式按实际 1.2 米/秒检查 32 米遇障、固定障碍、侧方绕行、途中暂停恢复及最终到达更新后的总里程；绕行增加路程，耗时不再固定为旧版 150 米用时。可把 URL 替换为独立预览站地址。脚本直接连接指定地址，忽略本机环境代理；测试使用新建会话，不读取浏览器存储、不打印 token。

本轮后端 **47 项测试通过**；真实入口完整路线已在本地生产用时 **126.6 秒**、公网直连用时 **127.1 秒**到达 **151.1078 米**，障碍在到达后仍保留，仅 `reset` 清空。证据见[后端测试记录](verification/guide-detour-backend.json)、[本地完整路线](verification/guide-detour-local-full-route.log)、[公网完整路线](verification/guide-detour-public-full-route.log)及[本轮汇总](verification/guide-detour-release.json)。原 150 米、清障后继续的日志属于更新前版本，保留原始内容和范围。
