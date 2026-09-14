#!/usr/bin/env node
/**
 * Agent Task-Level Benchmark Recorder & Proxy
 *
 * Transparently forwards MCP traffic while recording agent-selected tool calls.
 * The recorded latency is client-observed MCP round-trip time, not isolated
 * browser-handler execution time.
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

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function makeCallSignature(name, args) {
  return `${name || 'unknown'}:${JSON.stringify(canonicalize(args || {}))}`;
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

function parseRpcResponses(bodyText) {
  const parsedResponses = [];
  const trimmed = bodyText.trim();

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const directJson = JSON.parse(trimmed);
      if (Array.isArray(directJson)) parsedResponses.push(...directJson);
      else parsedResponses.push(directJson);
    } catch {}
  }

  for (const line of bodyText.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload) continue;
    try {
      parsedResponses.push(JSON.parse(payload));
    } catch {}
  }

  return parsedResponses;
}

export class AgentBenchmarkRecorder {
  constructor(options = {}) {
    this.proxyPort = options.proxyPort || parseInt(process.env.RECORDER_PORT || '12308', 10);
    this.targetMcpUrl = options.targetMcpUrl || process.env.MCP_URL || 'http://127.0.0.1:12307/mcp';
    this.fixturePort = options.fixturePort || parseInt(process.env.BENCHMARK_PORT || '12399', 10);
    this.resultsDir = options.resultsDir || process.env.BENCHMARK_RESULTS_DIR || RESULTS_DIR;
    this.taskId = options.taskId || 'short-interaction';
    this.task = getTaskById(this.taskId) || AGENT_BENCHMARK_TASKS[0];
    this.collector = new BenchmarkMetricsCollector(this.task.id, { autoClassifyJsQueries: true });
    this.server = null;
    this.fixtureServer = null;
    this.mcpClient = options.mcpClient || null;
    this.activeTabId = null;
    this.isRecording = false;
    this.failedCallSignatures = new Set();
  }

  async start() {
    this.fixtureServer = createFixtureServer(this.fixturePort);
    const { url: fixtureBaseUrl } = await this.fixtureServer.start();

    if (!this.mcpClient) {
      this.mcpClient = new BenchmarkMcpClient({ url: this.targetMcpUrl });
      try {
        await this.mcpClient.connect();
      } catch (err) {
        console.warn(`[Recorder] Notice: Target MCP connection check: ${err.message}`);
      }
    }

    this.server = http.createServer(async (req, res) => {
      await this._handleProxyRequest(req, res);
    });

    await new Promise((resolve, reject) => {
      this.server.listen(this.proxyPort, '127.0.0.1', resolve);
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
      if (typeof this.server.closeAllConnections === 'function') this.server.closeAllConnections();
      await new Promise((resolve) => this.server.close(resolve));
    }
    if (this.fixtureServer) await this.fixtureServer.stop();
  }

  async verifyAndFinalize(agentMetadata = {}) {
    let verification = { success: false, reason: 'Verification not run' };
    try {
      if (this.task?.verify && this.mcpClient) {
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
      model: agentMetadata.model || process.env.AGENT_MODEL || 'unspecified',
      reasoningMode:
        agentMetadata.reasoningMode || process.env.AGENT_REASONING_MODE || 'unspecified',
      environment: {
        proxyPort: this.proxyPort,
        targetMcpUrl: this.targetMcpUrl,
        nodeVersion: process.version,
        platform: process.platform,
      },
      ...agentMetadata,
    };

    const targetResultsDir = this.resultsDir;
    if (!fs.existsSync(targetResultsDir)) fs.mkdirSync(targetResultsDir, { recursive: true });

    const timestampStr = new Date().toISOString().replace(/[:.]/g, '-');
    const outFile = path.join(targetResultsDir, `agent-${this.task.id}-${timestampStr}.json`);
    fs.writeFileSync(outFile, JSON.stringify(summary, null, 2), 'utf-8');

    return { summary, outFile, verification };
  }

  _recordRpcCalls({ rpcCalls, httpStatus, bodyText, durationMs, transportError = null }) {
    if (!this.isRecording || rpcCalls.length === 0) return;

    const parsedResponses = parseRpcResponses(bodyText || '');
    const responsesById = new Map();
    for (const parsedRes of parsedResponses) {
      if (parsedRes?.id !== undefined && parsedRes?.id !== null) {
        responsesById.set(String(parsedRes.id), parsedRes);
      }
    }

    // Retry state is snapshotted before the whole HTTP request. Calls in the same
    // JSON-RPC batch therefore cannot become retries of each other.
    const failedBeforeBatch = new Set(this.failedCallSignatures);
    const outcomesBySignature = new Map();
    const batchSize = rpcCalls.length;
    const apportionedDurationMs = durationMs / Math.max(1, batchSize);

    for (const rpc of rpcCalls) {
      const toolName = rpc?.params?.name;
      const toolArgs = rpc?.params?.arguments || {};
      const parsedRes = responsesById.get(String(rpc?.id));
      const missingResponse = !transportError && !parsedRes;
      const { responseData, responseText } = parseResponseContent(parsedRes);

      if (toolArgs.tabId !== undefined && toolArgs.tabId !== null) {
        this.activeTabId = toolArgs.tabId;
      }
      if (responseData?.tabId !== undefined && responseData?.tabId !== null) {
        this.activeTabId = responseData.tabId;
      }

      const isError = Boolean(
        transportError ||
          httpStatus >= 400 ||
          missingResponse ||
          parsedRes?.error ||
          parsedRes?.result?.isError,
      );
      const errorMessage =
        transportError?.message ||
        parsedRes?.error?.message ||
        (missingResponse ? 'No parseable JSON-RPC response matched this tools/call request ID' : null) ||
        (parsedRes?.result?.isError ? responseText || 'Tool returned isError: true' : null);

      const signature = makeCallSignature(toolName, toolArgs);
      const retried = failedBeforeBatch.has(signature);
      const scopeTabId =
        toolArgs.tabId ?? responseData?.tabId ?? this.activeTabId ?? null;

      const callEvt = this.collector.recordCall({
        name: toolName,
        args: toolArgs,
        scopeKey: scopeTabId !== null ? `tab:${scopeTabId}` : 'default',
        durationMs: Math.round(apportionedDurationMs * 100) / 100,
        isError,
        error: errorMessage,
        retried,
        resultMeta: {
          ...(responseData ? { keys: Object.keys(responseData) } : {}),
          batchSize,
          timingAttribution:
            batchSize > 1 ? 'shared-http-roundtrip-apportioned' : 'single-http-roundtrip',
          missingResponse,
          transportError: Boolean(transportError),
        },
      });

      const existing = outcomesBySignature.get(signature) || { anySuccess: false, anyError: false };
      if (isError) existing.anyError = true;
      else existing.anySuccess = true;
      outcomesBySignature.set(signature, existing);

      console.log(
        `  [Call #${callEvt.index}] ${toolName} (${callEvt.durationMs}ms)` +
          `${isError ? ' [ERROR]' : ''}${retried ? ' [RETRY]' : ''}`,
      );
    }

    for (const [signature, outcome] of outcomesBySignature) {
      if (outcome.anySuccess) this.failedCallSignatures.delete(signature);
      else if (outcome.anyError) this.failedCallSignatures.add(signature);
    }
  }

  async _handleProxyRequest(clientReq, clientRes) {
    const targetUrl = new URL(clientReq.url || '/mcp', this.targetMcpUrl);

    if (clientReq.url?.endsWith('/ping')) {
      clientRes.writeHead(200, { 'Content-Type': 'application/json' });
      clientRes.end(JSON.stringify({ status: 'ok', recorder: true, task: this.task.id }));
      return;
    }

    const chunks = [];
    for await (const chunk of clientReq) chunks.push(chunk);
    const bodyBuffer = Buffer.concat(chunks);
    const bodyText = bodyBuffer.toString('utf-8');

    let parsedRpc = null;
    try {
      if (bodyText) parsedRpc = JSON.parse(bodyText);
    } catch {}

    const rpcCalls = Array.isArray(parsedRpc)
      ? parsedRpc.filter((r) => r?.method === 'tools/call')
      : parsedRpc?.method === 'tools/call'
        ? [parsedRpc]
        : [];

    const t0 = performance.now();
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

      const resHeaders = {};
      forwardRes.headers.forEach((val, key) => {
        resHeaders[key] = val;
      });
      clientRes.writeHead(forwardRes.status, resHeaders);

      const isEventStream = forwardRes.headers.get('content-type')?.includes('text/event-stream');
      let responseBody = '';

      if (isEventStream) {
        const reader = forwardRes.body.getReader();
        const responseChunks = [];
        clientReq.on('close', () => {
          reader.cancel().catch(() => {});
        });

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            responseChunks.push(Buffer.from(value));
            clientRes.write(value);
          }
        } catch {
          // Stream cancellation is handled below as a missing/partial response if needed.
        } finally {
          clientRes.end();
        }
        responseBody = Buffer.concat(responseChunks).toString('utf-8');
      } else {
        responseBody = await forwardRes.text();
        clientRes.end(responseBody);
      }

      const durationMs = performance.now() - t0;
      this._recordRpcCalls({
        rpcCalls,
        httpStatus: forwardRes.status,
        bodyText: responseBody,
        durationMs,
      });
    } catch (err) {
      const durationMs = performance.now() - t0;
      this._recordRpcCalls({
        rpcCalls,
        httpStatus: 502,
        bodyText: '',
        durationMs,
        transportError: err,
      });

      console.error(`[Proxy Error]: ${err.message}`);
      if (!clientRes.headersSent) {
        clientRes.writeHead(502, { 'Content-Type': 'text/plain' });
      }
      if (!clientRes.writableEnded) clientRes.end(`Bad Gateway: ${err.message}`);
    }
  }
}

if (process.argv[1] === __filename) {
  const args = process.argv.slice(2);
  let taskId = 'short-interaction';
  let model = process.env.AGENT_MODEL || 'unspecified';
  let reasoningMode = process.env.AGENT_REASONING_MODE || 'unspecified';
  let resultsDir = process.env.BENCHMARK_RESULTS_DIR || RESULTS_DIR;
  let condition = process.env.BENCHMARK_CONDITION || 'unspecified';
  let sourceSha = process.env.BENCHMARK_SOURCE_SHA || 'unspecified';
  let chromeVersion = process.env.BENCHMARK_CHROME_VERSION || '152.0.7977.83';

  const taskIndex = args.indexOf('--task');
  if (taskIndex !== -1 && args[taskIndex + 1]) taskId = args[taskIndex + 1];
  const modelIndex = args.indexOf('--model');
  if (modelIndex !== -1 && args[modelIndex + 1]) model = args[modelIndex + 1];
  const reasoningIndex = args.indexOf('--reasoning-mode');
  if (reasoningIndex !== -1 && args[reasoningIndex + 1]) reasoningMode = args[reasoningIndex + 1];
  const outDirIndex = args.indexOf('--out-dir');
  if (outDirIndex !== -1 && args[outDirIndex + 1]) resultsDir = args[outDirIndex + 1];
  const conditionIndex = args.indexOf('--condition');
  if (conditionIndex !== -1 && args[conditionIndex + 1]) condition = args[conditionIndex + 1];
  const shaIndex = args.indexOf('--source-sha');
  if (shaIndex !== -1 && args[shaIndex + 1]) sourceSha = args[shaIndex + 1];
  const chromeIndex = args.indexOf('--chrome-version');
  if (chromeIndex !== -1 && args[chromeIndex + 1]) chromeVersion = args[chromeIndex + 1];

  const recorder = new AgentBenchmarkRecorder({ taskId, resultsDir });
  console.log('='.repeat(72));
  console.log(' Agent-Level Benchmark Recorder (Issue #1)');
  console.log('='.repeat(72));
  console.log(` Task ID:        ${recorder.task.id}`);
  console.log(` Task Name:      ${recorder.task.name}`);
  console.log(` Condition:      ${condition}`);
  console.log(` Source SHA:     ${sourceSha}`);
  console.log(` Model:          ${model}`);
  console.log(` Reasoning:      ${reasoningMode}`);
  console.log(` Chrome Version: ${chromeVersion}`);
  console.log(` Target MCP:     ${recorder.targetMcpUrl}`);
  console.log(` Proxy Port:     ${recorder.proxyPort}`);
  console.log(` Output Dir:     ${resultsDir}`);
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
          condition,
          sourceSha,
          chromeVersion,
          os: `${process.platform} ${process.arch}`,
        });
        await recorder.stop();
        rl.close();

        console.log('='.repeat(72));
        console.log(` Result:               ${verification.success ? 'PASSED ✓' : 'FAILED ✗'}`);
        if (!verification.success) console.log(` Failure Reason:       ${verification.reason}`);
        console.log(` Total MCP Calls:      ${summary.totalMcpCalls}`);
        console.log(` Low-Level JS Calls:   ${summary.lowLevelJsCalls}`);
        console.log(` Repeated Inspections: ${summary.repeatedPageInspections}`);
        console.log(` Retries:              ${summary.retries}`);
        console.log(` MCP Round-Trip Time:  ${summary.mcpRoundTripTimeMs.toFixed(1)} ms`);
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
