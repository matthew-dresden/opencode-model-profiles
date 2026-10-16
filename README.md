# opencode-model-profiles

opencode plugin: per-model parameter profiles applied at config load and
request time. Extracted from
[matthew-dresden/opencode-config](https://github.com/matthew-dresden/opencode-config)
(`plugins/model-profiles.js` + `lib/model-profiles.js`, single-source
registry) at commit `1857c39b7c7bd5ca38ff976b6df18ab54784dd40`.

## Status

Bootstrapped ahead of the v2 migration cutover. The config repository keeps
its own live copy until the consumer switch (migration story 2.6); until then
this package is **structurally dead**: it is not published to any registry
(publish is canary-gated behind a `REGISTRY_READY` repository variable that is
intentionally unset), and nothing consumes it.

## What it does

The registry (`src/registry.js`) is the single source of truth for per-model
request parameters:

| Model | Profile |
| --- | --- |
| `glm-5.3` | temperature 1.0, thinking enabled, reasoning_effort max |
| `glm-5.3-flash` | temperature 1.0, thinking enabled, reasoning_effort high |
| `claude-opus-5` | deliberate no-op (temperature is non-tunable on the Claude 5 series; overriding degrades output) |

Profile values are vendor-sourced (docs.z.ai/guides/llm/glm-5.3; models.dev
Claude 5 entries), not guessed. The Z.AI transport wrappers in the config
repository enforce the same registry at the fetch boundary, because
OpenCode's reasoning synthesis overrides both config options and
`chat.params`.

## Dual-shape plugin (V1 + V2 from one package)

`index.js` re-exports a single default object that serves both host
generations. It is self-contained: no `@opencode/plugin` import, zero
runtime dependencies.

```js
export default {
  id: "opencode-model-profiles",
  async setup(ctx) { /* V2 host */ },
  async server() { /* V1 host */ },
}
```

- **V2 host** — `setup(ctx)` registers:
  - `ctx.session.hook("context", ...)`: applies the profile's keys
    (temperature included) to the semantic `event.options` of the model
    request — the documented destination of V1 `chat.params`.
  - `ctx.model.transform(...)`: merges the profile into each matching model
    record's `settings` across the active-provider model collection — the
    documented destination of V1 `config`. Per-provider/per-model failures
    are logged through `MODEL_PROFILES_LOG` instead of thrown: a throw inside
    a transform callback disables the entire plugin on opencode 2.0.30
    (observed, SPIKE-2.2).
- **V1 host** — `server()` returns the original hooks
  `{ "chat.params", config }` with verbatim behavior from the extracted
  plugin.

Known open question (R11(d)): the `context` hook covers agent model
requests; if title/compaction requests must also receive profiles, the
`title`/`compaction` hooks need separate registrations once the spike
determines which hook kinds fire for those requests.

## Environment overrides

| Variable | Effect |
| --- | --- |
| `MODEL_PROFILES_DISABLED=1` | skip application entirely (both halves) |
| `MODEL_PROFILES_LOG=<path>` | append timestamped log lines for every applied profile |

## Development

```sh
node --test tests/model-profiles.test.mjs
node scripts/check-license.mjs
node scripts/check-tarball.mjs
```

The test suite covers the registry API, the V2 half against a mocked plugin
context (capturing hook/transform registries, fake context events, fake
model editor), and the V1 half against the original fixture config.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
