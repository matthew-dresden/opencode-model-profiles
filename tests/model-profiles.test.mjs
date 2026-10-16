// Tests for the extracted model-profiles plugin.
//
// Covers BOTH halves of the dual-shape export:
//   - src/registry.js: resolveProfile + applyProfileToBody (registry API
//     ported verbatim from the config repo's lib/model-profiles.js)
//   - src/index.js V2 half: setup(ctx) with a mocked plugin context
//     (capturing hook/transform registries, fake context events, fake model
//     editor)
//   - src/index.js V1 half: server() with the original fakeConfig tests
//
// Every assertion is real and every test can fail: each one checks concrete
// state produced by the code under test.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const plugin = (await import("../src/index.js")).default
const { MODEL_PROFILES, resolveProfile, applyProfileToBody } = await import("../src/registry.js")

// ---------------------------------------------------------------------------
// Registry (lib port)
// ---------------------------------------------------------------------------

test("registry exports the three known profiles", () => {
  assert.equal(typeof MODEL_PROFILES, "object")
  assert.deepEqual(Object.keys(MODEL_PROFILES).sort(), ["claude-opus-5", "glm-5.3", "glm-5.3-flash"])
})

test("resolveProfile exact match returns the flagship profile", () => {
  const profile = resolveProfile("glm-5.3")
  assert.equal(profile.reasoning_effort, "max")
  assert.equal(profile.temperature, 1.0)
  assert.deepEqual(profile.thinking, { type: "enabled" })
})

test("resolveProfile flash profile runs effort high", () => {
  assert.equal(resolveProfile("glm-5.3-flash").reasoning_effort, "high")
})

test("resolveProfile unknown model returns undefined", () => {
  assert.equal(resolveProfile("moonshot.kimi-k2-thinking"), undefined)
})

test("applyProfileToBody rewrites effort low -> max and sets temperature + thinking", () => {
  const body = { model: "glm-5.3", reasoning_effort: "low", temperature: 0.2 }
  const out = applyProfileToBody(body)
  assert.equal(out, body) // mutates in place, returns same object
  assert.equal(out.reasoning_effort, "max")
  assert.equal(out.temperature, 1.0)
  assert.deepEqual(out.thinking, { type: "enabled" })
})

test("applyProfileToBody unknown model untouched", () => {
  const body = { model: "kimi-k2-thinking", temperature: 0.2 }
  applyProfileToBody(body)
  assert.equal(body.temperature, 0.2)
  assert.equal(body.reasoning_effort, undefined)
  assert.equal(body.thinking, undefined)
})

test("applyProfileToBody passes through null and non-string-model bodies", () => {
  assert.equal(applyProfileToBody(null), null)
  const noModel = { temperature: 0.2 }
  assert.equal(applyProfileToBody(noModel), noModel)
  assert.equal(noModel.reasoning_effort, undefined)
})

// ---------------------------------------------------------------------------
// Dual-shape export surface
// ---------------------------------------------------------------------------

test("default export is the dual-shape plugin object", () => {
  assert.equal(plugin.id, "opencode-model-profiles")
  assert.equal(typeof plugin.setup, "function")
  assert.equal(typeof plugin.server, "function")
})

// ---------------------------------------------------------------------------
// V2 half: setup(ctx) with mocked plugin context
// ---------------------------------------------------------------------------

// Mock V2 plugin context: session.hook registers into a map keyed by hook
// name; model.transform captures the editor callback.
function mockCtx() {
  const hooks = new Map()
  let modelTransform
  return {
    hooks,
    modelTransformRef: () => modelTransform,
    ctx: {
      session: {
        hook: async (name, handler) => {
          hooks.set(name, handler)
        },
      },
      model: {
        transform: async (fn) => {
          modelTransform = fn
        },
      },
    },
  }
}

