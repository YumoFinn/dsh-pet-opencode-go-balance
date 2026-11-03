# dsh-pet-opencode-go-balance

把 **OpenCode Go** 的 5h / 周 / 月 三窗口用量接进 [dsh-pet](https://github.com/PC2005-cloud/dsh-pet) 的余额气泡：
以 provider id `dsh-opencode-go` 注册到 dsh-pet 的第三方余额表，气泡里显示和 OpenCode Go 设置卡片同一套数字。

## 它解决什么

桌宠的余额气泡原本对 OpenCode Go 只会显示「当前服务商暂不支持余额查询」。原因不是配置，而是两处写死在依赖方源码里的错位：

1. **provider id 对不上**：dsh-pet 按 `agentDefaultModel.currentSelection().provider` 查内置表，表里只有 `opencode-go`；
   而 [dsh-opencode-go](https://github.com/Duskriver/dsh-opencode-go) 注册的 provider id 是 `dsh-opencode-go`，查表必然落空。
2. **凭据 ref 对不上**：dsh-pet 内置的 `opencode-go` 路由写死 `OPENCODE_GO_API_KEY`，
   而多账号形态的 key 存在 `DSH_OPENCODE_GO_ACCOUNT_*` 下。

本插件不改 dsh-pet 源码，走它官方开放的第三方注册口
（`ctx.provide('petApi7340', { balance: { register } })`）注册一个 provider：

- id 用 `dsh-opencode-go`，与宿主报告的完全一致；
- 取数优先调用 **dsh-opencode-go 自己的 `opencodeGoUsage` 服务** —— 账号、baseURL、代理、超时、缓存去重都由它负责，
  所以桌宠的气泡与 OpenCode Go 设置卡片永远是同一个数据源，切换账号后自动跟随；
- 只有在没有该服务时才退化为直连 `GET https://opencode.ai/zen/go/v1/usage`（20s 超时 + 2 次线性退避重试）。

## 气泡显示什么

- `5h` / `周` / `月` 三个百分比，满额度按 Go 套餐常量 12 / 30 / 60 USD 计算（与 dsh-pet 内置口径一致）；
- 每个窗口的重置倒计时；
- 超额时**如实显示 >100%**，不夹到 100；
- 任何异常一律抛错，由 dsh-pet 落成 `fetch-error` 气泡 —— **绝不伪造 0 余额**。

## 依赖

| 依赖 | 版本 | 用途 |
|---|---|---|
| [dsh-pet](https://github.com/PC2005-cloud/dsh-pet) | ≥ 0.3.8 | 提供 `petApi7340.balance.register` 注册口（必需） |
| [dsh-opencode-go](https://github.com/Duskriver/dsh-opencode-go) | ≥ 0.1.24 | 提供 `opencodeGoUsage` 服务（强烈建议；缺失时走直连兜底） |

## 安装

在 DSH 的 **设置 → 插件 → 安装** 里输入包名或仓库地址：

```
dsh-pet-opencode-go-balance
https://github.com/QLY-3315/dsh-pet-opencode-go-balance
```

或用 CLI：

```powershell
dsh plugin --profile desktop add dsh-pet-opencode-go-balance
# 或者从本地目录
dsh plugin --profile desktop add "E:\path\to\dsh-pet-opencode-go-balance"
```

装完重启 DSH，然后在 dsh-pet 设置里确认该宠物的「余额功能」已开启，右键「查看余额」或 `/balance` 即可。

卸载：

```powershell
dsh plugin --profile desktop remove dsh-pet-opencode-go-balance
```

## 配置

通常不需要配置：默认跟随 dsh-opencode-go 当前选中的账号。

只有一个环境变量，在**没有 `opencodeGoUsage` 服务、走直连兜底**时才会用到：

| 环境变量 | 说明 |
|---|---|
| `DSH_PET_OPENCODE_ACCOUNT_REF` | 账号凭据 ref；换账号时指定，免改代码。缺省依次尝试 `OPENCODE_GO_API_KEY` |

## 兼容性

`dsh.compatibility.dshReleases` 中只声明了实测通过的版本：

| DSH | 状态 |
|---|---|
| 0.2.1-rc.3 | compatible |

## 开发

```powershell
node --test test/   # 纯函数 + 宿主装配，共 12 项
```

代码结构：

- `lib/index.js` —— 宿主插件主体：等服务就绪、注册 provider、取数；
- `lib/windows.js` —— 纯函数：用量 → dsh-pet `windows` 形态（零依赖，可直接单测）。

## 许可

[MIT](./LICENSE)
