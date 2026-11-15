/**
 * dsh-tool-visibility
 *
 * Control which tool schemas are injected into the DeepSeek Harness model
 * context, with a settings-page UI and a model-facing manager tool.
 *
 * Mechanism (framework-native):
 *  `ctx.tools.restrict({ deny })` is the ToolRuntime's per-scope visibility
 *  filter: hidden schemas leave the model context AND calls to them resolve as
 *  `UNKNOWN_TOOL`. Since dsh 0.2.2-rc.3 a restriction must be registered from a
 *  scoped context (a root registration is rejected) and the
 *  `system-prompt/assemble` waterfall no longer receives the tool array at all
 *  — tool declarations are provider-owned and appended after it. The filter is
 *  therefore installed on each live agent's context, discovered through
 *  `agent/created`: a restriction registered there covers the global and
 *  agent-preset tools that agent can see, and its lifetime is the agent's.
 *  Event admission is scope-filtered, so a preset-mounted row filters that
 *  preset's agents while the root-mounted bundle row filters every agent.
 *
 * Catalog: the settings page lists the mounting scope's `tools.schemas()` ∪
 * every live agent's view (`tools.schemas(agent)` — the agent object is its own
 * scope key) ∪ the persisted hidden set. The per-agent term is what exposes
 * preset-plane tools: the web surface mounts its model-facing rows inside
 * per-session agent presets, so the global registry view does not contain them.
 *
 * Surface:
 *  - model tool `tool_visibility` (list / hide / show / reset);
 *  - browser settings page (Settings → 工具注入控制) talking to the
 *    `/tool-visibility` Connection RPC channel (list / set / set-group / reset),
 *    grouped by raw tool-name prefix, with search and whole-group toggles.
 *
 * Dependency policy: this host entry performs NO static `@deepseek-ai/*`
 * imports. The runtime provides everything through injected services
 * (`ctx.tools`, `ctx.connection`), so the package loads in any profile where the
 * dsh runtime itself runs — third-party bundles cannot rely on `@deepseek-ai/*`
 * resolving from the profile's node_modules (built-ins resolve only from the
 * dsh install). `@deepseek-ai/dsh-scope` is loaded dynamically as an optional
 * upgrade for scope-key views and degrades to the global registry view when
 * absent.
 *
 * Persistence: the hidden set (plus a description cache for hidden tools) is
 * loaded on start and written on every change to `$DSH_HOME/tool-visibility.json`
 * (override with the `stateFile` config).
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export const name = 'dsh-tool-visibility';

export const inject = ['tools'];

const MANAGER_TOOL = 'tool_visibility';
const RPC_CHANNEL = '/tool-visibility';

/** Default state file: $DSH_HOME/tool-visibility.json (fallback ~/.dsh/...). */
function defaultStateFile() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, 'tool-visibility.json');
}

/** RpcResult success/error helpers (dsh-host-apiproxy shape). */
const rpcOk = (value) => ({ ok: true, value });
const rpcErr = (code, message) => ({ ok: false, error: { code, message, details: {} } });

/** Group key = raw name prefix (token before the first '_', else the name). */
function groupFor(name) {
  const i = name.indexOf('_');
  return i === -1 ? name : name.slice(0, i);
}

