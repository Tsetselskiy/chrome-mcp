#!/usr/bin/env node
/**
 * Benchmark Mock Runner
 *
 * Runs the deterministic benchmark scenarios in mock mode (in-memory simulated transport)
 * to verify collector logic and benchmark flow in CI/test environments where live Chrome
 * or Chrome MCP is not available.
 *
 * NOTE: Mock runs validate benchmark harness infrastructure and MUST NOT be used
 * as the canonical performance baseline.
 */

import { runBenchmarkSuite } from './runner.mjs';

export function createMockHandler() {
  const state = {
    shortState: 'INACTIVE',
    dynamicSelected: false,
    siteBAuthorized: false,
  };

  return {
    async handleToolCall(name, args) {
      if (name === 'chrome_tabs_context') {
        return { success: true, groupId: 1001 };
      }
      if (name === 'chrome_navigate') {
        return { success: true, tabId: 42, url: args.url };
      }
      if (name === 'chrome_read_page') {
        let content = 'Generic mock page content';
        if (state.shortState === 'ACTIVE') {
          content += ' Status: ACTIVE Service Activated';
        }
        if (state.dynamicSelected) {
          content += ' select-btn-us-east-prod US-East Production Primary ALLOC-8891 Allocation confirmed';
        } else {
          content += ' select-btn-us-east-prod US-East Production Primary';
        }
        if (state.siteBAuthorized) {
          content += ' DISPATCHED-OK-2026 Dispatched successfully';
        } else {
          content += ' Fulfillment Authorization Gateway';
        }
        return { success: true, pageContent: content };
      }
      if (name === 'chrome_click_element') {
        if (args.selector === '#activate-btn') {
          state.shortState = 'ACTIVE';
        }
        if (args.selector === '#select-btn-us-east-prod' || args.selector === '#submit-allocation-btn') {
          state.dynamicSelected = true;
        }
        if (args.selector === '#authorize-dispatch-btn') {
          state.siteBAuthorized = true;
        }
        return { success: true };
      }
      if (name === 'chrome_fill_or_select') {
        return { success: true };
      }
      if (name === 'chrome_javascript') {
        return { token: 'BENCHMARK-CODE-9204', shipmentId: 'SHP-88301' };
      }
      return { success: true };
    },
    async listTools() {
      return [
        { name: 'chrome_navigate' },
        { name: 'chrome_read_page' },
        { name: 'chrome_click_element' },
        { name: 'chrome_fill_or_select' },
        { name: 'chrome_javascript' },
      ];
    },
  };
}

if (process.argv[1] === import.meta.filename) {
  runBenchmarkSuite({
    mockHandler: createMockHandler(),
    saveBaseline: true,
  })
    .then((res) => {
      const allPassed = res.totals.failureCount === 0;
      process.exit(allPassed ? 0 : 1);
    })
    .catch((err) => {
      console.error('Mock runner error:', err);
      process.exit(1);
    });
}