// Fake model editor with the proven v2 surface: provider.list(), list(pid),
// get(pid, mid), update(pid, mid, fn). Provider "broken" always throws from
// list() to prove the SPIKE-mandated internal guard.
function fakeEditor() {
  const records = {
    "zai-max": {
      "glm-5.3": { id: "glm-5.3", settings: undefined },
      "glm-5.3-flash": { id: "glm-5.3-flash", settings: undefined },
      "glm-5.2": { id: "glm-5.2", settings: undefined },
    },
    openrouter: {
      "glm-5.3": { id: "glm-5.3", settings: { custom: "keep" } },
      "claude-opus-5": { id: "claude-opus-5", settings: undefined },
    },
  }
  const providers = [
    { provider: { id: "zai-max", package: null } },
    { provider: { id: "openrouter", package: null } },
    { provider: { id: "broken", package: null } },
  ]
  return {
    records,
    provider: { list: () => providers },
    list: (providerID) => {
      if (providerID === "broken") throw new Error("provider collection unavailable")
      return Object.values(records[providerID] ?? {})
    },
    get: (providerID, modelID) => records[providerID]?.[modelID],
    update: (providerID, modelID, fn) => {
      fn(records[providerID][modelID])
    },
  }
}

test("setup registers the context hook and model transform (nothing else)", async () => {
  const { ctx, hooks, modelTransformRef } = mockCtx()
  await plugin.setup(ctx)
  assert.deepEqual([...hooks.keys()].sort(), ["context"])
  assert.equal(typeof modelTransformRef(), "function")
})

test("V2 context hook applies profile keys into event.options (model record shape)", async () => {
  const { ctx, hooks } = mockCtx()
  await plugin.setup(ctx)
  const event = { model: { id: "glm-5.3", providerID: "zai-max" }, options: {} }
  hooks.get("context")(event)
  assert.equal(event.options.temperature, 1.0)
  assert.equal(event.options.reasoning_effort, "max")
  assert.deepEqual(event.options.thinking, { type: "enabled" })
})

test("V2 context hook reads v2 ModelRef shape (event.model.modelID)", async () => {
  const { ctx, hooks } = mockCtx()
  await plugin.setup(ctx)
  const event = { model: { providerID: "openrouter", modelID: "glm-5.3-flash" }, options: { temperature: 0.2 } }
  hooks.get("context")(event)
  assert.equal(event.options.reasoning_effort, "high")
  assert.equal(event.options.temperature, 1.0)
})

test("V2 context hook leaves unknown models untouched", async () => {
  const { ctx, hooks } = mockCtx()
  await plugin.setup(ctx)
  const event = { model: { id: "moonshot.kimi-k2-thinking" }, options: { temperature: 0.2 } }
  hooks.get("context")(event)
  assert.equal(event.options.temperature, 0.2)
  assert.equal(event.options.reasoning_effort, undefined)
})

test("V2 model transform merges profiles into model.settings, existing keys preserved", async () => {
  const { ctx, modelTransformRef } = mockCtx()
  await plugin.setup(ctx)
  const editor = fakeEditor()
  modelTransformRef()(editor)
  const zm = editor.records["zai-max"]
  const or = editor.records.openrouter
  assert.equal(zm["glm-5.3"].settings.reasoning_effort, "max")
  assert.equal(zm["glm-5.3"].settings.temperature, 1.0)
  assert.deepEqual(zm["glm-5.3"].settings.thinking, { type: "enabled" })
  assert.equal(zm["glm-5.3-flash"].settings.reasoning_effort, "high")
  // single source: profile keys identical regardless of provider
  assert.equal(or["glm-5.3"].settings.reasoning_effort, zm["glm-5.3"].settings.reasoning_effort)
  assert.equal(or["glm-5.3"].settings.temperature, zm["glm-5.3"].settings.temperature)
  assert.deepEqual(or["glm-5.3"].settings.thinking, zm["glm-5.3"].settings.thinking)
  assert.equal(zm["glm-5.2"].settings, undefined) // unknown model untouched
})

