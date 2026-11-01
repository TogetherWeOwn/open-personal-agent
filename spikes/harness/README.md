# Harness spike (M2-16, throwaway)

`builtin-loop` (`src/builtin.ts`) against AI SDK v7 `ToolLoopAgent` (`src/aisdk.ts`, through a
`LanguageModelV4` bridge over our port), sharing one mock model, one approval-gated tool and one
DO host, without `nodejs_compat`. `pnpm --filter @opa/spike-harness dev` serves
`POST /<builtin|aisdk>/<session>/<turn|approve|cancel|deleted>` as NDJSON; `size` builds each
variant with `wrangler deploy --dry-run`. The decision note lives on the M2-16 task.
