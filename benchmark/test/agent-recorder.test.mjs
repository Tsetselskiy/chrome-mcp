import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import fs from 'node:fs';
import { AGENT_BENCHMARK_TASKS, getTaskById } from '../tasks.mjs';
import { AgentBenchmarkRecorder } from '../agent-recorder.mjs';

function shortVerificationClient(overrides = {}) {
  return {
    async callTool() {
      return {
        ok: true,
        data: {
          pathname: '/short/index.html',
          status: 'ACTIVE',
          message: 'Service Activated Successfully',
          messageVisible: true,
          buttonDisabled: true,
          ...overrides,
        },
      };
    },
  };
}

async function closeServer(server) {
  await new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(resolve);
  });
}

test('Agent Benchmark Tasks - definitions cover representative categories', () => {
  assert.equal(AGENT_BENCHMARK_TASKS.length, 3);
  assert.ok(getTaskById('short-interaction')?.prompt.includes('activate the primary service'));
  assert.ok(getTaskById('dynamic-multistep-interaction')?.prompt.includes('ALLOC-8891'));
  assert.ok(getTaskById('longer-multipage-workflow')?.prompt.includes('DISPATCHED-OK-2026'));
});

test('Agent Benchmark Tasks - short verification rejects INACTIVE and missing tab IDs', async () => {
  const shortTask = getTaskById('short-interaction');

  const passRes = await shortTask.verify(shortVerificationClient(), { tabId: 42 });
  assert.equal(passRes.success, true);

  const inactiveRes = await shortTask.verify(shortVerificationClient({ status: 'INACTIVE' }), {
    tabId: 42,
  });
  assert.equal(inactiveRes.success, false);

  const missingTabRes = await shortTask.verify(shortVerificationClient(), {});
  assert.equal(missingTabRes.success, false);
});

test('Agent Benchmark Tasks - dynamic verification rejects wrong cluster and default node count', async () => {
  const task = getTaskById('dynamic-multistep-interaction');
  const client = {
    async callTool() {
      return {
        ok: true,
        data: {
          pathname: '/dynamic/index.html',
          filter: 'us-east',
          selectedCluster: 'US-West Staging Cluster',
          nodeCount: '4',
          successVisible: true,
          confirmedTarget: 'US-West Staging Cluster',
          confirmedNodes: '4',
          reference: 'ALLOC-8891',
          submitDisabled: true,
        },
      };
    },
  };

  const result = await task.verify(client, { tabId: 42 });
  assert.equal(result.success, false);
});

test('AgentBenchmarkRecorder - proxies requests and collects telemetry', async () => {
  const receivedCalls = [];
  const mockBackend = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const rpc = JSON.parse(body);
      receivedCalls.push(rpc);
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Mcp-Session-Id': 'test-session-123',
      });
      res.end(
        `data: ${JSON.stringify({
          jsonrpc: '2.0',
          id: rpc.id,
          result: { content: [{ type: 'text', text: '{"success":true,"tabId":42}' }] },
        })}\n\n`,
      );
    });
  });

  const backendPort = 12401;
  await new Promise((resolve) => mockBackend.listen(backendPort, '127.0.0.1', resolve));

  const recorder = new AgentBenchmarkRecorder({
    proxyPort: 12402,
    targetMcpUrl: `http://127.0.0.1:${backendPort}/mcp`,
    fixturePort: 12403,
    taskId: 'short-interaction',
    mcpClient: shortVerificationClient(),
  });

  await recorder.start();

  const payload = JSON.stringify({
    jsonrpc: '2.0',
    id: 10,
    method: 'tools/call',
    params: {
      name: 'chrome_click_element',
      arguments: { selector: '#activate-btn', tabId: 42 },
    },
  });

  const clientReq = await fetch('http://127.0.0.1:12402/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload,
  });

  assert.equal(clientReq.status, 200);
  assert.equal(receivedCalls.length, 1);

  const { summary, outFile, verification } = await recorder.verifyAndFinalize({
    model: 'test-llm',
    reasoningMode: 'standard',
  });

  assert.equal(verification.success, true);
  assert.equal(summary.totalMcpCalls, 1);
  assert.equal(summary.benchmarkLayer, 'agent-task-level');

  if (outFile && fs.existsSync(outFile)) fs.unlinkSync(outFile);
  await recorder.stop();
  await closeServer(mockBackend);
});

test('AgentBenchmarkRecorder - proxies streaming SSE GET connections without hanging', async () => {
  const mockSseBackend = http.createServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(':\n\n');
      res.write('data: {"jsonrpc":"2.0","method":"ping"}\n\n');
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    }
  });

  await new Promise((resolve) => mockSseBackend.listen(12404, '127.0.0.1', resolve));

  const recorder = new AgentBenchmarkRecorder({
    proxyPort: 12405,
    targetMcpUrl: 'http://127.0.0.1:12404/mcp',
    fixturePort: 12406,
    taskId: 'short-interaction',
    mcpClient: shortVerificationClient(),
  });

  await recorder.start();

  const abortCtrl = new AbortController();
  const res = await fetch('http://127.0.0.1:12405/mcp', {
    method: 'GET',
    headers: { Accept: 'text/event-stream' },
    signal: abortCtrl.signal,
  });

  assert.equal(res.status, 200);
  const reader = res.body.getReader();
  const { value } = await reader.read();
  const text = new TextDecoder().decode(value);
  assert.ok(text.includes('ping') || text.includes(':'));

  abortCtrl.abort();
  await recorder.stop();
  await closeServer(mockSseBackend);
});

test('AgentBenchmarkRecorder - handles batch JSON-RPC requests by response ID', async () => {
  let batchReceived = null;
  const mockBatchBackend = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      batchReceived = JSON.parse(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify([
          {
            jsonrpc: '2.0',
            id: batchReceived[1].id,
            result: { content: [{ type: 'text', text: '{"ok":true,"tabId":42}' }] },
          },
          {
            jsonrpc: '2.0',
            id: batchReceived[0].id,
            result: { content: [{ type: 'text', text: '{"ok":true}' }] },
          },
        ]),
      );
    });
  });

  await new Promise((resolve) => mockBatchBackend.listen(12407, '127.0.0.1', resolve));

  const recorder = new AgentBenchmarkRecorder({
    proxyPort: 12408,
    targetMcpUrl: 'http://127.0.0.1:12407/mcp',
    fixturePort: 12409,
    taskId: 'short-interaction',
    mcpClient: shortVerificationClient(),
  });

  await recorder.start();

  await fetch('http://127.0.0.1:12408/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify([
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'chrome_read_page', arguments: { tabId: 42 } },
      },
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'chrome_click_element',
          arguments: { selector: '#activate-btn', tabId: 42 },
        },
      },
    ]),
  });

  const summary = recorder.collector.finish(true);
  assert.equal(summary.totalMcpCalls, 2);
  assert.equal(summary.events.every((e) => e.isError === false), true);
  assert.equal(summary.events.every((e) => e.resultMeta.batchSize === 2), true);

  await recorder.stop();
  await closeServer(mockBatchBackend);
});