test("V2 model transform: no-op profile creates no settings object", async () => {
  const { ctx, modelTransformRef } = mockCtx()
  await plugin.setup(ctx)
  const editor = fakeEditor()
  modelTransformRef()(editor)
  assert.equal(editor.records.openrouter["claude-opus-5"].settings, undefined)
})

test("V2 model transform: registry wins over existing per-model settings, unknown keys preserved", async () => {
  const { ctx, modelTransformRef } = mockCtx()
  await plugin.setup(ctx)
  const editor = fakeEditor()
  modelTransformRef()(editor)
  const settings = editor.records.openrouter["glm-5.3"].settings
  assert.equal(settings.reasoning_effort, "max")
  assert.equal(settings.custom, "keep")
})

test("V2 model transform survives a provider whose collection throws (guarded, others still applied)", async () => {
  const { ctx, modelTransformRef } = mockCtx()
  await plugin.setup(ctx)
  const editor = fakeEditor()
  // must not throw despite provider "broken" throwing from list()
  modelTransformRef()(editor)
  assert.equal(editor.records["zai-max"]["glm-5.3"].settings.reasoning_effort, "max")
  assert.equal(editor.records.openrouter["glm-5.3"].settings.reasoning_effort, "max")
})

test("MODEL_PROFILES_DISABLED=1: setup registers nothing", async () => {
  process.env.MODEL_PROFILES_DISABLED = "1"
  try {
    const { ctx, hooks, modelTransformRef } = mockCtx()
    await plugin.setup(ctx)
    assert.equal(hooks.size, 0)
    assert.equal(modelTransformRef(), undefined)
  } finally {
    delete process.env.MODEL_PROFILES_DISABLED
  }
})

