# dsh-tool-visibility

控制 DeepSeek Harness 中「注入模型上下文的工具清单」的**静态插件**：提供
**设置页 UI（Settings → 工具注入控制）**与模型侧管理工具 `tool_visibility`，可手动开关
每个 tool 定义是否注入模型上下文；隐藏集合持久化到 JSON 状态文件，重启自动恢复。
适合把纯工具类插件的几十个工具 schema 从每步模型请求里剔除，节省上下文。

> Static plugin: control which tool schemas are injected into the DSH model
> context. Browser settings page + `tool_visibility` manager tool; persisted
> state; framework-native `tools.restrict` filter.

## 原理

dsh 0.2.2-rc.3 起，`system-prompt/assemble` waterfall **不再携带工具清单**（工具声明由 provider
拥有，在 waterfall 之后才附加），且 `ctx.tools.restrict()` 只接受 **scoped context**。因此本插件
在每个存活 agent 的 context 上注册 restriction：

1. **`ctx.tools.restrict({ deny })`**（框架原生，唯一过滤机制）——通过 `agent/created` 事件拿到
   `agent.ctx`，把 restriction 注册在 agent 这一层。它对该 agent 可见的全局工具与 agent-preset
   工具同时生效：被隐藏的 schema 不再注入上下文，调用会得到 `UNKNOWN_TOOL`。
2. **生命周期双重归属**——restriction 用 `agent.ctx.effect()` 绑定 agent，同时把这枚 disposer
   挂进插件自己的 effect：agent 释放或插件卸载，任意一侧都能清干净。
3. **挂载 scope 决定过滤范围**——事件派发按 scope 过滤：根组合层的 bundle 行收到所有 agent，
   作为某个 agent preset 的一行挂载时只收到该 preset 下的 agent。
4. **对齐时机**——`hidden` 变化时对已跟踪 agent 重新对齐；`tools/change`（工具后注册，如 MCP）
   触发一次合并刷新，因为 `restrict()` 只能点名「安装时已存在」的工具。名字逐条校验：某个名字
   不可 restrict（别的 preset 的工具、scope-local 工具、保留的 `run_code`）不会连累其它名字。

设置页目录 = 当前挂载 scope 的 `tools.schemas()` ∪ 每个存活 agent 的 `tools.schemas(agent)`
（agent 对象本身就是它的 scope key，这一项才看得到 preset 层工具；见过的工具会留在内存目录里，
agent 关闭后仍可开关）∪ 持久化的隐藏集合与其描述缓存。

`tool_visibility` 工具自身永远不可隐藏（否则会失去控制权）。

## 表面（Surface）

- **浏览器设置页**：Settings → 工具注入控制。列出全部工具（挂载 scope 视图 ∪ 存活 agent 视图 ∪
  已隐藏，隐藏的也能恢复），复选框逐工具开关；按名称前缀分组、支持搜索与整组批量开关；
  顶部有 刷新 / 全部恢复；显示状态文件路径与当前生效的过滤机制。
  Client↔Host 走 Connection RPC 通道 `/tool-visibility`（endpoints: `list` / `set` / `set-group` / `reset`）。
  > 兼容性：`connection.rpc.handle()` 是框架内部通道实现，第三方插件调用时它会用**通道服务自身的
  > ctx** 解析 `webServer`：在 dsh ≥ 0.1.5-rc.1（cordis 4.0.2）上直接抛
  > `cannot get property "webServer" without inject`（旧版本只静默取到 undefined，所以通道一直缺失）。
  > 因此本插件在同时注入 `webServer` + `connection` 的上下文里自行注册 `/tool-visibility`
  > 前缀路由，复用 `connection.requestRejection()` 的 Host/Origin + 浏览器会话校验；
  > 报文仍是标准 Connection RPC 信封（`client-request` / `server-response`），client 半区无需改动。
- **模型工具** `tool_visibility`：`list` / `hide` / `show` / `reset`。该工具按调用者 agent 的
  scope 解析可见工具（根层 / preset 行挂载都按 agent 视图），因此天然是 per-agent 语义。
- **设置页目录来源**（按合并顺序）：当前挂载 scope 的 `tools.schemas()` → 每个存活 agent 的
  `tools.schemas(agent)`（含 preset 层工具，仅内存）→ 持久化的隐藏集合与其描述缓存。

## 安装 / 挂载

**组合包（bundle）安装**：`cordis.patch.yml` 把本插件的行插在 profile 的**根组合层**
（host 层）。根层本身不能注册 restriction，插件会等每个 agent 出现后在其 `agent.ctx` 上注册，
因此根层挂载同样具备完整语义（隐藏即不注入、且调用得到 `UNKNOWN_TOOL`）。持久化、设置页、
模型工具在根层全部照常工作。

作为 agent preset 的一行（可选，把过滤范围收敛到该 preset 下的 agent）：

```yaml
# 在 <preset>/agent.cordis.yml 中追加（需先安装本包：dsh plugin add @rayfalling/dsh-tool-visibility）
- id: tool-visibility
  name: '@rayfalling/dsh-tool-visibility'
```

> 0.3.5 及更早把根层挂载降级成 `system-prompt/assemble` waterfall 过滤；dsh 0.2.2-rc.3 的
> waterfall 不再提供工具数组，该写法已删除（它会抛
> `Cannot read properties of undefined (reading 'filter')`）。

Client 半区由 web 端 `dsh.client` 表自动发现（`package.json` 的 `dsh.client` 字段 +
`./client` 出口）；`src/client.js` 即 `__ModuleLoader__` 格式的浏览器 bundle，**无需构建**。

## 版本兼容

- **0.4.0+（当前）**：适配 dsh **0.2.2-rc.3**（桌面 App 0.2.2-rc.3 / `@deepseek-ai/*` 0.2.2-rc.3 /
  cordis 4.1.0）。过滤机制改为 per-agent `ctx.tools.restrict()`（见「原理」）：0.2.2-rc.3 的
  `system-prompt/assemble` waterfall 不再携带 `tools`，根层 `restrict()` 也会被拒绝。
  `peerDependencies` 的下限开区间不用改（`>=0.1.5-rc.2` 接受 0.2.2-rc.3，`^4.0.2` 接受 4.1.0）。
- **0.3.5**：适配 dsh **0.2.0-rc.2**（peer 下限开区间 + waterfall 观测 preset 层工具）。在
  dsh ≥ 0.2.2-rc.3 上：`hidden` 非空时每个模型步都会抛
  `Cannot read properties of undefined (reading 'filter')`；`hidden` 为空则过滤完全失效。
  请升级到 0.4.0+。
- **0.3.4 及更早**：只声明到 `^0.1.5-rc.2`，在 dsh ≥ 0.2.0 上会被闸门跳过（插件完全不加载），
  且设置页目录看不到 preset 层工具。请升级到 0.4.0+。

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
