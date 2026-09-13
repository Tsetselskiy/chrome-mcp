#!/usr/bin/env node
/**
 * Agent Benchmark Trace Analyzer
 *
 * Analyzes recorded MCP tool call traces (from agent runs, logs, or manual session dumps)
 * and computes standardized benchmark metrics:
 * - total MCP calls
 * - low-level JavaScript calls
 * - browser execution time
 * - repeated page inspections
 * - retries
 * - success / failure
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BenchmarkMetricsCollector } from './collector.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function analyzeTrace(traceData, options = {}) {
  const scenarioName = options.scenarioName || traceData.task || traceData.scenario || 'agent-task';
  const collector = new BenchmarkMetricsCollector(scenarioName, { autoClassifyJsQueries: true });
  collector.start();

  const calls = Array.isArray(traceData)
    ? traceData
    : Array.isArray(traceData.calls)
      ? traceData.calls
      : Array.isArray(traceData.events)
        ? traceData.events
        : [];

  for (const call of calls) {
    if (call.name === '__benchmark_retry__' || call.isRetryEvent) {
      collector.recordRetry(call.reason || '');
      continue;
    }

    collector.recordCall({
      name: call.name || call.toolName,
      args: call.args || call.arguments || {},
      durationMs: call.durationMs || call.duration || 0,
      isError: Boolean(call.isError || call.error),
      error: call.error || null,
      retried: Boolean(call.retried),
      isInspection: call.isInspection,
      isMutation: call.isMutation,
    });
  }

  const success = typeof options.success === 'boolean'
    ? options.success
    : typeof traceData.taskSuccess === 'boolean'
      ? traceData.taskSuccess
      : typeof traceData.success === 'boolean'
        ? traceData.success
        : true;

  const failureReason = options.failureReason || traceData.failureReason || null;
  const summary = collector.finish(success, failureReason);

  summary.benchmarkLayer = 'agent-task-level';
  summary.agentMetadata = {
    model: options.model || traceData.model || 'unspecified',
    reasoningMode: options.reasoningMode || traceData.reasoningMode || 'standard',
    ...traceData.agentMetadata,
  };

  return summary;
}

// Allow CLI execution: node benchmark/analyze-trace.mjs <trace-file.json>
if (process.argv[1] === __filename) {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: node benchmark/analyze-trace.mjs <trace-file.json>');
    process.exit(1);
  }

  const resolved = path.resolve(process.cwd(), file);
  if (!fs.existsSync(resolved)) {
    console.error(`File not found: ${resolved}`);
    process.exit(1);
  }

  const data = JSON.parse(fs.readFileSync(resolved, 'utf-8'));
  const summary = analyzeTrace(data);

  console.log('='.repeat(70));
  console.log(' Agent Benchmark Trace Analysis');
  console.log('='.repeat(70));
  console.log(` Task / Scenario:      ${summary.scenario}`);
  console.log(` Status:               ${summary.taskSuccess ? 'PASS' : 'FAIL'}`);
  console.log(` Total MCP Calls:      ${summary.totalMcpCalls}`);
  console.log(` Low-Level JS Calls:   ${summary.lowLevelJsCalls}`);
  console.log(` Browser Exec Time:    ${summary.browserExecutionTimeMs.toFixed(1)} ms`);
  console.log(` Page Inspections:     ${summary.pageInspectionCalls}`);
  console.log(` Repeated Inspections: ${summary.repeatedPageInspections}`);
  console.log(` Retries:              ${summary.retries}`);
  console.log(' Tool Breakdown:');
  for (const [tool, count] of Object.entries(summary.toolBreakdown)) {
    console.log(`   - ${tool.padEnd(28)}: ${count}`);
  }
  console.log('='.repeat(70));
}
