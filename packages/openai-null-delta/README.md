# @corbits/openai-null-delta

An inference adapter for OpenAI-compatible backends that send `delta.role: null` or `delta.tool_calls: null` in
stream chunks, which the stock adapter drops. It wraps the stock OpenAI adapter and removes those two null fields.

## Use

A sidecar operator opts in per provider through Interchange's `SIDECAR_ADAPTER_MANIFEST`:

```json
[{ "provider": "openai-compatible", "module": "@corbits/openai-null-delta", "export": "createNullTolerantOpenAIAdapter" }]
```

## Test

```sh
bun --conditions=intx-src test packages/openai-null-delta
```

## Docs

- [IMPLEMENTATION.md](../../docs/IMPLEMENTATION.md#packages)
