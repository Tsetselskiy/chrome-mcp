# Agent / Task-Level Benchmark Protocol (Issue #1 Baseline)

This protocol defines the reproducible BEFORE measurement used to evaluate whether Issue #2 reduces LLM ↔ MCP round trips without reducing task success.

## Task 1: Short Interaction (`short-interaction`)

Start URL: `http://localhost:12399/short/index.html`

Exact prompt:

```text
Navigate to the CloudOps Console at http://localhost:12399/short/index.html and activate the primary service. Confirm that the status changes to ACTIVE.
```

Strict success requires the final page to be `/short/index.html`, status exactly `ACTIVE`, the success message visible with exact text, and the activation button disabled.

## Task 2: Dynamic Multi-Step (`dynamic-multistep-interaction`)

Start URL: `http://localhost:12399/dynamic/index.html`

Exact prompt:

```text
Navigate to the Cluster Orchestrator at http://localhost:12399/dynamic/index.html. Search for cluster "us-east", select the "US-East Production Primary" cluster from the dynamically filtered results, set the allocation node count to 8, and submit the allocation. Confirm that allocation reference ALLOC-8891 is displayed.
```

Strict success requires all of the following final state: filter exactly `us-east`, selected/confirmed cluster exactly `US-East Production Primary`, node count and confirmed node count exactly `8`, visible success alert, reference exactly `ALLOC-8891`, and disabled submit button.

## Task 3: Longer Multi-Page Workflow (`longer-multipage-workflow`)

Start URL: `http://localhost:12399/multihop/site-a.html`

Exact prompt:

```text
Navigate to the Origin Hub dispatch manifest at http://localhost:12399/multihop/site-a.html. Find the transfer auth token and shipment ID. Then proceed to the Fulfillment Gateway at http://localhost:12399/multihop/site-b.html, enter both the shipment ID and transfer auth token into the authorization form, and authorize the dispatch. Confirm that authorization code DISPATCHED-OK-2026 is displayed.
```

Strict success requires final page `/multihop/site-b.html`, shipment `SHP-88301`, token `BENCHMARK-CODE-9204`, visible success and hidden error banner, confirmed shipment `SHP-88301`, dispatch code `DISPATCHED-OK-2026`, and disabled authorization button.

## Variables that must remain stable

For BEFORE/AFTER comparisons keep these fixed and record them with every run:

- exact task prompt;
- fixture revision/source SHA;
- fresh fixture/browser state;
- fresh agent conversation/session for each task;
- model name/snapshot as exposed by the agent environment;
- reasoning mode/effort;
- Chrome MCP source revision and extension/native-server versions;
- Chrome version;
- MCP routing/configuration;
- success criteria and verifier implementation.

Do not compare agent runs made with materially different model snapshots or system/tool configurations as though they were a controlled A/B test.

## Metrics

### Total MCP calls (`totalMcpCalls`)

Every recorded JSON-RPC `tools/call` initiated by the agent.

### Low-level JavaScript (`lowLevelJsCalls`)

Calls to arbitrary JavaScript execution tools such as `chrome_javascript`, `chrome_inject_script`, and `chrome_send_command_to_inject_script`.

### Page inspections (`pageInspectionCalls`)

Content/state reads including `chrome_read_page`, `chrome_get_web_content`, screenshots/zoom inspections, interactive-element reads, selected console/content search tools, and recognized DOM-reading `chrome_javascript`.

### Repeated inspections (`repeatedPageInspections`)

An inspection is repeated only when the same tab/page scope has already been inspected and no successful state-changing action has occurred in that scope since the prior inspection. State is tracked per tab. Failed actions do not reset it.

### Retries (`retries`)

In the recording proxy, a retry means the same tool with canonically equivalent arguments is invoked in a later JSON-RPC request after that exact call previously failed. Calls submitted together in the same batch are not retries of one another. Polling/reinspection remains a separate metric unless a deterministic scenario explicitly marks a retry.

### MCP round-trip time (`mcpRoundTripTimeMs`)

Client-observed request/response latency. It includes proxy/HTTP transport, serialization, native messaging, server execution, and browser work. It is not isolated browser-handler execution time. For batch requests the single HTTP round-trip is apportioned across calls only so the aggregate is not double-counted; per-call batch timings are not handler timings.

### Task success (`taskSuccess`)

Success comes only from the strict post-run DOM verifier. Verification traffic uses the direct MCP client and is not part of the measured agent call trace. Missing or unparseable verification is failure.

## Recommended capture procedure

1. Start from the exact source revision being benchmarked.
2. Run benchmark tests and the deterministic live benchmark first.
3. Start a fresh agent session for exactly one task.
4. Route that session's Chrome MCP traffic through `http://127.0.0.1:12308/mcp`.
5. Start the recorder with explicit labels, for example:

```bash
node benchmark/agent-recorder.mjs \
  --task short-interaction \
  --model "Gemini 3.8 Flash High" \
  --reasoning-mode high
```

6. Send the exact task prompt, with no extra hints.
7. When the agent says it is finished, press Enter in the recorder terminal.
8. Confirm the verifier reports PASS before accepting the trace.
9. Repeat from a fresh session for the other task IDs.

## Required BEFORE artifacts for Issue #2

Before merging the Issue #1 baseline PR, retain one reviewed real trace for each of the three task IDs, plus the corrected live deterministic baseline. Future Issue #2 AFTER runs must use the same prompts and materially equivalent agent configuration.

If Antigravity or another agent cannot route through the proxy, a manual trace is acceptable only when it preserves exact MCP calls and contains explicit independently verified `taskSuccess`. `analyze-trace.mjs` fails closed when success evidence is missing.
