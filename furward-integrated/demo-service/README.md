# 绒途独立城市演示服务

此服务只驱动网页里的虚拟角色。访客各自拥有独立会话，不导入或启动 `robot/` 的设备控制、相机、模型或桥接程序。

在 `demo-service` 目录运行：

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements-lock.txt
.venv/bin/python -m uvicorn demo_service.main:app --host 127.0.0.1 --port 8100 --workers 1
```

需要 Python 3.10 或更新版本。默认读取工程根目录 `shared/route.json`；可以通过 `DEMO_WORLD_PATH` 指定其他路径。共享文件在进程启动时读取，更新后应重启服务。

使用单进程、单 worker。会话保存在内存中，服务重启后访客需要重新创建会话；不能直接增加 workers 或多副本。前端和服务通过同源代理连接 `/api/demo/` 与 `/ws/demo`，无需开启跨域访问。

每份快照都包含 `navigation`（当前路径、总弧长、四个步骤结束里程）、`obstacles`（本会话固定障碍）和 `detour_until_m`（当前绕行完成里程）。原路线为 150 米，绕行会增加实际路程，调用方应使用快照的总长和路径。人物与狗相隔 2.2 米跟随的显示以及导盲绳由前端负责。

自动遇障仍在 32 米停下，手动“模拟障碍”也会暂停。`obstacle_bypass` 或遇障后的 `resume` 启动侧方绕行；旧 `obstacle_clear` 及“清除障碍”文本兼容为绕行，不再删除障碍。障碍坐标固定，直到 `reset` 才清空。绕行可暂停、继续、结束，重连恢复当前路径；重复绕行请求不会重复生成路径，也不会擅自解除普通暂停。

绕行只替换前方 12 米直线路段，最大侧移 2.4 米，使用 64 个小段，并从左右两侧选择满足条件且净空较大的一侧。`shared/route.json` 的 `detour_blockers` 包含原城市 159 个非地面碰撞体的世界 X/Z 凸包；路径距这些轮廓及本会话障碍至少 0.65 米。当前直路剩余不足 15 米、净空数据缺失或两侧均无足够空间时返回 HTTP 409 `NO_DETOUR_SPACE`；人和狗还没有完成上一段绕行时再加障碍，返回 409 `DETOUR_IN_PROGRESS`。本服务只做固定场景中的局部绕行，不承担实体机器人避障或任意目的地寻路。

```sh
.venv/bin/python -m pip install -r requirements-dev-lock.txt
.venv/bin/python -m pytest -q
```

`requirements-lock.txt` 锁定本次验证通过的运行依赖；`requirements-dev-lock.txt` 额外包含测试依赖。未锁版本的 requirements 文件用于主动升级依赖，升级后需重新执行测试。

会话 30 分钟无活动后过期，上限 100 个。浏览器每 5 秒发送一次应用层 WS ping，每条连接独立使用 15 秒心跳期限。最后一条有效连接正常关闭后有 10 秒重连宽限；没有正常关闭通知的半开连接，正常调度下从最后有效 ping 起约 25 秒内暂停（15 秒识别失活，加 10 秒宽限）。服务按期限限制可继续行走的距离，不能承诺物理断网后精确 10 秒暂停。已暂停的会话重连后仍需手动继续。新建会话也应先连接 WS，再开始导航。协议详见工程 `docs/demo-api.md`。

`tests/test_blackhole.py` 会在临时本机端口启动独立服务和 TCP 代理，双向丢弃字节但不主动发送 FIN/RST，实际等待约 25 秒验证失活、暂停及重连。它不连接或重启现有演示站点。前端的异步竞态测试在 `web` 目录执行 `node --test scripts/test-demo-session.mjs`。

本轮后端 **47 项测试通过**，包括 17 项绕行专项、既有 29 项会话与协议测试，以及真实 TCP 黑洞测试。真实入口完整路线在本地生产用时 **126.6 秒**、公网直连用时 **127.1 秒**到达 **151.1078 米**；到达后障碍保留，`reset` 才清空。详见[后端记录](../docs/verification/guide-detour-backend.json)、[本地路线日志](../docs/verification/guide-detour-local-full-route.log)、[公网路线日志](../docs/verification/guide-detour-public-full-route.log)和[本轮汇总](../docs/verification/guide-detour-release.json)。原 150 米、清障后继续及 30 项服务测试结果保留为更新前历史记录。

