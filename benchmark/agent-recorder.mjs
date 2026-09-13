#!/usr/bin/env node
/**
 * Agent Task-Level Benchmark Recorder & Proxy
 *
 * Provides transparent MCP proxying and telemetry recording for agent-level evaluation:
 * - Listens on proxy port (default: 12308) forwarding to live Chrome MCP server (port: 12307)
 * - Captures every tool invocation from any external LLM agent (Claude, Cursor, Codex, etc.)
 * - Records total MCP calls, low-level JS calls, repeated inspections, retries, latency
 * - Executes automated deterministic verification against the local fixture
 * - Writes standardized run traces to benchmark/results/
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';
import { createFixtureServer } from './fixture-server.mjs';
import { BenchmarkMetricsCollector } from './collector.mjs';
import { BenchmarkMcpClient } from './mcp-client.mjs';
import { AGENT_BENCHMARK_TASKS, getTaskById } from './tasks.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const RESULTS_DIR = path.join(__dirname, 'results');

function makeCallSignature(name, args) {
  return `${name || 'unknown'}:${JSON.stringify(args || {})}`;
}

function parseResponseContent(parsedResponse) {
  const content = parsedResponse?.result?.content;
  if (!Array.isArray(content)) {
    return { responseData: null, responseText: '' };
  }

  const responseText = content.map((c) => c.text || '').join('');
  try {
    const responseData = JSON.parse(responseText);
    return {
      responseData: responseData && typeof responseData === 'object' ? responseData : null,
      responseText,
    };
  } catch {
    return { responseData: null, responseText };
  }
}

export class AgentBenchmarkRecorder {
  constructor(options = {}) {
    this.proxyPort = options.proxyPort || parseInt(process.env.RECORDER_PORT || '12308', 10);
    this.targetMcpUrl = options.targetMcpUrl || process.env.MCP_URL || 'http://127.0.0.1:12307/mcp';
    this.fixturePort = options.fixturePort || parseInt(process.env.BENCHMARK_PORT || '12399', 10);
    this.taskId = options.taskId || 'short-interaction';
    this.task = getTaskById(this.taskId) || AGENT_BENCHMARK_TASKS[0];
    this.collector = new BenchmarkMetricsCollector(this.task.id, { autoClassifyJsQueries: true });
    this.server = null;
    this.fixtureServer = null;
    this.mcpClient = options.mcpClient || null;
    this.recordedEvents = [];
    this.activeTabId = null;
    this.isRecording = false;
    this.failedCallSignatures = new Set();
  }

  async start() {
    // 1. Start fixture server
    this.fixtureServer = createFixtureServer(this.fixturePort);
    const { url: fixtureBaseUrl } = await this.fixtureServer.start();

    // 2. Direct MCP client for verification (if not pre-injected)
    if (!this.mcpClient) {
      this.mcpClient = new BenchmarkMcpClient({ url: this.targetMcpUrl });
      try {
        await this.mcpClient.connect();
      } catch (err) {
        console.warn(`[Recorder] Notice: Target MCP connection check: ${err.message}`);
      }
    }

    // 3. Setup Proxy HTTP Server
    this.server = http.createServer(async (req, res) => {
      await this._handleProxyRequest(req, res);
    });

    await new Promise((resolve, reject) => {
      this.server.listen(this.proxyPort, '127.0.0.1', () => {
        resolve();
      });
      this.server.on('error', reject);
    });

    this.collector.start();
    this.isRecording = true;

    return {
      proxyUrl: `http://127.0.0.1:${this.proxyPort}/mcp`,
      fixtureBaseUrl,
      task: this.task,
    };
  }

  async stop() {
    this.isRecording = false;
    if (this.server) {
      if (typeof this.server.closeAllConnections === 'function') {
        this.server.closeAllConnections();
      }
      await new Promise((resolve) => this.server.close(resolve));
    }
    if (this.fixtureServer) {
      await this.fixtureServer.stop();
    }
  }

  async verifyAndFinalize(agentMetadata = {}) {
    let verification = { success: false, reason: 'Verification not run' };
    try {
      if (this.task && this.task.verify && this.mcpClient) {
        verification = await this.task.verify(this.mcpClient, { tabId: this.activeTabId });
      }
    } catch (err) {
      verification = { success: false, reason: `Verification error: ${err.message}` };
    }

    const summary = this.collector.finish(verification.success, verification.reason);
    summary.benchmarkLayer = 'agent-task-level';
    summary.taskDefinition = {
      id: this.task.id,
      name: this.task.name,
      category: this.task.category,
      prompt: this.task.prompt,
    };
    summary.agentMetadata = {
      model: agentMetadata.model || process.env.AGENT_MODEL || 'external-agent',
      reasoningMode:
        agentMetadata.reasoningMode || process.env.AGENT_REASONING_MODE || 'standard',
      environment: {
        proxyPort: this.proxyPort,
        targetMcpUrl: this.targetMcpUrl,
        nodeVersion: process.version,
        platform: process.platform,
      },
      ...agentMetadata,
    };

    if (!fs.existsSync(RESULTS_DIR)) {
      fs.mkdirSync(RESULTS_DIR, { recursive: true });
    }

    const timestampStr = new Date().toISOString().replace(/[:.]/g, '-');
    const outFile = path.join(RESULTS_DIR, `agent-${this.task.id}-${timestampStr}.json`);
    fs.writeFileSync(outFile, JSON.stringify(summary, null, 2), 'utf-8');

    return { summary, outFile, verification };
  }

  async _handleProxyRequest(clientReq, clientRes) {
    const targetUrl = new URL(clientReq.url || '/mcp', this.targetMcpUrl);

    // If client is pinging
    if (clientReq.url?.endsWith('/ping')) {
      clientRes.writeHead(200, { 'Content-Type': 'application/json' });
      clientRes.end(JSON.stringify({ status: 'ok', recorder: true, task: this.task.id }));
      return;
    }

    // Capture body for tools/call analysis
    const chunks = [];
    for await (const chunk of clientReq) {
      chunks.push(chunk);
    }
    const bodyBuffer = Buffer.concat(chunks);
    const bodyText = bodyBuffer.toString('utf-8');

    let parsedRpc = null;
    try {
      if (bodyText) {
        parsedRpc = JSON.parse(bodyText);
      }
    } catch {}

    const rpcCalls = Array.isArray(parsedRpc)
      ? parsedRpc.filter((r) => r?.method === 'tools/call')
      : parsedRpc?.method === 'tools/call'
        ? [parsedRpc]
        : [];

    const t0 = performance.now();

    // Prepare headers for forwarding
    const headers = { ...clientReq.headers };
    delete headers.host;

    try {
      const forwardRes = await fetch(targetUrl.href, {
        method: clientReq.method,
        headers,
        body: ['GET', 'HEAD'].includes(clientReq.method || '')
          ? undefined
          : bodyBuffer.length > 0
            ? bodyBuffer
            : undefined,
      });

      // Pass back status and headers
      const resHeaders = {};
      forwardRes.headers.forEach((val, key) => {
        resHeaders[key] = val;
      });
      clientRes.writeHead(forwardRes.status, resHeaders);

      // Handle long-lived SSE streaming (e.g. GET /mcp or GET /sse) without blocking
      const isEventStream = forwardRes.headers.get('content-type')?.includes('text/event-stream');
      if (isEventStream && clientReq.method === 'GET') {
        const reader = forwardRes.body.getReader();
        clientReq.on('close', () => {
          reader.cancel().catch(() => {});
        });
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            clientRes.write(value);
          }
        } catch {
          // Stream cancelled
        } finally {
          clientRes.end();
        }
        return;
      }

      const resBody = await forwardRes.text();
      clientRes.end(resBody);

      const durationMs = performance.now() - t0;

      if (rpcCalls.length > 0 && this.isRecording) {
        // Parse SSE or JSON results from Chrome MCP and associate responses with
        // their matching JSON-RPC request IDs. This prevents one failed response
        // in a batch from marking every call in the batch as failed.
        const parsedResponses = [];
        if (resBody.trim().startsWith('{') || resBody.trim().startsWith('[')) {
          try {
            const directJson = JSON.parse(resBody);
            if (Array.isArray(directJson)) {
              parsedResponses.push(...directJson);
            } else {
              parsedResponses.push(directJson);
            }
          } catch {}
        }
        for (const line of resBody.split('\n')) {
          if (line.startsWith('data: ')) {
            try {
              parsedResponses.push(JSON.parse(line.slice(6)));
            } catch {}
          }
        }

        const responsesById = new Map();
        for (const parsedRes of parsedResponses) {
          if (parsedRes?.id !== undefined && parsedRes?.id !== null) {
            responsesById.set(String(parsedRes.id), parsedRes);
          }
        }

        for (const rpc of rpcCalls) {
          const toolName = rpc?.params?.name;
          const toolArgs = rpc?.params?.arguments || {};
          if (toolArgs.tabId) {
            this.activeTabId = toolArgs.tabId;
          }

          const parsedRes = responsesById.get(String(rpc?.id));
          const { responseData, responseText } = parseResponseContent(parsedRes);
          if (responseData?.tabId) {
            this.activeTabId = responseData.tabId;
          }

          const isError = Boolean(
            forwardRes.status >= 400 || parsedRes?.error || parsedRes?.result?.isError,
          );
          const errorMessage =
            parsedRes?.error?.message ||
            (parsedRes?.result?.isError ? responseText || 'Tool returned isError: true' : null);

          const signature = makeCallSignature(toolName, toolArgs);
          const retried = this.failedCallSignatures.has(signature);
          if (isError) {
            this.failedCallSignatures.add(signature);
          } else {
            this.failedCallSignatures.delete(signature);
          }

          const callEvt = this.collector.recordCall({
            name: toolName,
            args: toolArgs,
            durationMs: Math.round((durationMs / rpcCalls.length) * 100) / 100,
            isError,
            error: errorMessage,
            retried,
            resultMeta: responseData ? { keys: Object.keys(responseData) } : {},
          });

          console.log(
            `  [Call #${callEvt.index}] ${toolName} (${callEvt.durationMs}ms)${isError ? ' [ERROR]' : ''}${retried ? ' [RETRY]' : ''}`,
          );
        }
      }
    } catch (err) {
      const durationMs = performance.now() - t0;
      if (rpcCalls.length > 0 && this.isRecording) {
        for (const rpc of rpcCalls) {
          const toolName = rpc?.params?.name;
          const toolArgs = rpc?.params?.arguments || {};
          const signature = makeCallSignature(toolName, toolArgs);
          const retried = this.failedCallSignatures.has(signature);
          this.failedCallSignatures.add(signature);
          this.collector.recordCall({
            name: toolName,
            args: toolArgs,
            durationMs: Math.round((durationMs / rpcCalls.length) * 100) / 100,
            isError: true,
            error: err.message,
            retried,
            resultMeta: { transportError: true },
          });
        }
      }

      console.error(`[Proxy Error]: ${err.message}`);
      clientRes.writeHead(502, { 'Content-Type': 'text/plain' });
      clientRes.end(`Bad Gateway: ${err.message}`);
    }
  }
}

// Allow CLI execution: node benchmark/agent-recorder.mjs [--task <id>]
if (process.argv[1] === __filename) {
  const args = process.argv.slice(2);
  let taskId = 'short-interaction';
  let model = process.env.AGENT_MODEL || 'external-agent';
  let reasoningMode = process.env.AGENT_REASONING_MODE || 'standard';

  const taskIndex = args.indexOf('--task');
  if (taskIndex !== -1 && args[taskIndex + 1]) {
    taskId = args[taskIndex + 1];
  }
  const modelIndex = args.indexOf('--model');
  if (modelIndex !== -1 && args[modelIndex + 1]) {
    model = args[modelIndex + 1];
  }
  const reasoningIndex = args.indexOf('--reasoning-mode');
  if (reasoningIndex !== -1 && args[reasoningIndex + 1]) {
    reasoningMode = args[reasoningIndex + 1];
  }

  const recorder = new AgentBenchmarkRecorder({ taskId });
  console.log('='.repeat(72));
  console.log(' Agent-Level Benchmark Recorder (Issue #1)');
  console.log('='.repeat(72));
  console.log(` Task ID:     ${recorder.task.id}`);
  console.log(` Task Name:   ${recorder.task.name}`);
  console.log(` Model:       ${model}`);
  console.log(` Reasoning:   ${reasoningMode}`);
  console.log(` Target MCP:  ${recorder.targetMcpUrl}`);
  console.log(` Proxy Port:  ${recorder.proxyPort}`);
  console.log('-'.repeat(72));
  console.log(` PROMPT FOR AGENT:\n"${recorder.task.prompt}"\n`);
  console.log('-'.repeat(72));

  recorder
    .start()
    .then(({ proxyUrl, fixtureBaseUrl }) => {
      console.log(` ✓ Proxy listening at: ${proxyUrl}`);
      console.log(` ✓ Fixtures hosted at: ${fixtureBaseUrl}`);
      console.log('\nPoint your LLM agent to the Proxy URL above and provide the prompt.');
      console.log('Press [ENTER] in this terminal when the agent has completed the task...\n');

      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.question('', async () => {
        console.log('\nTask completion indicated. Verifying browser state...');
        const { summary, outFile, verification } = await recorder.verifyAndFinalize({
          model,
          reasoningMode,
        });
        await recorder.stop();
        rl.close();

        console.log('='.repeat(72));
        console.log(` Result:               ${verification.success ? 'PASSED ✓' : 'FAILED ✗'}`);
        if (!verification.success) {
          console.log(` Failure Reason:       ${verification.reason}`);
        }
        console.log(` Total MCP Calls:      ${summary.totalMcpCalls}`);
        console.log(` Low-Level JS Calls:   ${summary.lowLevelJsCalls}`);
        console.log(` Repeated Inspections: ${summary.repeatedPageInspections}`);
        console.log(` Retries:              ${summary.retries}`);
        console.log(` Browser Time:         ${summary.browserExecutionTimeMs.toFixed(1)} ms`);
        console.log(` Trace written to:     ${outFile}`);
        console.log('='.repeat(72));
        process.exit(verification.success ? 0 : 1);
      });
    })
    .catch((err) => {
      console.error('Fatal error starting recorder:', err);
      process.exit(1);
    });
}