export async function apply(ctx, config = {}) {
  const stateFile = (config && typeof config.stateFile === 'string' && config.stateFile) || defaultStateFile();
  const hidden = new Set();
  /** Tool-name → description cache, kept for hidden tools so the UI can show them. */
  const descriptions = new Map();
  /**
   * Live agents whose model context this plugin filters. `tools.restrict()`
   * needs a scoped context, so each entry owns a restriction installed through
   * `agent.ctx` — the per-agent control point dsh 0.2.2-rc.3 documents. The
   * agent object is its own scope key (`createScope(loopCtx, agent)`), which is
   * how the settings catalog reads that agent's view.
   *
   * @type {Map<object, {
   *   agent: object,
   *   desired: Set<string>,
   *   installed: Set<string>,
   *   lift: null | (() => void),
   *   owned: null | (() => void),
   * }>}
   */
  const tracked = new Map();
  /**
   * Tool-name → description seen in a live agent's view. The settings page keeps
   * these so preset-plane tools stay listed after their agent closes, the way
   * the previous in-memory assembly observation behaved.
   */
  const seen = new Map();
  /** 'restrict' | 'none' — which filter actually applies. */
  let filterMode = 'none';

  // Optional scope support: `@deepseek-ai/dsh-scope` is a dsh-install built-in,
  // present when the runtime loads our package from the same tree, but not
  // guaranteed for registry installs in foreign profiles. Absent → global view.
  let scopeOf = null;
  let scopeChainOf = null;
  try {
    const scope = await import('@deepseek-ai/dsh-scope');
    scopeOf = scope.scopeOf;
    scopeChainOf = scope.scopeChainOf;
  } catch {
    scopeOf = null;
  }
  /** Scope key under which this row itself is mounted (undefined at the root). */
  const ownScope = scopeOf ? scopeOf(ctx) : undefined;
  /** Whether an agent belongs to this row's mount scope (always true at the root). */
  const inScope = (agent) => {
    if (ownScope === undefined) return true;
    if (!scopeOf || !scopeChainOf) return true;
    try {
      const agentScope = scopeOf(agent.ctx);
      return agentScope !== undefined && scopeChainOf(agentScope).includes(ownScope);
    } catch {
      return false;
    }
  };
  /**
   * Scope key for a tool-registry read. The Agent object is its own scope key;
   * prefer the tagged key when `dsh-scope` is importable.
   */
  const scopeFor = (exec) => {
    if (exec && exec.agent) {
      if (scopeOf) {
        try {
          const key = scopeOf(exec.agent.ctx);
          if (key !== undefined) return key;
        } catch {
          // Fall back to the agent object, which is the scope key in dsh 0.2.x.
        }
      }
      return exec.agent;
    }
    return scopeOf ? scopeOf(ctx) : undefined;
  };
  /** One scope's model-facing schemas (empty when the registry view is unavailable). */
  const schemasOf = (scope) => {
    try {
      return ctx.tools.schemas(scope);
    } catch {
      return [];
    }
  };
  /** Current schemas one scope's model sees (post-restriction). */
  const visibleSchemas = (exec) => schemasOf(scopeFor(exec));

  // ── persistence ────────────────────────────────────────────────────────────
  async function load() {
    try {
      const parsed = JSON.parse(await readFile(stateFile, 'utf8'));
      if (parsed && Array.isArray(parsed.hidden)) {
        for (const entry of parsed.hidden) {
          if (typeof entry === 'string') hidden.add(entry);
        }
      }
      if (parsed && parsed.descriptions && typeof parsed.descriptions === 'object') {
        for (const [key, value] of Object.entries(parsed.descriptions)) {
          if (typeof value === 'string') descriptions.set(key, value);
        }
      }
    } catch {
      // Missing or corrupt state file: start with an empty hidden set.
    }
  }

  async function persist() {
    await mkdir(path.dirname(stateFile), { recursive: true });
    const state = { hidden: [...hidden].sort() };
    if (descriptions.size > 0) {
      state.descriptions = Object.fromEntries([...descriptions.entries()].sort());
    }
    await writeFile(stateFile, JSON.stringify(state, null, 2), 'utf8');
  }

  /** Like persist() but returns a warning string instead of throwing. */
  async function persistSafely() {
    try {
      await persist();
      return null;
    } catch (error) {
      return 'persist failed: ' + (error instanceof Error ? error.message : String(error));
    }
  }

  // ── filtering (per-agent `tools.restrict`) ─────────────────────────────────
  // The restriction is a live registry layer, so one install covers every later
  // step of that agent; it only has to be reconciled when `hidden` or the
  // agent's tool set changes.
  const hasRestriction = () => {
    for (const entry of tracked.values()) if (entry.lift !== null) return true;
    return false;
  };

  /** Names this agent should deny: the hidden ones it can see or already denies. */
  function desiredDeny(entry) {
    const visible = new Set();
    for (const schema of schemasOf(entry.agent)) {
      visible.add(schema.name);
      seen.set(schema.name, typeof schema.description === 'string' ? schema.description : '');
    }
    const desired = new Set();
    for (const name of hidden) {
      if (name === MANAGER_TOOL) continue;
      if (entry.installed.has(name) || visible.has(name)) desired.add(name);
    }
    return desired;
  }

  function sameNames(a, b) {
    if (a.size !== b.size) return false;
    for (const name of a) if (!b.has(name)) return false;
    return true;
  }

  /**
   * Reconcile one agent's restriction with `hidden`.
   *
   * `restrict()` validates every name against the agent's restrictable set (the
   * inherited global + preset tools), so one stale entry — another preset's
   * tool, a scope-local tool, the reserved transport — must not drop the whole
   * set: the batch is retried name by name and the unusable ones are skipped.
   */
  function refreshAgent(entry) {
    const desired = desiredDeny(entry);
    if (sameNames(desired, entry.desired)) return;
    entry.desired = desired;
    if (entry.lift !== null) {
      entry.lift();
      entry.lift = null;
    }
    const names = [...desired];
    const disposers = [];
    let installed = new Set();
    if (names.length > 0) {
      try {
        disposers.push(entry.agent.ctx.tools.restrict({ deny: names }));
        installed = new Set(names);
      } catch {
        for (const name of names) {
          try {
            disposers.push(entry.agent.ctx.tools.restrict({ deny: [name] }));
            installed.add(name);
          } catch {
            // Not restrictable from this agent: leave it visible.
          }
        }
      }
    }
    entry.installed = installed;
    entry.lift = disposers.length === 0
      ? null
      : () => { for (const dispose of disposers.reverse()) dispose(); };
  }

  /** Reconcile every live agent and refresh the reported filter mode. */
  function applyFilter() {
    for (const entry of [...tracked.values()]) {
      try {
        refreshAgent(entry);
      } catch (error) {
        console.warn(`[${name}] cannot refresh the tool filter: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    filterMode = hasRestriction() ? 'restrict' : 'none';
  }

  /**
   * Start filtering one agent. Both registrations are owned twice: disposing the
   * agent removes the restriction through `agent.ctx.effect`, and the plugin
   * keeps that disposer in its own effect so unloading the plugin also removes
   * what it registered on `agent.ctx`.
   */
  function trackAgent(agent) {
    if (tracked.has(agent)) return;
    if (typeof agent?.ctx?.effect !== 'function' || typeof agent.ctx.tools?.restrict !== 'function') return;
    const entry = { agent, desired: new Set(), installed: new Set(), lift: null, owned: null };
    try {
      entry.owned = agent.ctx.effect(() => () => {
        if (entry.lift !== null) {
          entry.lift();
          entry.lift = null;
        }
        tracked.delete(entry.agent);
      }, `${name}: agent filter`);
      ctx.effect(() => () => {
        const owned = entry.owned;
        entry.owned = null;
        tracked.delete(entry.agent);
        if (typeof owned === 'function') owned();
      }, `${name}: agent filter owner`);
    } catch {
      // The agent was already disposed, or its context cannot own effects.
      return;
    }
    tracked.set(agent, entry);
    try {
      refreshAgent(entry);
    } catch (error) {
      console.warn(`[${name}] cannot filter this agent's tools: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Late registrations (MCP servers, plugins loaded after this one) become
  // restrictable only after they register, and `restrict()` accepts known names
  // only — so a tool change schedules one coalesced reconcile.
  let refreshScheduled = false;
  const scheduleRefresh = () => {
    if (refreshScheduled) return;
    refreshScheduled = true;
    queueMicrotask(() => {
      refreshScheduled = false;
      applyFilter();
    });
  };

  // ── shared state helpers ───────────────────────────────────────────────────
  /**
   * Complete tool catalog for the UI: the mounting scope's visible schemas ∪
   * every live agent's view ∪ the tools already seen on one ∪ hidden names.
   *
   * Three sources are merged back in, for two different reasons:
   *  - hidden tools vanish from every registry view under `restrict`, so the UI
   *    must restore them from the state cache or they could never be re-shown;
   *  - tools registered on another plane (an agent preset's own rows) never
   *    appear in the global registry view at all, so the only source for them
   *    is a live agent's view (the agent object is that plane's scope key); the
   *    `seen` cache keeps them listed after that agent closes.
   */
  const catalogFor = (exec) => {
    const byName = new Map();
    const add = (schema) => {
      byName.set(schema.name, typeof schema.description === 'string' ? schema.description : '');
    };
    for (const schema of visibleSchemas(exec)) add(schema);
    for (const entry of tracked.values()) {
      for (const schema of schemasOf(entry.agent)) {
        seen.set(schema.name, typeof schema.description === 'string' ? schema.description : '');
        add(schema);
      }
    }
    for (const [name, description] of seen) {
      if (!byName.has(name)) byName.set(name, description);
    }
    for (const name of hidden) {
      if (!byName.has(name)) byName.set(name, descriptions.get(name) ?? '');
    }
    return [...byName.entries()].map(([name, description]) => ({
      name,
      description,
      group: groupFor(name),
      hidden: hidden.has(name),
    })).sort((a, b) => a.name.localeCompare(b.name));
  };

  const uiState = (exec, persistError) => ({
    tools: catalogFor(exec),
    hidden: [...hidden].sort(),
    stateFile,
    filterMode,
    persistError: persistError || null,
  });

  /** Set the hidden flag of one tool, re-apply the filter and persist. */
  async function setHidden(name, hide, exec) {
    if (name === MANAGER_TOOL) return { error: `refusing to touch ${MANAGER_TOOL}` };
    if (hide) {
      const known = catalogFor(exec).find((entry) => entry.name === name);
      hidden.add(name);
      if (typeof known?.description === 'string') descriptions.set(name, known.description);
    } else {
      hidden.delete(name);
      descriptions.delete(name);
    }
    applyFilter();
    const persistError = await persistSafely();
    return { persistError };
  }

  /** Set the hidden flag of every tool whose group matches. */
  async function setGroupHidden(group, hide, exec) {
    let changed = false;
    for (const entry of catalogFor(exec)) {
      if (entry.name === MANAGER_TOOL) continue;
      if (entry.group !== group) continue;
      if (hide) {
        hidden.add(entry.name);
        if (entry.description) descriptions.set(entry.name, entry.description);
      } else {
        hidden.delete(entry.name);
        descriptions.delete(entry.name);
      }
      changed = true;
    }
    if (!changed) return { error: `no tools in group "${group}"` };
    applyFilter();
    const persistError = await persistSafely();
    return { persistError };
  }

  // ── browser UI RPC (Settings → 工具注入控制) ───────────────────────────────
  /** One `/tool-visibility` RPC endpoint (list / set / set-group / reset). */
  const handleRpc = async (endpoint, payload) => {
    try {
      if (endpoint === 'list') return rpcOk(uiState(null));
      if (endpoint === 'set') {
        const name = payload && typeof payload.name === 'string' ? payload.name : null;
        const hide = !!(payload && payload.hidden);
        if (!name) return rpcErr('bad-request', 'missing tool name');
        const result = await setHidden(name, hide, null);
        if (result.error) return rpcErr('bad-request', result.error);
        return rpcOk(uiState(null, result.persistError));
      }
      if (endpoint === 'set-group') {
        const group = payload && typeof payload.group === 'string' ? payload.group : null;
        const hide = !!(payload && payload.hidden);
        if (!group) return rpcErr('bad-request', 'missing group');
        const result = await setGroupHidden(group, hide, null);
        if (result.error) return rpcErr('bad-request', result.error);
        return rpcOk(uiState(null, result.persistError));
      }
      if (endpoint === 'reset') {
        hidden.clear();
        descriptions.clear();
        applyFilter();
        const persistError = await persistSafely();
        return rpcOk(uiState(null, persistError));
      }
      return rpcErr('bad-request', `unknown endpoint: ${endpoint}`);
    } catch (error) {
      return rpcErr('internal', error instanceof Error ? error.message : String(error));
    }
  };

  /** Body cap: every payload here is a tool name, a group name, or nothing. */
  const RPC_BODY_LIMIT = 64 * 1024;
  /** Endpoint below the channel, or undefined when the pathname is not ours. */
  const endpointOf = (url) => {
    const pathname = new URL(url ?? '/', 'http://dsh.internal').pathname;
    if (!pathname.startsWith(`${RPC_CHANNEL}/`)) return undefined;
    const endpoint = pathname.slice(RPC_CHANNEL.length + 1);
    const segments = endpoint.split('/');
    return segments.every((segment) => /^[A-Za-z0-9_$.-]+$/.test(segment)) ? endpoint : undefined;
  };
  /** Request body as JSON, or undefined when empty, oversized, or unparsable. */
  const readJsonBody = async (req) => {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > RPC_BODY_LIMIT) return undefined;
      chunks.push(chunk);
    }
    try {
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      return parsed && typeof parsed === 'object' ? parsed : undefined;
    } catch {
      return undefined;
    }
  };
  const writeJson = (res, value) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(value));
  };

  // The channel is a webServer route, so it is mounted from a context that
  // injects BOTH `webServer` (the route table) and `connection` (the Host/Origin
  // + browser-session fence). Neither exists while this root row applies in the
  // web profile, and reading an un-injected service is fatal in current cordis
  // — hence `ctx.inject` instead of probing once at apply time.
  //
  // The route is registered here rather than through `connection.rpc.handle`
  // because that helper resolves `webServer` through the *channel service's*
  // own context, which never injects it (`cannot get property "webServer
  // without inject`). The wire envelope below is the same Connection RPC
  // contract the browser half sends through `ctx.connection.rpc.call`.
  ctx.inject(['connection', 'webServer'], (webCtx) => {
    if (typeof webCtx.connection.requestRejection !== 'function') {
      console.warn(`[${name}] connection service exposes no requestRejection(); ${RPC_CHANNEL} channel not mounted`);
      return;
    }
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'prefix',
      path: RPC_CHANNEL,
      handler: async (req, res) => {
        const rejection = webCtx.connection.requestRejection(req);
        if (rejection !== undefined) {
          res.writeHead(rejection);
          res.end(rejection === 401 ? 'unauthorized' : 'forbidden');
          return;
        }
        const endpoint = endpointOf(req.url);
        if (req.method !== 'POST' || endpoint === undefined) {
          res.writeHead(404);
          res.end('not found');
          return;
        }
        const contentType = String(req.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase();
        if (contentType !== 'application/json') {
          res.writeHead(415);
          res.end('content type must be application/json');
          return;
        }
        const message = await readJsonBody(req);
        if (message === undefined || message.type !== 'client-request' || typeof message.rpcId !== 'string' || typeof message.method !== 'string') {
          res.writeHead(400);
          res.end('body is not a connection client-request');
          return;
        }
        if (message.method !== endpoint) {
          writeJson(res, { type: 'server-response', rpcId: message.rpcId, result: rpcErr('gateway/bad-request', `method ${JSON.stringify(message.method)} does not match endpoint ${JSON.stringify(endpoint)}`) });
          return;
        }
        writeJson(res, { type: 'server-response', rpcId: message.rpcId, result: await handleRpc(endpoint, message.payload) });
      },
    }), `${name}: ${RPC_CHANNEL} channel`);
  });

  // ── model-facing manager tool (hand-rolled definition: no dsh-tools import) ─
  ctx.tools.register({
    name: MANAGER_TOOL,
    description: 'Control which tool schemas are injected into the model context of this session. ' +
      'Actions: "list" (every visible tool with its hidden state), "hide" (remove the named tools from the model context — ' +
      'they also become uncallable via UNKNOWN_TOOL), "show" (restore the named tools), "reset" (clear the hidden set). ' +
      'Changes persist to the plugin state file and take effect on the next model step.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'hide', 'show', 'reset'],
          description: 'What to do: list | hide | show | reset.',
        },
        tools: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tool names the action applies to (required for hide/show; ignored for list/reset).',
        },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          hidden: { type: 'array', items: { type: 'string' } },
          visible: { type: 'array', items: { type: 'string' } },
          stateFile: { type: 'string' },
          filterMode: { type: 'string' },
          message: { type: 'string' },
        },
      },
      render(_args, value) {
        return [{ type: 'text', text: JSON.stringify(value, null, 2) }];
      },
    },
    async execute(args, exec) {
      const action = args.action;
      const st = (extra) => ({ hidden: [...hidden].sort(), stateFile, ...extra });
      const vis = () => visibleSchemas(exec).map((s) => s.name).sort();
      if (action === 'list') {
        return { ...st(), visible: vis(), filterMode, message: `${vis().length} tools visible, ${hidden.size} hidden` };
      }
      if (action === 'reset') {
        hidden.clear();
        descriptions.clear();
        applyFilter();
        const persistError = await persistSafely();
        return { ...st(), visible: vis(), filterMode, message: persistError ? 'hidden set cleared but ' + persistError : 'hidden set cleared' };
      }
      const names = Array.isArray(args.tools) ? args.tools.filter((entry) => typeof entry === 'string') : [];
      if (names.length === 0) {
        return { ...st(), visible: vis(), filterMode, message: `no tool names given for "${action}"` };
      }
      const known = new Set(vis());
      const unknown = names.filter((entry) => !known.has(entry) && !hidden.has(entry));
      if (unknown.length > 0) {
        return { ...st(), visible: vis(), filterMode, message: `unknown tool name(s): ${unknown.join(', ')}` };
      }
      if (names.includes(MANAGER_TOOL)) {
        return { ...st(), visible: vis(), filterMode, message: `refusing to hide ${MANAGER_TOOL} (you would lose control of this filter)` };
      }
      let persistError = null;
      if (action === 'hide') {
        for (const entry of names) {
          const result = await setHidden(entry, true, exec);
          if (result.error) return { ...st(), visible: vis(), filterMode, message: result.error };
          if (result.persistError) persistError = result.persistError;
        }
      } else if (action === 'show') {
        for (const entry of names) {
          const result = await setHidden(entry, false, exec);
          if (result.error) return { ...st(), visible: vis(), filterMode, message: result.error };
          if (result.persistError) persistError = result.persistError;
        }
      } else {
        return { ...st(), visible: vis(), filterMode, message: `unknown action "${action}"` };
      }
      return { ...st(), visible: vis(), filterMode, message: `${action} applied to ${names.join(', ')} — takes effect on the next model step` + (persistError ? ' (warning: ' + persistError + ')' : '') };
    },
  });

  // ── start with persisted state ─────────────────────────────────────────────
  await load();

  // The restriction needs a scoped context, so it is installed on each agent as
  // soon as the agent exists. Event admission keeps a preset-mounted row to that
  // preset's agents; the root-mounted bundle row receives them all.
  ctx.on('agent/created', ({ agent }) => {
    try {
      if (inScope(agent)) trackAgent(agent);
    } catch (error) {
      console.warn(`[${name}] cannot filter agent tools: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  ctx.on('tools/change', scheduleRefresh);

  // Agents that already exist when this row (re)loads get the same treatment.
  try {
    const agents = ctx.get('agents');
    if (agents !== undefined && typeof agents.list === 'function') {
      for (const agent of agents.list()) if (inScope(agent)) trackAgent(agent);
    }
  } catch {
    // No agent registry in this composition: nothing to filter yet.
  }

  applyFilter();
}