test("MODEL_PROFILES_LOG: V2 hooks append timestamped lines", async () => {
  const dir = mkdtempSync(join(tmpdir(), "model-profiles-log-"))
  const logPath = join(dir, "profiles.log")
  process.env.MODEL_PROFILES_LOG = logPath
  try {
    const { ctx, hooks, modelTransformRef } = mockCtx()
    await plugin.setup(ctx)
    hooks.get("context")({ model: { id: "glm-5.3", providerID: "zai-max" }, options: {} })
    modelTransformRef()(fakeEditor())
    const lines = readFileSync(logPath, "utf-8").trim().split("\n")
    assert.equal(lines.length, 3)
    assert.match(lines[0], /^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.* context zai-max\/glm-5\.3: temperature,thinking,reasoning_effort$/)
    // guarded provider: skip is logged, the rest still apply
    assert.match(lines[1], /^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.* model\.transform provider broken skipped: provider collection unavailable$/)
    assert.match(lines[2], /^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.* model\.transform applied 3 profiles: zai-max\/glm-5\.3, zai-max\/glm-5\.3-flash, openrouter\/glm-5\.3$/)
  } finally {
    delete process.env.MODEL_PROFILES_LOG
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// V1 half: server() hooks (original fakeConfig tests)
// ---------------------------------------------------------------------------

function fakeConfig() {
  return {
    provider: {
      "zai-max": { models: { "glm-5.3": {}, "glm-5.3-flash": {}, "glm-5.2": {} } },
      openrouter: { models: { "glm-5.3": {}, "glm-5.3-flash": {}, "claude-opus-5": {} } },
      opencode: { options: {} }, // provider with no models key
    },
  }
}

test("V1 server() returns the chat.params and config hooks", async () => {
  const hooks = await plugin.server()
  assert.equal(typeof hooks["chat.params"], "function")
  assert.equal(typeof hooks.config, "function")
})

test("V1 config hook applies registry profiles across providers", async () => {
  const hooks = await plugin.server()
  const cfg = fakeConfig()
  hooks.config(cfg)

  const zm = cfg.provider["zai-max"].models
  const or = cfg.provider.openrouter.models

  assert.equal(zm["glm-5.3"].options.reasoning_effort, "max")
  assert.equal(zm["glm-5.3"].options.temperature, 1.0)
  assert.equal(zm["glm-5.3"].options.thinking.type, "enabled")
  assert.deepEqual(or["glm-5.3"].options, zm["glm-5.3"].options) // single source
  assert.equal(zm["glm-5.3-flash"].options.reasoning_effort, "high")
  assert.equal(or["glm-5.3-flash"].options.reasoning_effort, "high")
  assert.equal(zm["glm-5.2"].options, undefined) // unknown untouched
  assert.equal(or["claude-opus-5"].options, undefined) // no-op creates nothing
  assert.notEqual(cfg.provider.opencode, undefined) // provider without models survives
})

test("V1 config hook: registry wins over provider options, unknown keys preserved", async () => {
  const hooks = await plugin.server()
  const cfg = fakeConfig()
  cfg.provider.openrouter.models["glm-5.3"].options = { reasoning_effort: "low", custom: "keep" }
  hooks.config(cfg)
  const options = cfg.provider.openrouter.models["glm-5.3"].options
  assert.equal(options.reasoning_effort, "max")
  assert.equal(options.custom, "keep")
})

test("V1 chat.params hook writes profile keys into output.options and top-level temperature", async () => {
  const hooks = await plugin.server()
  const output = { options: {}, temperature: 0.2 }
  hooks["chat.params"](
    { provider: { id: "zai-max" }, model: { id: "glm-5.3" } },
    output,
  )
  assert.equal(output.options.reasoning_effort, "max")
  assert.equal(output.options.temperature, 1.0)
  assert.deepEqual(output.options.thinking, { type: "enabled" })
  assert.equal(output.temperature, 1.0)
})

test("V1 chat.params hook: unknown model is a no-op", async () => {
  const hooks = await plugin.server()
  const output = { options: { temperature: 0.2 } }
  hooks["chat.params"]({ model: { id: "kimi-k2-thinking" } }, output)
  assert.equal(output.options.temperature, 0.2)
  assert.equal(output.options.reasoning_effort, undefined)
  assert.equal(output.temperature, undefined)
})

test("MODEL_PROFILES_DISABLED=1: server() returns empty hooks and config stays untouched", async () => {
  process.env.MODEL_PROFILES_DISABLED = "1"
  try {
    const hooks = await plugin.server()
    assert.deepEqual(hooks, {})
    const cfg = fakeConfig()
    if (typeof hooks.config === "function") hooks.config(cfg)
    assert.equal(cfg.provider.openrouter.models["glm-5.3"].options, undefined)
  } finally {
    delete process.env.MODEL_PROFILES_DISABLED
  }
})

test("MODEL_PROFILES_LOG: V1 hooks append timestamped lines", async () => {
  const dir = mkdtempSync(join(tmpdir(), "model-profiles-log-"))
  const logPath = join(dir, "profiles.log")
  process.env.MODEL_PROFILES_LOG = logPath
  try {
    const hooks = await plugin.server()
    const cfg = fakeConfig()
    hooks.config(cfg)
    hooks["chat.params"]({ provider: { id: "zai-max" }, model: { id: "glm-5.3-flash" } }, { options: {} })
    const lines = readFileSync(logPath, "utf-8").trim().split("\n")
    assert.equal(lines.length, 2)
    assert.match(lines[0], / config applied 4 profiles: zai-max\/glm-5\.3, zai-max\/glm-5\.3-flash, openrouter\/glm-5\.3, openrouter\/glm-5\.3-flash$/)
    assert.match(lines[1], / chat\.params zai-max\/glm-5\.3-flash: temperature,thinking,reasoning_effort$/)
  } finally {
    delete process.env.MODEL_PROFILES_LOG
    rmSync(dir, { recursive: true, force: true })
  }
})
