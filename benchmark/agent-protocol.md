# Agent / Task-Level Benchmark Protocol (Issue #1 Baseline)

This document specifies the exact, reproducible evaluation protocol for measuring agent performance on browser tasks using Chrome MCP.

The goal of this benchmark layer is to measure:
**Whether future interaction improvements (such as Semantic Action Retrieval in Issue #2) reduce the number of LLM ↔ MCP round trips and low-level inspections required to accomplish the same user task.**

---

## 1. Benchmark Task Specifications

The benchmark suite defines three representative task categories. Each task starts from a clean browser state and uses the local deterministic fixtures served at `http://localhost:12399`.

### Task 1: Short Interaction (`short-interaction`)

- **Category:** Short, single-action interaction.
- **Start URL:** `http://localhost:12399/short/index.html`
- **Goal:** Activate the primary cloud service and confirm that status changes to ACTIVE.
- **Exact Agent Prompt:**
  ```
  Navigate to the CloudOps Console at http://localhost:12399/short/index.html and activate the primary service. Confirm that the status changes to ACTIVE.
  ```
- **Success Criteria:**
  1. Button `#activate-btn` clicked.
  2. Status badge `#status-badge` reflects text `ACTIVE`.
  3. System message `#system-message` confirms `Service Activated Successfully`.
- **Verification Routine:** `tasks.mjs` -> `verifyShortTask`.

---

### Task 2: Dynamic Multi-Step Interaction (`dynamic-multistep-interaction`)

- **Category:** Dynamic filtering, asynchronous item selection, form submission.
- **Start URL:** `http://localhost:12399/dynamic/index.html`
- **Goal:** Filter clusters by query, select the target cluster, configure allocation nodes, and submit.
- **Exact Agent Prompt:**
  ```
  Navigate to the Cluster Orchestrator at http://localhost:12399/dynamic/index.html. Search for cluster "us-east", select the "US-East Production Primary" cluster from the dynamically filtered results, set the allocation node count to 8, and submit the allocation. Confirm that allocation reference ALLOC-8891 is displayed.
  ```
- **Success Criteria:**
  1. Input `#filter-query` receives value `"us-east"`.
  2. Button `#select-btn-us-east-prod` is clicked after dynamic rendering.
  3. Form input `#node-count` is filled with value `8`.
  4. Submit button `#submit-allocation-btn` is clicked.
  5. Confirmation alert `#success-alert` is displayed with reference ID `ALLOC-8891`.
- **Verification Routine:** `tasks.mjs` -> `verifyDynamicTask`.

---

### Task 3: Longer Multi-Page Workflow (`longer-multipage-workflow`)

- **Category:** Multi-page workflow with cross-site token/parameter transfer.
- **Start URL:** `http://localhost:12399/multihop/site-a.html`
- **Goal:** Inspect origin manifest, extract shipment ID and token, navigate to gateway portal, fill authorization form, and confirm dispatch.
- **Exact Agent Prompt:**
  ```
  Navigate to the Origin Hub dispatch manifest at http://localhost:12399/multihop/site-a.html. Find the transfer auth token and shipment ID. Then proceed to the Fulfillment Gateway at http://localhost:12399/multihop/site-b.html, enter both the shipment ID and transfer auth token into the authorization form, and authorize the dispatch. Confirm that authorization code DISPATCHED-OK-2026 is displayed.
  ```
- **Success Criteria:**
  1. Navigated to Site A; extracted shipment ID `SHP-88301` and token `BENCHMARK-CODE-9204`.
  2. Navigated to Site B (`/multihop/site-b.html`).
  3. Input `#input-shipment-id` filled with `SHP-88301`.
  4. Input `#input-token` filled with `BENCHMARK-CODE-9204`.
  5. Button `#authorize-dispatch-btn` clicked.
  6. Final message `#dispatch-banner` displays confirmation code `DISPATCHED-OK-2026`.
- **Verification Routine:** `tasks.mjs` -> `verifyMultiHopTask`.

---

## 2. Variables That Must Remain Stable

To guarantee fair before/after comparisons between this baseline and future optimizations:

| Variable                   | Baseline Requirement                                              | Rationale                                            |
| :------------------------- | :---------------------------------------------------------------- | :--------------------------------------------------- |
| **Task Prompt**            | Verbatim text from Section 1 above                                | Eliminates prompt engineering variance               |
| **Fixture State**          | Local HTTP server on `127.0.0.1:12399` from `benchmark/fixtures/` | Ensures identical network latency and DOM structure  |
| **Browser Start State**    | Fresh browser tab or isolated MCP pin group; no cached page state | Prevents cross-task contamination                    |
| **Model & Reasoning Mode** | Explicitly recorded (e.g. `claude-3-7-sonnet` thinking standard)  | Enables model-controlled comparisons                 |
| **Session Isolation**      | Fresh session/task instance for each run                          | Avoids context-window leakage from previous attempts |
| **Success Criteria**       | Verified by deterministic DOM state inspection in `tasks.mjs`     | Objective ground truth                               |

---

## 3. Metrics Definition & Calculation

### Total MCP Calls (`totalMcpCalls`)

Every JSON-RPC `tools/call` invocation sent from the LLM agent to Chrome MCP.

- Measured by counting all request events in the session trace.
- Target of Issue #2: significantly reducing this number through Semantic Action Retrieval.

### Low-Level JavaScript Calls (`lowLevelJsCalls`)

Calls to tools that execute arbitrary JavaScript in the page:

- `chrome_javascript`
- `chrome_inject_script`
- `chrome_send_command_to_inject_script`
- Issue #2 targets reducing reliance on manual DOM-traversal scripts.

### Repeated Page Inspections (`repeatedPageInspections`)

An inspection call that occurs when the current page state has **already been inspected** and **no state-mutating action** has taken place since the last inspection.

- **Inspection Tools:** `chrome_read_page`, `chrome_get_web_content`, `chrome_screenshot`, `chrome_get_interactive_elements`, `search_tabs_content`, `chrome_console`, and DOM query scripts via `chrome_javascript`.
- **State Mutating Tools:** `chrome_click_element`, `chrome_fill_or_select`, `chrome_keyboard`, `chrome_handle_dialog`, `chrome_upload_file`, `chrome_navigate`, `chrome_switch_tab`.
- _Rule:_ The first inspection after navigation or a DOM mutation is considered normal verification. Any subsequent inspection before the next mutation counts as a repeated inspection (e.g. re-reading the page because an element was not found, or following a read with a screenshot).

### Retries (`retries`)

Number of tool invocations that returned an error and were subsequently re-attempted, or explicit polling attempts.

### Browser Execution Time (`browserExecutionTimeMs`)

The cumulative round-trip execution time (in milliseconds) spent in Chrome MCP tool handlers.

---

## 4. Execution Procedures

### Procedure A: Automated Capture via Agent Recorder Proxy (Recommended)

1. Start the Agent Recorder on port 12308:
   ```bash
   node benchmark/agent-recorder.mjs --task short-interaction
   ```
2. The recorder will:
   - Start the fixture server at `http://localhost:12399`.
   - Start a transparent MCP proxy at `http://127.0.0.1:12308/mcp` forwarding to live Chrome MCP at `12307`.
   - Display the exact prompt.
3. Configure your LLM agent (Cursor, Claude Desktop, Antigravity, Claude Code, etc.) to use `http://127.0.0.1:12308/mcp` as its Chrome MCP server.
4. Send the prompt to the agent.
5. When the agent completes the task, press **[ENTER]** in the recorder terminal.
6. The recorder automatically verifies the final browser DOM state, writes the metrics JSON to `benchmark/results/agent-<task>-<timestamp>.json`, and prints the summary.

### Procedure B: Manual Session Recording & Trace Analysis

If proxy routing is unavailable in your environment:

1. Ensure the fixture server is running:
   ```bash
   node benchmark/fixture-server.mjs
   ```
2. Run the agent against the live Chrome MCP server.
3. Collect the agent's MCP call log into a JSON file with structure:
   ```json
   {
     "task": "short-interaction",
     "model": "claude-3-7-sonnet",
     "calls": [
       {
         "name": "chrome_navigate",
         "args": { "url": "http://localhost:12399/short/index.html" },
         "durationMs": 15
       },
       { "name": "chrome_read_page", "args": { "depth": 8 }, "durationMs": 210 },
       { "name": "chrome_click_element", "args": { "selector": "#activate-btn" }, "durationMs": 35 }
     ],
     "taskSuccess": true
   }
4. Analyze the trace:
   ```bash
   node benchmark/analyze-trace.mjs path/to/trace.json
   ```
