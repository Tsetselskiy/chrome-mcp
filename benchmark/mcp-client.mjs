/**
 * Benchmark MCP Client
 *
 * Connects to Chrome MCP Server over HTTP SSE/Streamable transport (or Mock transport)
 * and wraps all tool invocations with high-resolution performance timing and telemetry.
 */

export class BenchmarkMcpClient {
  constructor(options = {}) {
    this.baseUrl = options.url || process.env.MCP_URL || 'http://127.0.0.1:12307/mcp';
    this.sessionId = null;
    this.collector = null;
    this.nextRpcId = 1;
    this.mockHandler = options.mockHandler || null;
  }

  setCollector(collector) {
    this.collector = collector;
  }

  async connect() {
    if (this.mockHandler) {
      this.sessionId = 'mock-session-1';
      return { success: true, mock: true };
    }

    // Ping check
    const pingUrl = this.baseUrl.replace(/\/mcp\/?$/, '/ping');
    try {
      const pingRes = await fetch(pingUrl, { signal: AbortSignal.timeout(5000) });
      if (!pingRes.ok) {
        throw new Error(`Ping failed with HTTP ${pingRes.status}`);
      }
    } catch (err) {
      throw new Error(`Cannot reach Chrome MCP server at ${pingUrl}: ${err.message}`);
    }

    // Initialize MCP session
    const initPayload = {
      jsonrpc: '2.0',
      id: this.nextRpcId++,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'chrome-mcp-benchmark', version: '1.0.0' },
      },
    };

    const res = await this._rawRpc(null, initPayload);
    this.sessionId = res.sid;

    // Send initialized notification
    await this._rawRpc(this.sessionId, {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });

    return { success: true, sessionId: this.sessionId };
  }

  async listTools() {
    if (this.mockHandler) {
      return this.mockHandler.listTools ? await this.mockHandler.listTools() : [];
    }

    const { results } = await this._rawRpc(this.sessionId, {
      jsonrpc: '2.0',
      id: this.nextRpcId++,
      method: 'tools/list',
    });

    return results[0]?.result?.tools || [];
  }

  async callTool(name, args = {}, options = {}) {
    const t0 = performance.now();
    let isError = false;
    let errorObj = null;
    let data = null;
    let rawText = '';

    try {
      if (this.mockHandler) {
        data = await this.mockHandler.handleToolCall(name, args);
        rawText = typeof data === 'string' ? data : JSON.stringify(data);
      } else {
        const rpcPayload = {
          jsonrpc: '2.0',
          id: this.nextRpcId++,
          method: 'tools/call',
          params: { name, arguments: args },
        };

        const { results } = await this._rawRpc(this.sessionId, rpcPayload);
        const r = results[0];
        if (!r) {
          throw new Error(`Empty response calling tool ${name}`);
        }
        if (r.error) {
          throw new Error(r.error.message || JSON.stringify(r.error));
        }

        const content = r.result?.content || [];
        rawText = content.map((c) => c.text || '').join('\n');
        isError = Boolean(r.result?.isError);

        try {
          data = JSON.parse(rawText);
        } catch {
          data = rawText;
        }

        if (isError && !errorObj) {
          errorObj = new Error(rawText || 'Tool returned isError: true');
        }
      }
    } catch (err) {
      isError = true;
      errorObj = err;
    } finally {
      const durationMs = performance.now() - t0;
      if (this.collector) {
        this.collector.recordCall({
          name,
          args,
          durationMs,
          isError,
          error: errorObj?.message || null,
          retried: Boolean(options.isRetry),
        });
      }
    }

    if (isError) {
      return { ok: false, error: errorObj?.message || 'Tool execution failed', raw: rawText };
    }

    return { ok: true, data, raw: rawText };
  }

  async _rawRpc(session, payload) {
    const res = await fetch(this.baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...(session ? { 'Mcp-Session-Id': session } : {}),
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      throw new Error(`MCP HTTP error ${res.status}: ${await res.text()}`);
    }

    const sid = res.headers.get('mcp-session-id') || session;
    const body = await res.text();
    const results = [];
    for (const line of body.split('\n')) {
      if (line.startsWith('data: ')) {
        try {
          results.push(JSON.parse(line.slice(6)));
        } catch {
          // Ignore partial or comment lines
        }
      }
    }

    return { sid, results, body };
  }
}
