# dsh-tool-visibility

控制 DeepSeek Harness 中「注入模型上下文的工具清单」的**静态插件**：提供
**设置页 UI（Settings → 工具注入控制）**与模型侧管理工具 `tool_visibility`，可手动开关
每个 tool 定义是否注入模型上下文；隐藏集合持久化到 JSON 状态文件，重启自动恢复。
适合把纯工具类插件的几十个工具 schema 从每步模型请求里剔除，节省上下文。

> Static plugin: control which tool schemas are injected into the DSH model
> context. Browser settings page + `tool_visibility` manager tool; persisted
> state; framework-native `tools.restrict` filter.

## 原理

每步模型调用前，agent loop 通过 `systemPrompt.assemble()` 收集工具 schema（来自
`tools.schemas(scope)`），`assembly.tools` 即模型请求的 `tools` 字段。

本插件按优先级使用两种机制：

1. **`ctx.tools.restrict({ deny })`**（首选，框架原生）——作为 agent preset 行挂载时，
   restriction 注册在 preset scope，对本 preset 下的所有 agent 生效：被隐藏的工具 schema
   不再注入上下文，且调用会得到 `UNKNOWN_TOOL`。
2. **`system-prompt/assemble` waterfall**——**始终注册**。它承担两件事：
   - 记录 `assembly.tools`（模型真正会看到的 schema 清单），这是设置页目录的**唯一完整来源**；
   - 当 `restrict` 不可用时（例如本组合包 patch 把行插在无 scope 的 host 根层）剔除隐藏
     schema（仅影响模型所见，不阻止执行）。

   之所以要“始终注册”：dsh 0.2.0 起 web profile 把模型侧工具行（`tool-pwsh` / `tool-fs` /
   `tool-fs-search` / `tool-skill` …）**移进了每会话的 agent preset**，根层挂载时
   `tools.schemas()`（全局视图）看不到它们；而 waterfall 对任意 scope 的 assembly 都可见
   （未打 scope 标签的 listener 接收全部子 scope 事件）。没有这一步，设置页就永远列不出这些
   工具，也就永远无法开关它们。

`tool_visibility` 工具自身永远不可隐藏（否则会失去控制权）。

## 表面（Surface）

- **浏览器设置页**：Settings → 工具注入控制。列出全部工具（全局视图 ∪ 组装观测 ∪ 已隐藏，
  隐藏的也能恢复），复选框逐工具开关；按名称前缀分组、支持搜索与整组批量开关；
  顶部有 刷新 / 全部恢复；显示状态文件路径与当前生效的过滤机制。
  Client↔Host 走 Connection RPC 通道 `/tool-visibility`（endpoints: `list` / `set` / `set-group` / `reset`）。
  > 兼容性：`connection.rpc.handle()` 是框架内部通道实现，第三方插件调用时它会用**通道服务自身的
  > ctx** 解析 `webServer`：在 dsh ≥ 0.1.5-rc.1（cordis 4.0.2）上直接抛
  > `cannot get property "webServer" without inject`（旧版本只静默取到 undefined，所以通道一直缺失）。
  > 因此本插件在同时注入 `webServer` + `connection` 的上下文里自行注册 `/tool-visibility`
  > 前缀路由，复用 `connection.requestRejection()` 的 Host/Origin + 浏览器会话校验；
  > 报文仍是标准 Connection RPC 信封（`client-request` / `server-response`），client 半区无需改动。
- **模型工具** `tool_visibility`：`list` / `hide` / `show` / `reset`。该工具按调用者 agent 的
  scope 解析可见工具，因此在 preset 行挂载时天然是 per-agent 视图。
- **设置页目录来源**（按合并顺序）：`tools.schemas()`（当前挂载 scope 的注册表视图）→
  waterfall 观测到的 assembly 工具（含 preset 层，**仅内存**）→ 持久化的隐藏集合与其描述缓存。

## 安装 / 挂载

**组合包（bundle）安装**：`cordis.patch.yml` 把本插件的行插在 profile 的**根组合层**
（host 层）。根层没有 scope，`restrict` 必然抛错（框架明确要求 scoped context），插件自动
降级为上面第 2 条 waterfall：隐藏的工具不再注入模型上下文，但**仍可被调用**。
持久化、设置页、模型工具在根层全部照常工作。

作为 agent preset 的一行（可选，获得 per-scope 过滤 + `UNKNOWN_TOOL` 语义）：

```yaml
# 在 <preset>/agent.cordis.yml 中追加（需先安装本包：dsh plugin add @rayfalling/dsh-tool-visibility）
- id: tool-visibility
  name: '@rayfalling/dsh-tool-visibility'
```

Client 半区由 web 端 `dsh.client` 表自动发现（`package.json` 的 `dsh.client` 字段 +
`./client` 出口）；`src/client.js` 即 `__ModuleLoader__` 格式的浏览器 bundle，**无需构建**。

## 版本兼容

- **0.3.5+（当前）**：适配 dsh **0.2.0-rc.2**。`peerDependencies` 里的 `@deepseek-ai/dsh-*`
  统一改成 **下限开区间**（`>=0.1.5-rc.2`），因为插件的 host 入口零静态 `@deepseek-ai/*`
  import、只消费注入服务；旧的 `^0.1.5-rc.2`（0.x 语义 = `>=0.1.5-rc.2 <0.2.0`）会让
  dsh 0.2.0-rc.2 的兼容性闸门直接跳过整个 bundle：
  `skipping profile bundle … is incompatible with dsh 0.2.0-rc.2`。
  另外补上 dsh 0.2.0 的 agent-preset 工具面适配（见「原理」第 2 条的 assembly 观测）。
- **0.3.4 及更早**：只声明到 `^0.1.5-rc.2`，在 dsh ≥ 0.2.0 上会被闸门跳过（插件完全不加载），
  且设置页目录看不到 preset 层工具。请升级到 0.3.5+。

## 持久化

默认 `$DSH_HOME/tool-visibility.json`（`~/.dsh/tool-visibility.json`），每次
`hide/show/reset` 后写盘，启动时加载。格式：

```json
{ "hidden": ["import_claude", "store_search"], "descriptions": { "import_claude": "…" } }
```

`descriptions` 是隐藏工具的描述缓存（供 UI 在工具已被过滤掉时仍能显示它），可配置覆盖路径：

```yaml
- id: tool-visibility
  name: '@rayfalling/dsh-tool-visibility'
  config:
    stateFile: 'F:/my/state.json'
```

## 开发

标准 cordis 插件包（ESM，命名导出 `name` / `inject` / `apply`；client 半区
`src/client.js` + `dsh.client` 字段；组合包 manifest `dsh.bundle` + `cordis.patch.yml`；
host 入口零静态 `@deepseek-ai/*` import，可在任意 profile 直接安装）。
本地安装验证：

```sh
dsh plugin --profile <name> add <本包路径>
dsh --profile <name> --dump-config   # 应看到本包层
```

仓库：<https://github.com/rayfalling/dsh-tool-visibility>（public，topics：`dsh` / `deepseek-harness` / `cordis` / `plugin` / `dsh-plugin`）。

## License

MIT
