#!/usr/bin/env node
/**
 * Chrome MCP Performance Baseline & Benchmark Suite Runner
 *
 * Implements Issue #1 with deterministic workflows for regression checks.
 * Latency is reported as client-observed MCP round-trip time, not isolated
 * browser-handler execution time.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createFixtureServer } from './fixture-server.mjs';
import { BenchmarkMcpClient } from './mcp-client.mjs';
import { BenchmarkMetricsCollector } from './collector.mjs';
import { runShortScenario } from './scenarios/short.mjs';
import { runDynamicScenario } from './scenarios/dynamic.mjs';
import { runMultiHopScenario } from './scenarios/multihop.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const RESULTS_DIR = path.join(__dirname, 'results');

function readPackageVersion(relativePath) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf-8'));
    return data.version || null;
  } catch {
    return null;
  }
}

function getSourceSha() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return process.env.BENCHMARK_SOURCE_SHA || null;
  }
}

function buildEnvironmentMetadata({ isLiveRun, executionMode, mcpUrl, pinGroupId }) {
  const cpus = os.cpus();
  return {
    executionMode,
    isLiveRun,
    sourceSha: getSourceSha(),
    browser: isLiveRun ? 'Google Chrome (Live Extension Connected)' : 'Mock In-Memory Transport',
    chromeVersion: process.env.BENCHMARK_CHROME_VERSION || null,
    extensionVersion: readPackageVersion('app/chrome-extension/package.json'),
    nativeServerVersion: readPackageVersion('app/native-server/package.json'),
    mcpTransport: isLiveRun ? 'Streamable HTTP (Fastify)' : 'Mock In-Memory',
    nodeVersion: process.version,
    platform: process.platform,
    osRelease: os.release(),
    osVersion: typeof os.version === 'function' ? os.version() : null,
    arch: process.arch,
    cpuModel: cpus[0]?.model || null,
    logicalCpuCount: cpus.length || null,
    totalMemoryBytes: os.totalmem(),
    mcpUrl: isLiveRun ? mcpUrl : null,
    pinGroupId: pinGroupId || null,
    warmupState: process.env.BENCHMARK_WARMUP_STATE || 'not-specified',
    latencySampleCount: 1,
    latencyInterpretation:
      'Single-run client-observed MCP round-trip latency. Includes HTTP transport, serialization, native messaging, server work, and browser work; use only for same-environment comparisons.',
  };
}

export async function runBenchmarkSuite(options = {}) {
  const fixturePort = options.fixturePort || parseInt(process.env.BENCHMARK_PORT || '12399', 10);
  const mcpUrl = options.mcpUrl || process.env.MCP_URL || 'http://127.0.0.1:12307/mcp';
  const saveBaseline = options.saveBaseline !== false;

  console.log('='.repeat(70));
  console.log(' Chrome MCP Performance Benchmark Suite (Issue #1 Baseline)');
  console.log('='.repeat(70));
  console.log(` Target MCP URL:    ${mcpUrl}`);
  console.log(` Fixture Base Port: ${fixturePort}`);

  const fixtureServer = createFixtureServer(fixturePort);
  const { url: fixtureBaseUrl } = await fixtureServer.start();
  console.log(` ✓ Fixture server started at ${fixtureBaseUrl}`);

  const client = new BenchmarkMcpClient({
    url: mcpUrl,
    mockHandler: options.mockHandler || null,
  });

  try {
    const conn = await client.connect();
    console.log(` ✓ Connected to Chrome MCP server (session: ${conn.sessionId || 'active'})`);
  } catch (err) {
    console.error(` ✗ Failed to connect to Chrome MCP server: ${err.message}`);
    await fixtureServer.stop();
    throw err;
  }

  let pinGroupId = null;
  try {
    const contextRes = await client.callTool('chrome_tabs_context', { createIfEmpty: true });
    if (contextRes.ok && contextRes.data?.groupId) {
      pinGroupId = contextRes.data.groupId;
      console.log(` ✓ MCP Pin Group established (groupId: ${pinGroupId})`);
    }
  } catch (err) {
    console.warn(` · Pin group check notice: ${err.message}`);
  }

  const scenarios = [
    { name: 'Short Navigation & Interaction', fn: runShortScenario },
    { name: 'Dynamic Multi-Step Interaction', fn: runDynamicScenario },
    { name: 'Long Multi-Page Workflow', fn: runMultiHopScenario },
  ];

  const results = [];

  for (const s of scenarios) {
    console.log(`\n▶ Running scenario: ${s.name}...`);
    const collector = new BenchmarkMetricsCollector(s.name, { autoClassifyJsQueries: true });
    client.setCollector(collector);
    collector.start();

    const summary = await s.fn(client, collector, { fixtureBaseUrl });
    results.push(summary);

    const statusBadge = summary.taskSuccess ? 'SUCCESS' : 'FAILED';
    console.log(`  [${statusBadge}] ${summary.scenario}`);
    console.log(`  • Total MCP Calls:           ${summary.totalMcpCalls}`);
    console.log(`  • Low-level JS Calls:        ${summary.lowLevelJsCalls}`);
    console.log(`  • MCP Round-Trip Time (ms):  ${summary.mcpRoundTripTimeMs.toFixed(2)} ms`);
    console.log(`  • Wall Clock Duration (ms):  ${summary.wallClockDurationMs.toFixed(2)} ms`);
    console.log(`  • Page Inspection Calls:     ${summary.pageInspectionCalls}`);
    console.log(`  • Repeated Page Inspections: ${summary.repeatedPageInspections}`);
    console.log(`  • Retries:                   ${summary.retries}`);
    if (!summary.taskSuccess && summary.failureReason) {
      console.log(`  • Failure Reason:            ${summary.failureReason}`);
    }
  }

  await fixtureServer.stop();
  console.log(`\n✓ Fixture server stopped.`);

  const isLiveRun = !options.mockHandler;
  const executionMode = isLiveRun ? 'live-mcp-browser' : 'mock';

  const aggregate = {
    benchmarkLayer: 'deterministic-low-level',
    canonicalBaseline: isLiveRun,
    executionMode,
    isLiveRun,
    timestamp: new Date().toISOString(),
    environment: buildEnvironmentMetadata({ isLiveRun, executionMode, mcpUrl, pinGroupId }),
    totals: {
      scenariosCount: results.length,
      successCount: results.filter((r) => r.taskSuccess).length,
      failureCount: results.filter((r) => !r.taskSuccess).length,
      totalMcpCalls: results.reduce((acc, r) => acc + r.totalMcpCalls, 0),
      lowLevelJsCalls: results.reduce((acc, r) => acc + r.lowLevelJsCalls, 0),
      mcpRoundTripTimeMs:
        Math.round(results.reduce((acc, r) => acc + r.mcpRoundTripTimeMs, 0) * 100) / 100,
      browserExecutionTimeMs: null,
      wallClockDurationMs:
        Math.round(results.reduce((acc, r) => acc + r.wallClockDurationMs, 0) * 100) / 100,
      pageInspectionCalls: results.reduce((acc, r) => acc + r.pageInspectionCalls, 0),
      repeatedPageInspections: results.reduce((acc, r) => acc + r.repeatedPageInspections, 0),
      retries: results.reduce((acc, r) => acc + r.retries, 0),
    },
    scenarios: results,
  };

  printReportTable(aggregate);

  if (saveBaseline) {
    if (!fs.existsSync(RESULTS_DIR)) {
      fs.mkdirSync(RESULTS_DIR, { recursive: true });
    }
    const outputFilename = isLiveRun ? 'baseline.json' : 'mock-baseline.json';
    const baselineFile = path.join(RESULTS_DIR, outputFilename);
    fs.writeFileSync(baselineFile, JSON.stringify(aggregate, null, 2), 'utf-8');
    console.log(
      `\n✓ ${isLiveRun ? 'Canonical baseline (LIVE)' : 'Mock validation'} measurements written to: ${baselineFile}`,
    );
  }

  return aggregate;
}

function printReportTable(aggregate) {
  console.log('\n' + '='.repeat(86));
  console.log(' BENCHMARK BASELINE SUMMARY (Issue #1)');
  console.log('='.repeat(86));

  console.log(
    '| ' +
      'Scenario'.padEnd(32) +
      ' | ' +
      'Status'.padEnd(8) +
      ' | ' +
      'MCP Calls'.padEnd(10) +
      ' | ' +
      'Low-Level JS'.padEnd(12) +
      ' | ' +
      'MCP RTT'.padEnd(14) +
      ' | ' +
      'Rep. Insp.'.padEnd(10) +
      ' | ' +
      'Retries'.padEnd(7) +
      ' |',
  );
  console.log(
    '|-' +
      '-'.repeat(32) +
      '-|-' +
      '-'.repeat(8) +
      '-|-' +
      '-'.repeat(10) +
      '-|-' +
      '-'.repeat(12) +
      '-|-' +
      '-'.repeat(14) +
      '-|-' +
      '-'.repeat(10) +
      '-|-' +
      '-'.repeat(7) +
      '-|',
  );

  for (const s of aggregate.scenarios) {
    const status = s.taskSuccess ? 'PASS' : 'FAIL';
    console.log(
      '| ' +
        s.scenario.padEnd(32) +
        ' | ' +
        status.padEnd(8) +
        ' | ' +
        String(s.totalMcpCalls).padEnd(10) +
        ' | ' +
        String(s.lowLevelJsCalls).padEnd(12) +
        ' | ' +
        `${s.mcpRoundTripTimeMs.toFixed(1)} ms`.padEnd(14) +
        ' | ' +
        String(s.repeatedPageInspections).padEnd(10) +
        ' | ' +
        String(s.retries).padEnd(7) +
        ' |',
    );
  }

  const t = aggregate.totals;
  console.log(
    '| ' +
      'TOTAL'.padEnd(32) +
      ' | ' +
      `${t.successCount}/${t.scenariosCount}`.padEnd(8) +
      ' | ' +
      String(t.totalMcpCalls).padEnd(10) +
      ' | ' +
      String(t.lowLevelJsCalls).padEnd(12) +
      ' | ' +
      `${t.mcpRoundTripTimeMs.toFixed(1)} ms`.padEnd(14) +
      ' | ' +
      String(t.repeatedPageInspections).padEnd(10) +
      ' | ' +
      String(t.retries).padEnd(7) +
      ' |',
  );
  console.log('='.repeat(86));
}

if (process.argv[1] === __filename) {
  runBenchmarkSuite()
    .then((res) => {
      const allPassed = res.totals.failureCount === 0;
      process.exit(allPassed ? 0 : 1);
    })
    .catch((err) => {
      console.error('\nBenchmark Suite execution error:', err);
      process.exit(1);
    });
}
