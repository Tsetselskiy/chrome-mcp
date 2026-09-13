# Chrome MCP Benchmark Suite

This directory contains the benchmark harness for establishing the Chrome MCP performance baseline before interaction optimizations.

The suite has two distinct layers:

1. **Deterministic low-level benchmark** — fixed tool-call sequences for regression and transport/tool latency checks.
2. **Agent / task-level benchmark** — fixed task goals where the LLM chooses its own MCP calls, used to measure LLM ↔ MCP round-trip efficiency.

## Metrics

- **`totalMcpCalls`** — agent/scenario `tools/call` invocations.
- **`lowLevelJsCalls`** — arbitrary JavaScript execution tools.
- **`mcpRoundTripTimeMs`** — client-observed MCP round-trip latency. It includes HTTP transport, serialization, native messaging, server execution, and browser work. It is **not** isolated browser-handler time.
- **`browserExecutionTimeMs`** — intentionally `null` because the current transport does not expose isolated browser-handler timing.
- **`pageInspectionCalls`** — page/content inspection calls, including recognized DOM-reading JavaScript.
- **`repeatedPageInspections`** — inspections of the same tab/page scope without a successful intervening state-changing action. Inspection state is tracked per tab; failed actions do not reset it.
- **`retries`** — in agent-proxy runs, the same tool + equivalent arguments invoked in a later request after that exact call failed. Repeated successful inspections/polling are tracked separately unless explicitly marked by a deterministic scenario.
- **`taskSuccess`** — strict deterministic verification of the required final DOM state.

## Run deterministic benchmark

Prerequisites: live Chrome MCP native server/extension on `http://127.0.0.1:12307`.

```bash
pnpm run benchmark
```

This writes `benchmark/results/baseline.json` for a live run.

The artifact includes source SHA, Node/OS/hardware metadata, package versions, optional Chrome version supplied through `BENCHMARK_CHROME_VERSION`, and an explicit warning that latency is a single-run MCP round-trip measurement.

For a valid baseline run, set the warm-up state explicitly, for example:

```bash
BENCHMARK_WARMUP_STATE="fresh Chrome MCP session; one warm-up navigation completed" \
BENCHMARK_CHROME_VERSION="<actual Chrome version>" \
pnpm run benchmark
```

## Run mock validation

```bash
pnpm run benchmark:mock
```

This writes `benchmark/results/mock-baseline.json`. Mock measurements validate the harness only and must never be interpreted as live performance data.

## Run agent/task-level capture

```bash
node benchmark/agent-recorder.mjs \
  --task short-interaction \
  --model "Gemini 3.8 Flash High" \
  --reasoning-mode high
```

Available task IDs:

- `short-interaction`
- `dynamic-multistep-interaction`
- `longer-multipage-workflow`

The recorder starts the fixtures on `:12399` and an MCP recording proxy on `:12308`. Point the agent's Chrome MCP configuration at `http://127.0.0.1:12308/mcp`, run the exact printed prompt in a fresh session, then press Enter when the agent is finished. Verification runs separately and is not counted as agent MCP traffic.

`--model` and `--reasoning-mode` are metadata labels only; they do not configure the external model.

## Manual trace analysis

```bash
node benchmark/analyze-trace.mjs path/to/trace.json
```

Manual traces must contain explicit task-success evidence (`taskSuccess` or `success`). Missing success information is treated as **FAIL**, never PASS.

## Tests

```bash
pnpm run test:benchmark
# or
node --test benchmark/test/*.test.mjs
```

## Baseline status in PR #4

The original live and mock JSON artifacts were removed after review found that the original deterministic runner did not classify DOM-reading JavaScript as an inspection and used a misleading browser-time label. They must be regenerated with the corrected harness before PR #4 is merged.

PR #4 should not be merged until all of the following exist and are reviewed:

- a fresh `benchmark/results/baseline.json` from the corrected live deterministic runner;
- a fresh `benchmark/results/mock-baseline.json`;
- real agent/task-level BEFORE traces for all three task IDs using the same recorded model/reasoning configuration that will later be used for the Issue #2 AFTER comparison.

## Future Issue #2 A/B comparison

Use the same task prompts, fixture state, model snapshot/configuration, reasoning mode, browser/MCP configuration, and fresh-session procedure for BEFORE and AFTER runs.

The main decision metrics are task success, total MCP calls, low-level JS calls, inspections, repeated inspections, and retries. `mcpRoundTripTimeMs` is secondary and should only be compared when the environment is materially the same.

See [`agent-protocol.md`](./agent-protocol.md) for the exact task prompts and reproducibility protocol.
