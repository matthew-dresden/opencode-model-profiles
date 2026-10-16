// opencode-model-profiles: per-model parameter profiles applied at config
// load and request time. Extracted from
// github.com/matthew-dresden/opencode-config (plugins/model-profiles.js +
// lib/model-profiles.js) at commit 1857c39b7c7bd5ca38ff976b6df18ab54784dd40.
//
// Dual-shape export, one package serving both host generations ("Support V1
// and V2 from one package"):
//   - V2 host: `setup(ctx)` registers
//       ctx.session.hook("context", ...)  <- V1 "chat.params" destination
//       ctx.model.transform(...)          <- V1 "config" destination
//     per the v2 migration audit (docs/v2-migration/audit.md section 2.1) and
//     plugins-migrate-v1's hook table. R11(d) is still open: the `context`
//     hook covers agent model requests; if title/compaction requests must
//     also receive profiles, register `title`/`compaction` separately once
//     the spike lands.
//   - V1 host: `server()` returns the original hooks object
//     { "chat.params", config } with verbatim behavior.
//
// Self-contained on purpose: NO import of @opencode/plugin. The released
// port (story 2.3a) may add the SDK import if the host requires the
// Plugin.define wrapper; zero dependencies are preserved either way.
//
// Env overrides (both halves, preserved from the V1 plugin):
//   MODEL_PROFILES_DISABLED=1   skip application entirely
//   MODEL_PROFILES_LOG=<path>   append applied profiles to this file
import { resolveProfile } from "./registry.js"

// Build the append-to-file logger. Without MODEL_PROFILES_LOG this is a
// no-op, matching the V1 plugin exactly.
async function makeLogger() {
  const logPath = process.env.MODEL_PROFILES_LOG
  let appendFileSync
  if (logPath) {
    ;({ appendFileSync } = await import("node:fs"))
  }
  return (msg) => {
    if (!logPath) return
    appendFileSync(logPath, `${new Date().toISOString()} ${msg}\n`)
  }
}

// The frozen docs never pin the context-event model field. Read the model id
// across the documented-plausible shapes: full model record ({ id }),
// v2 ModelRef ({ modelID }), or a bare string. Keep in priority order.
function modelIdFromContextEvent(event) {
  const model = event?.model
  if (typeof model === "string") return model
  if (model && typeof model === "object") {
    if (typeof model.id === "string") return model.id
    if (typeof model.modelID === "string") return model.modelID
  }
  return undefined
}

const plugin = {
  id: "opencode-model-profiles",

  // ------------------------------------------------------------------
  // V2 host (opencode >= 2): session context hook + model transform.
  // ------------------------------------------------------------------
  async setup(ctx) {
    if (process.env.MODEL_PROFILES_DISABLED === "1") return
    const log = await makeLogger()

    // V1 "chat.params": profile keys (temperature included) land in the
    // semantic options object of the model request (plugins-migrate-v1
    // worked example sets event.options.temperature).
    await ctx.session.hook("context", (event) => {
      const modelID = modelIdFromContextEvent(event)
      const profile = resolveProfile(modelID)
      if (!profile) return
      for (const [key, value] of Object.entries(profile)) {
        event.options[key] = value
      }
      log(`context ${event?.model?.providerID ?? "?"}/${modelID}: ${Object.keys(profile).join(",") || "no-op"}`)
    })

    // V1 "config": merge profiles into the active-provider model collection.
    // Editor surface proven on opencode 2.0.30 (built-in plugins use it the
    // same way): editor.provider.list() -> [{ provider: { id, ... } }],
    // editor.list(providerID) -> model records, editor.update(providerID,
    // modelID, fn) mutates the record. Per-model semantic options live on
    // the record's `settings` (v2 config schema; V1 `options` maps to v2
    // `settings` per the SPIKE-2.2 config mapping).
    //
    // SPIKE-2.2 hard rule: a throw inside a transform callback disables the
    // entire plugin. Guard every per-provider/per-model step through the log
    // channel instead of letting one bad record kill the registration.
    await ctx.model.transform((editor) => {
      const applied = []
      const providers = editor.provider.list() ?? []
      for (const entry of providers) {
        const providerID = entry?.provider?.id
        if (!providerID) continue
        let models
        try {
          models = editor.list(providerID) ?? []
        } catch (error) {
          log(`model.transform provider ${providerID} skipped: ${error?.message ?? error}`)
          continue
        }
        for (const model of models) {
          const profile = resolveProfile(model?.id)
          if (!profile || Object.keys(profile).length === 0) continue
          try {
            editor.update(providerID, model.id, (record) => {
              record.settings = { ...(record.settings || {}), ...profile }
            })
            applied.push(`${providerID}/${model.id}`)
          } catch (error) {
            log(`model.transform failed ${providerID}/${model.id}: ${error?.message ?? error}`)
          }
        }
      }
      log(`model.transform applied ${applied.length} profiles: ${applied.join(", ") || "none"}`)
    })
  },

  // ------------------------------------------------------------------
  // V1 host (opencode 1.x): original hooks, verbatim behavior.
  // ------------------------------------------------------------------
  async server() {
    if (process.env.MODEL_PROFILES_DISABLED === "1") return {}

    const log = await makeLogger()

    return {
      "chat.params": (input, output) => {
        const profile = resolveProfile(input.model?.id)
        if (!profile) return
        for (const [key, value] of Object.entries(profile)) {
          output.options[key] = value
        }
        if (typeof profile.temperature === "number") output.temperature = profile.temperature
        log(`chat.params ${input.provider?.id}/${input.model?.id}: ${Object.keys(profile).join(",") || "no-op"}`)
      },

      config: (cfg) => {
        const applied = []
        for (const [providerId, provider] of Object.entries(cfg.provider || {})) {
          if (!provider?.models) continue
          for (const [modelId, model] of Object.entries(provider.models)) {
            const profile = resolveProfile(modelId)
            if (!profile || Object.keys(profile).length === 0) continue
            model.options = { ...(model.options || {}), ...profile }
            applied.push(`${providerId}/${modelId}`)
          }
        }
        log(`config applied ${applied.length} profiles: ${applied.join(", ") || "none"}`)
      },
    }
  },
}

export default plugin
