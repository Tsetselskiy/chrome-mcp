# Chrome MCP Benchmark Suite

This directory contains the performance baseline and benchmark harness for Chrome MCP.

The suite implements two distinct benchmark layers to evaluate performance and support future optimizations:

1. **Low-Level Deterministic Benchmark** (Regression & Latency)
2. **Agent / Task-Level Benchmark** (LLM ↔ MCP Round-Trip Efficiency)

---

## 1. Benchmark Layers

| Layer                            | Unit of Comparison           | Execution Model                                                                               | Primary Purpose                                                                                                                                                                                          |
| :------------------------------- | :--------------------------- | :-------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Deterministic Benchmark**      | **Fixed Tool Call Sequence** | Programmatic scenarios execute predefined tool calls (`short`, `dynamic`, `multihop`).        | Measures MCP/tool execution latency, tests tool contract regressions, and validates collector correctness.                                                                                               |
| **Agent / Task-Level Benchmark** | **Task Goal & Prompt**       | The LLM agent receives only the task goal and autonomously decides which MCP tools to invoke. | Measures **round-trip efficiency**: whether future improvements (Issue #2 Semantic Action Retrieval) reduce the number of LLM ↔ MCP round trips and low-level DOM queries required to accomplish a task. |

---

## 2. Benchmark Metrics

Both benchmark layers record standardized interaction metrics via `benchmark/collector.mjs`:

- **Total MCP Calls (`totalMcpCalls`):** Number of tool invocations performed.
- **Low-Level JavaScript Calls (`lowLevelJsCalls`):** Calls executing arbitrary JS (`chrome_javascript`, `chrome_inject_script`).
- **Browser Execution Time (`browserExecutionTimeMs`):** Cumulative time spent executing tool actions in the browser.
- **Repeated Page Inspections (`repeatedPageInspections`):** Inspection calls performed when the page state has already been inspected without an intervening DOM mutation (`chrome_click_element`, `chrome_fill_or_select`, `chrome_keyboard`, `chrome_navigate`, etc.).
- **Retries (`retries`):** Failed tool calls that were re-attempted or polling loops.
- **Task Success / Failure (`taskSuccess`):** Deterministic verification that the task goal was achieved in the DOM.

---

## 3. How to Run the Benchmarks

### 3.1. Low-Level Deterministic Benchmark

#### Live Mode (Canonical Baseline)

Prerequisites: Google Chrome running with the Chrome MCP Extension loaded and the native server listening at `http://127.0.0.1:12307`.

```bash
# Run deterministic suite against real Chrome MCP:
pnpm run benchmark
# or:
node benchmark/runner.mjs
```

This runs the 3 canonical scenarios (`short-navigation-interaction`, `dynamic-multistep-interaction`, `long-multihop-cross-site-workflow`), outputs the performance summary table, and writes the canonical baseline to:
`benchmark/results/baseline.json`.

#### Mock Mode (Infrastructure / CI Testing)

To verify benchmark harness functionality in environments without a live Chrome instance:

```bash
pnpm run benchmark:mock
# or:
node benchmark/mock-runner.mjs
```

Mock results are written to `benchmark/results/mock-baseline.json`.

> **Note:** Mock results validate benchmark infrastructure only and are never saved as the canonical baseline.

---

### 3.2. Agent / Task-Level Benchmark

The agent benchmark evaluates how an LLM agent solves user tasks without a predetermined tool script.

#### Option A: Interactive Session Capture via Proxy

Run the agent benchmark recorder:

```bash
# Launch recorder for a specific task:
node benchmark/agent-recorder.mjs --task short-interaction

# Available task IDs:
#   short-interaction
#   dynamic-multistep-interaction
#   longer-multipage-workflow
```

The recorder:

1. Starts the local fixture server at `http://localhost:12399`.
2. Starts a transparent MCP proxy at `http://127.0.0.1:12308/mcp` forwarding to live Chrome MCP.
3. Prints the exact prompt for the task.
4. Point your agent (Cursor, Claude Desktop, Antigravity, Claude Code, etc.) to the proxy URL and send the prompt.
5. Press **[ENTER]** in the terminal once the agent finishes. The recorder performs automated DOM state verification and writes the structured run trace to `benchmark/results/agent-<task>-<timestamp>.json`.

#### Option B: Replay / Trace Analysis

If you captured an agent session's MCP logs manually:

```bash
node benchmark/analyze-trace.mjs path/to/trace.json
```

For full details on stable variables, prompts, and evaluation criteria, see [`agent-protocol.md`](./agent-protocol.md).

---

## 4. Running Benchmark Unit Tests

To run the unit tests for the metrics collector, task definitions, and recorder:

```bash
pnpm run test:benchmark
# or:
node --test benchmark/test/*.test.mjs
```

---

## 5. Result Storage & Artifact Identification

Results are stored in `benchmark/results/`:

- **`baseline.json`:** The canonical baseline from the live Chrome MCP run. Contains metadata:
  ```json
  "benchmarkLayer": "deterministic-low-level",
  "canonicalBaseline": true,
  "executionMode": "live-mcp-browser",
  "isLiveRun": true
  ```
- **`mock-baseline.json`:** Results from mock test runs (`isLiveRun: false`).
- **`agent-<taskId>-<timestamp>.json`:** Results and complete call traces from agent task runs (`benchmarkLayer: "agent-task-level"`).

---

## 6. How to Perform Future Before/After Comparisons (Issue #2)

When Issue #2 (Semantic Action Retrieval) is developed:

1. **Deterministic Regression Check:**
   Run `pnpm run benchmark` to ensure raw tool latency and existing tool behaviors have not regressed. Compare against `benchmark/results/baseline.json`.

2. **Agent Round-Trip Comparison:**
   Run the identical task prompts from [`agent-protocol.md`](./agent-protocol.md) using the same model configuration:
   - **Before (Baseline):** The agent inspects large accessibility trees (`chrome_read_page`), struggles with dynamic elements, or uses fallback JS queries (`chrome_javascript`).
   - **After (Issue #2):** With Semantic Action Retrieval, verify that:
     - `totalMcpCalls` decreases.
     - `pageInspectionCalls` and `repeatedPageInspections` decrease.
     - `lowLevelJsCalls` approaches zero.
     - `browserExecutionTimeMs` and LLM round-trip tokens decrease.
