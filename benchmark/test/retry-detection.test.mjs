import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { AgentBenchmarkRecorder } from '../agent-recorder.mjs';

async function closeServer(server) {
  await new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(resolve);
  });
}

async function post(port, payload) {
  return fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify(payload),
  });
}

test('AgentBenchmarkRecorder - canonicalizes object key order when detecting retries', async () => {
  let attempt = 0;
  const backend = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const rpc = JSON.parse(body);
      attempt++;
      const failed = attempt === 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: rpc.id,
          result: {
            isError: failed,
            content: [{ type: 'text', text: failed ? 'Element not found' : '{"success":true}' }],
          },
        }),
      );
    });
  });

  await new Promise((resolve) => backend.listen(12410, '127.0.0.1', resolve));
  const recorder = new AgentBenchmarkRecorder({
    proxyPort: 12411,
    targetMcpUrl: 'http://127.0.0.1:12410/mcp',
    fixturePort: 12412,
    mcpClient: { async callTool() { return { ok: false, error: 'unused' }; } },
  });
  await recorder.start();

  await post(12411, {
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'chrome_click_element', arguments: { selector: '#activate-btn', tabId: 42 } },
  });
  await post(12411, {
    jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'chrome_click_element', arguments: { tabId: 42, selector: '#activate-btn' } },
  });

  const summary = recorder.collector.finish(true);
  assert.equal(summary.retries, 1);
  assert.equal(summary.events[0].retried, false);
  assert.equal(summary.events[1].retried, true);

  await recorder.stop();
  await closeServer(backend);
});

test('AgentBenchmarkRecorder - identical calls in one batch are not retries of each other', async () => {
  const backend = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const calls = JSON.parse(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(calls.map((rpc) => ({
        jsonrpc: '2.0',
        id: rpc.id,
        result: { isError: true, content: [{ type: 'text', text: 'same failure' }] },
      }))));
    });
  });

  await new Promise((resolve) => backend.listen(12413, '127.0.0.1', resolve));
  const recorder = new AgentBenchmarkRecorder({
    proxyPort: 12414,
    targetMcpUrl: 'http://127.0.0.1:12413/mcp',
    fixturePort: 12415,
    mcpClient: { async callTool() { return { ok: false, error: 'unused' }; } },
  });
  await recorder.start();

  const call = (id) => ({
    jsonrpc: '2.0', id, method: 'tools/call',
    params: { name: 'chrome_read_page', arguments: { tabId: 42, depth: 8 } },
  });
  await post(12414, [call(1), call(2)]);

  const summary = recorder.collector.finish(false);
  assert.equal(summary.retries, 0);
  assert.equal(summary.events.every((e) => e.retried === false), true);

  await recorder.stop();
  await closeServer(backend);
});

test('AgentBenchmarkRecorder - missing batch response is an error, not success', async () => {
  const backend = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const calls = JSON.parse(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        id: calls[0].id,
        result: { content: [{ type: 'text', text: '{"ok":true}' }] },
      }));
    });
  });

  await new Promise((resolve) => backend.listen(12416, '127.0.0.1', resolve));
  const recorder = new AgentBenchmarkRecorder({
    proxyPort: 12417,
    targetMcpUrl: 'http://127.0.0.1:12416/mcp',
    fixturePort: 12418,
    mcpClient: { async callTool() { return { ok: false, error: 'unused' }; } },
  });
  await recorder.start();

  await post(12417, [
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'chrome_read_page', arguments: { tabId: 42 } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'chrome_click_element', arguments: { tabId: 42, selector: '#x' } } },
  ]);

  const summary = recorder.collector.finish(false);
  assert.equal(summary.events[0].isError, false);
  assert.equal(summary.events[1].isError, true);
  assert.equal(summary.events[1].resultMeta.missingResponse, true);

  await recorder.stop();
  await closeServer(backend);
});

test('AgentBenchmarkRecorder - streams POST SSE while recording the response', async () => {
  const backend = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const rpc = JSON.parse(body);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(': started\n\n');
      setTimeout(() => {
        res.end(`data: ${JSON.stringify({
          jsonrpc: '2.0', id: rpc.id,
          result: { content: [{ type: 'text', text: '{"ok":true}' }] },
        })}\n\n`);
      }, 20);
    });
  });

  await new Promise((resolve) => backend.listen(12419, '127.0.0.1', resolve));
  const recorder = new AgentBenchmarkRecorder({
    proxyPort: 12420,
    targetMcpUrl: 'http://127.0.0.1:12419/mcp',
    fixturePort: 12421,
    mcpClient: { async callTool() { return { ok: false, error: 'unused' }; } },
  });
  await recorder.start();

  const response = await post(12420, {
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'chrome_read_page', arguments: { tabId: 42 } },
  });
  const text = await response.text();
  assert.ok(text.includes(': started'));
  assert.ok(text.includes('data:'));

  const summary = recorder.collector.finish(true);
  assert.equal(summary.totalMcpCalls, 1);
  assert.equal(summary.events[0].isError, false);

  await recorder.stop();
  await closeServer(backend);
});
