import { BenchmarkMcpClient } from './mcp-client.mjs';

const toolName = process.argv[2];
if (!toolName) {
  console.error('Usage: node benchmark/agent-mcp-cli.mjs <tool-name> [json-arguments]');
  process.exit(1);
}

let toolArgs = {};
if (process.argv[3]) {
  try {
    toolArgs = JSON.parse(process.argv[3]);
  } catch (err) {
    console.error('Invalid JSON arguments: ' + err.message);
    process.exit(1);
  }
}

const proxyUrl = process.env.MCP_URL || 'http://127.0.0.1:12308/mcp';
const client = new BenchmarkMcpClient({ url: proxyUrl });

try {
  await client.connect();
  const res = await client.callTool(toolName, toolArgs);
  if (!res.ok) {
    console.error('Tool error: ' + res.error);
    if (res.data) console.log(JSON.stringify(res.data, null, 2));
    process.exit(1);
  }
  console.log(JSON.stringify(res.data, null, 2));
} catch (err) {
  console.error('Execution error: ' + err.message);
  process.exit(1);
}
