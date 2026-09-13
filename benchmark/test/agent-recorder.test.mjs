import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import fs from 'node:fs';
import { AGENT_BENCHMARK_TASKS, getTaskById } from '../tasks.mjs';
import { AgentBenchmarkRecorder } from '../agent-recorder.mjs';
import { BenchmarkMetricsCollector } from '../collector.mjs';

test('Agent Benchmark Tasks - definitions cover representative categories', () => {
  assert.equal(AGENT_BENCHMARK_TASKS.length, 3);

  const shortTask = getTaskById('short-interaction');
  assert.ok(shortTask);
  assert.equal(shortTask.category, 'short-interaction');
  assert.ok(shortTask.prompt.includes('activate the primary service'));

  const dynamicTask = getTaskById('dynamic-multistep-interaction');
  assert.ok(dynamicTask);
  assert.equal(dynamicTask.category, 'dynamic-multistep');
  assert.ok(dynamicTask.prompt.includes('ALLOC-8891'));

  const multiTask = getTaskById('longer-multipage-workflow');
  assert.ok(multiTask);
  assert.equal(multiTask.category, 'longer-multipage');
  assert.ok(multiTask.prompt.includes('DISPATCHED-OK-2026'));
});

test('Agent Benchmark Tasks - verification logic detects goal states', async () => {
  const shortTask = getTaskById('short-interaction');

  // Case 1: Active
  const mockPassingClient = {
    async callTool(name, args) {
      return { ok: true, raw: 'Status: ACTIVE Service Activated Successfully' };
    },
  };
  const passRes = await shortTask.verify(mockPassingClient, {});
  assert.equal(passRes.success, true);

  // Case 2: Inactive
  const mockFailingClient = {
    async callTool(name, args) {
      return { ok: true, raw: 'Status: INACTIVE Service is stopped' };
    },
  };
  const failRes = await shortTask.verify(mockFailingClient, {});
  assert.equal(failRes.success, false);
});

test('AgentBenchmarkRecorder - proxies requests and collects telemetry', async () => {
  // Setup a mock backend server standing in for Chrome MCP
  let receivedCalls = [];
  const mockBackend = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        const rpc = JSON.parse(body);
        receivedCalls.push(rpc);
      } catch {}
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Mcp-Session-Id': 'test-session-123',
      });
      res.end('data: {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"{\\"success\\":true}"}]}}\n\n');
    });
  });

  const backendPort = 12401;
  await new Promise((resolve) => mockBackend.listen(backendPort, '127.0.0.1', resolve));

  const recorderPort = 12402;
  const fixturePort = 12403;
  const mockClient = {
    async callTool() {
      return { ok: true, raw: 'Status: ACTIVE Service Activated Successfully' };
    },
  };

  const recorder = new AgentBenchmarkRecorder({
    proxyPort: recorderPort,
    targetMcpUrl: `http://127.0.0.1:${backendPort}/mcp`,
    fixturePort,
    taskId: 'short-interaction',
    mcpClient: mockClient,
  });

  await recorder.start();

  // Send a tool call through the recorder proxy
  const payload = JSON.stringify({
    jsonrpc: '2.0',
    id: 10,
    method: 'tools/call',
    params: {
      name: 'chrome_click_element',
      arguments: { selector: '#activate-btn' },
    },
  });

  const clientReq = await fetch(`http://127.0.0.1:${recorderPort}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload,
  });

  assert.equal(clientReq.status, 200);
  assert.equal(receivedCalls.length, 1);
  assert.equal(receivedCalls[0].params.name, 'chrome_click_element');

  // Verify and finalize
  const { summary, outFile, verification } = await recorder.verifyAndFinalize({
    model: 'test-llm',
    reasoningMode: 'standard',
  });

  assert.equal(verification.success, true);
  assert.equal(summary.totalMcpCalls, 1);
  assert.equal(summary.benchmarkLayer, 'agent-task-level');

  if (outFile && fs.existsSync(outFile)) {
    fs.unlinkSync(outFile);
  }

  await recorder.stop();
  await new Promise((resolve) => {
    mockBackend.closeAllConnections?.();
    mockBackend.close(resolve);
  });
});

test('AgentBenchmarkRecorder - proxies streaming SSE GET connections without hanging', async () => {
  // Mock backend that keeps an SSE stream open
  const mockSseBackend = http.createServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(':\n\n');
      res.write('data: {"jsonrpc":"2.0","method":"ping"}\n\n');
      // Intentionally keep open until client disconnects
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    }
  });

  const backendPort = 12404;
  await new Promise((resolve) => mockSseBackend.listen(backendPort, '127.0.0.1', resolve));

  const recorderPort = 12405;
  const fixturePort = 12406;
  const recorder = new AgentBenchmarkRecorder({
    proxyPort: recorderPort,
    targetMcpUrl: `http://127.0.0.1:${backendPort}/mcp`,
    fixturePort,
    taskId: 'short-interaction',
    mcpClient: { async callTool() { return { ok: true }; } },
  });

  await recorder.start();

  // Connect to proxy using streaming fetch with abort controller
  const abortCtrl = new AbortController();
  const res = await fetch(`http://127.0.0.1:${recorderPort}/mcp`, {
    method: 'GET',
    headers: { Accept: 'text/event-stream' },
    signal: abortCtrl.signal,
  });

  assert.equal(res.status, 200);
  assert.ok(res.headers.get('content-type')?.includes('text/event-stream'));

  const reader = res.body.getReader();
  const { value } = await reader.read();
  const text = new TextDecoder().decode(value);
  assert.ok(text.includes('ping') || text.includes(':'));

  abortCtrl.abort();
  await recorder.stop();
  await new Promise((resolve) => {
    mockSseBackend.closeAllConnections?.();
    mockSseBackend.close(resolve);
  });
});

test('AgentBenchmarkRecorder - handles batch JSON-RPC requests', async () => {
  let batchReceived = null;
  const mockBatchBackend = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        batchReceived = JSON.parse(body);
      } catch {}
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify([
          { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '{"ok":true}' }] } },
          { jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: '{"ok":true}' }] } },
        ]),
      );
    });
  });

  const backendPort = 12407;
  await new Promise((resolve) => mockBatchBackend.listen(backendPort, '127.0.0.1', resolve));

  const recorderPort = 12408;
  const fixturePort = 12409;
  const recorder = new AgentBenchmarkRecorder({
    proxyPort: recorderPort,
    targetMcpUrl: `http://127.0.0.1:${backendPort}/mcp`,
    fixturePort,
    taskId: 'short-interaction',
    mcpClient: { async callTool() { return { ok: true, raw: 'ACTIVE' }; } },
  });

  await recorder.start();

  const batchPayload = JSON.stringify([
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'chrome_read_page', arguments: {} } },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'chrome_click_element', arguments: { selector: '#activate-btn' } } },
  ]);

  const clientReq = await fetch(`http://127.0.0.1:${recorderPort}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: batchPayload,
  });

  assert.equal(clientReq.status, 200);
  assert.equal(Array.isArray(batchReceived), true);
  assert.equal(batchReceived.length, 2);

  const { summary, outFile } = await recorder.verifyAndFinalize();
  assert.equal(summary.totalMcpCalls, 2);
  assert.equal(summary.toolBreakdown['chrome_read_page'], 1);
  assert.equal(summary.toolBreakdown['chrome_click_element'], 1);

  if (outFile && fs.existsSync(outFile)) {
    fs.unlinkSync(outFile);
  }

  await recorder.stop();
  await new Promise((resolve) => {
    mockBatchBackend.closeAllConnections?.();
    mockBatchBackend.close(resolve);
  });
});
