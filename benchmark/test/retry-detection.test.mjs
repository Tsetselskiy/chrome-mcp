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

test('AgentBenchmarkRecorder - counts a repeated failed tool call as a retry', async () => {
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
            content: [
              {
                type: 'text',
                text: failed ? 'Element not found' : '{"success":true}',
              },
            ],
          },
        }),
      );
    });
  });

  const backendPort = 12410;
  const recorderPort = 12411;
  const fixturePort = 12412;
  await new Promise((resolve) => backend.listen(backendPort, '127.0.0.1', resolve));

  const recorder = new AgentBenchmarkRecorder({
    proxyPort: recorderPort,
    targetMcpUrl: `http://127.0.0.1:${backendPort}/mcp`,
    fixturePort,
    taskId: 'short-interaction',
    mcpClient: { async callTool() { return { ok: true, raw: 'ACTIVE' }; } },
  });

  await recorder.start();

  const toolCall = (id) =>
    fetch(`http://127.0.0.1:${recorderPort}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: {
          name: 'chrome_click_element',
          arguments: { selector: '#activate-btn' },
        },
      }),
    });

  await toolCall(1);
  await toolCall(2);

  const summary = recorder.collector.finish(true);
  assert.equal(summary.totalMcpCalls, 2);
  assert.equal(summary.retries, 1);
  assert.equal(summary.events[0].isError, true);
  assert.equal(summary.events[0].retried, false);
  assert.equal(summary.events[1].isError, false);
  assert.equal(summary.events[1].retried, true);

  await recorder.stop();
  await closeServer(backend);
});

test('AgentBenchmarkRecorder - attributes batch errors to the matching JSON-RPC call only', async () => {
  const backend = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const calls = JSON.parse(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify([
          {
            jsonrpc: '2.0',
            id: calls[0].id,
            result: { isError: true, content: [{ type: 'text', text: 'Element not found' }] },
          },
          {
            jsonrpc: '2.0',
            id: calls[1].id,
            result: { content: [{ type: 'text', text: '{"success":true}' }] },
          },
        ]),
      );
    });
  });

  const backendPort = 12413;
  const recorderPort = 12414;
  const fixturePort = 12415;
  await new Promise((resolve) => backend.listen(backendPort, '127.0.0.1', resolve));

  const recorder = new AgentBenchmarkRecorder({
    proxyPort: recorderPort,
    targetMcpUrl: `http://127.0.0.1:${backendPort}/mcp`,
    fixturePort,
    taskId: 'short-interaction',
    mcpClient: { async callTool() { return { ok: true, raw: 'ACTIVE' }; } },
  });

  await recorder.start();

  await fetch(`http://127.0.0.1:${recorderPort}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify([
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'chrome_click_element', arguments: { selector: '#missing' } },
      },
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'chrome_read_page', arguments: {} },
      },
    ]),
  });

  const summary = recorder.collector.finish(true);
  assert.equal(summary.totalMcpCalls, 2);
  assert.equal(summary.events[0].isError, true);
  assert.equal(summary.events[1].isError, false);

  await recorder.stop();
  await closeServer(backend);
});
