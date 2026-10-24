# 外部 SDK 引用

primebot-t1-sdk 未提供开源许可证，因此本目录不复制或分发 SDK 源代码。

在有权使用 SDK 的机器人环境中自行获取仓库，设置：

```sh
export T1_SDK_PATH=/实际路径/primebot-t1-sdk
```

T1Adapter 在 `start()` 时将 `$T1_SDK_PATH/examples/python` 加入模块搜索路径，
直接从 `common.mc_action_switcher` 导入 `McActionSwitcher` 和
`McActionSwitchOptions`。SDK 路径缺失会返回中文错误，不会回退到自编状态机。
依据版本：`a460300013003b29b9ad291b1b857b0afe295b22`。
