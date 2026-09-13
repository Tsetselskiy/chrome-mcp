import assert from 'node:assert/strict';
import test from 'node:test';
import { BenchmarkMetricsCollector } from '../collector.mjs';
import { BenchmarkMcpClient } from '../mcp-client.mjs';
import { runShortScenario } from '../scenarios/short.mjs';
import { runDynamicScenario } from '../scenarios/dynamic.mjs';
import { runMultiHopScenario } from '../scenarios/multihop.mjs';

test('BenchmarkMetricsCollector - records metrics accurately', () => {
  const collector = new BenchmarkMetricsCollector('test-scenario');
  collector.start();

  collector.recordCall({
    name: 'chrome_navigate',
    args: { url: 'http://localhost/test' },
    durationMs: 120,
    isError: false,
  });
  collector.recordCall({ name: 'chrome_read_page', args: {}, durationMs: 80, isError: false });
  collector.recordCall({
    name: 'chrome_read_page',
    args: { filter: 'interactive' },
    durationMs: 60,
    isError: false,
  });
  collector.recordCall({
    name: 'chrome_javascript',
    args: { code: 'document.title' },
    durationMs: 45,
    isError: false,
  });
  collector.recordRetry('polling element');

  const summary = collector.finish(true);
  assert.equal(summary.scenario, 'test-scenario');
  assert.equal(summary.taskSuccess, true);
  assert.equal(summary.totalMcpCalls, 4);
  assert.equal(summary.lowLevelJsCalls, 1);
  assert.equal(summary.browserExecutionTimeMs, 305);
  assert.equal(summary.pageInspectionCalls, 2);
  assert.equal(summary.repeatedPageInspections, 1);
  assert.equal(summary.retries, 1);
  assert.equal(summary.toolBreakdown['chrome_read_page'], 2);
  assert.equal(summary.toolBreakdown['chrome_javascript'], 1);
});

test('Mock Runner - runs scenarios deterministically with mock transport', async () => {
  const mockState = { shortState: 'INACTIVE', dynamicSelected: false, siteBAuthorized: false };
  const mockHandler = {
    async handleToolCall(name, args) {
      if (name === 'chrome_navigate') return { success: true };
      if (name === 'chrome_read_page') {
        let content = 'Generic page content';
        if (mockState.shortState === 'ACTIVE') content += ' Status: ACTIVE Service Activated';
        if (mockState.dynamicSelected)
          content +=
            ' select-btn-us-east-prod US-East Production Primary ALLOC-8891 Allocation confirmed';
        else content += ' select-btn-us-east-prod US-East Production Primary';
        if (mockState.siteBAuthorized)
          content += ' DISPATCHED-OK-2026 Dispatched successfully';
        else content += ' Fulfillment Authorization Gateway';
        return { success: true, pageContent: content };
      }
      if (name === 'chrome_click_element') {
        if (args.selector === '#activate-btn') mockState.shortState = 'ACTIVE';
        if (
          args.selector === '#select-btn-us-east-prod' ||
          args.selector === '#submit-allocation-btn'
        )
          mockState.dynamicSelected = true;
        if (args.selector === '#authorize-dispatch-btn') mockState.siteBAuthorized = true;
        return { success: true };
      }
      if (name === 'chrome_fill_or_select') return { success: true };
      if (name === 'chrome_javascript')
        return { token: 'BENCHMARK-CODE-9204', shipmentId: 'SHP-88301' };
      return { success: true };
    },
  };

  const client = new BenchmarkMcpClient({ mockHandler });
  await client.connect();

  const col1 = new BenchmarkMetricsCollector('short');
  client.setCollector(col1);
  col1.start();
  const sum1 = await runShortScenario(client, col1, {
    fixtureBaseUrl: 'http://localhost:12399',
  });
  assert.equal(sum1.taskSuccess, true);
  assert.equal(sum1.totalMcpCalls >= 3, true);

  const col2 = new BenchmarkMetricsCollector('dynamic');
  client.setCollector(col2);
  col2.start();
  const sum2 = await runDynamicScenario(client, col2, {
    fixtureBaseUrl: 'http://localhost:12399',
  });
  assert.equal(sum2.taskSuccess, true);
  assert.equal(sum2.totalMcpCalls >= 6, true);

  const col3 = new BenchmarkMetricsCollector('multihop');
  client.setCollector(col3);
  col3.start();
  const sum3 = await runMultiHopScenario(client, col3, {
    fixtureBaseUrl: 'http://localhost:12399',
  });
  assert.equal(sum3.taskSuccess, true);
  assert.equal(sum3.lowLevelJsCalls, 1);
});

test('BenchmarkMetricsCollector - tracks multi-tool inspections and DOM mutation resets', () => {
  const collector = new BenchmarkMetricsCollector('inspection-clarification-test');
  collector.start();
  collector.recordCall({ name: 'chrome_navigate', args: { url: 'http://localhost/test' } });
  collector.recordCall({ name: 'chrome_read_page' });
  collector.recordCall({ name: 'chrome_screenshot' });
  collector.recordCall({ name: 'chrome_console' });
  collector.recordCall({
    name: 'chrome_javascript',
    args: { code: 'document.querySelector("#btn").textContent' },
    isInspection: true,
  });
  collector.recordCall({ name: 'chrome_tabs_context' });
  collector.recordCall({ name: 'chrome_get_web_content' });
  collector.recordCall({ name: 'chrome_click_element', args: { selector: '#btn' } });
  collector.recordCall({ name: 'chrome_read_page' });
  collector.recordCall({ name: 'chrome_read_page' });

  const summary = collector.finish(true);
  assert.equal(summary.pageInspectionCalls, 7);
  assert.equal(summary.repeatedPageInspections, 5);
  assert.equal(summary.lowLevelJsCalls, 1);
});

test('BenchmarkMetricsCollector - autoClassifyJsQueries classifies DOM inspection queries', () => {
  const collector = new BenchmarkMetricsCollector('auto-classify-test', {
    autoClassifyJsQueries: true,
  });
  collector.start();
  collector.recordCall({ name: 'chrome_navigate', args: { url: 'http://localhost/test' } });
  collector.recordCall({
    name: 'chrome_javascript',
    args: { code: 'document.querySelector(".badge").innerText' },
  });
  collector.recordCall({
    name: 'chrome_javascript',
    args: { code: 'document.getElementById("status").textContent' },
  });
  const summary = collector.finish(true);
  assert.equal(summary.pageInspectionCalls, 2);
  assert.equal(summary.repeatedPageInspections, 1);
  assert.equal(summary.lowLevelJsCalls, 2);
});

test('BenchmarkMetricsCollector - long JS script mutations (>50 chars) properly reset inspection state', () => {
  const collector = new BenchmarkMetricsCollector('long-script-mutation-test', {
    autoClassifyJsQueries: true,
  });
  collector.start();
  collector.recordCall({ name: 'chrome_read_page' });
  const longMutationCode =
    '// Initialize target application state and invoke action\n' +
    'document.querySelector("#deeply-nested-container .confirm-action-button").click();';
  assert.ok(longMutationCode.length > 50);
  collector.recordCall({ name: 'chrome_javascript', args: { code: longMutationCode } });
  collector.recordCall({ name: 'chrome_read_page' });
  const summary = collector.finish(true);
  assert.equal(summary.pageInspectionCalls, 2);
  assert.equal(
    summary.repeatedPageInspections,
    0,
    'Inspection after long JS mutation must not be repeated',
  );
});

test('BenchmarkMetricsCollector - JS value setters are treated as mutations, not queries', () => {
  const collector = new BenchmarkMetricsCollector('setter-test', {
    autoClassifyJsQueries: true,
  });
  collector.start();
  collector.recordCall({ name: 'chrome_read_page' });
  const setterCall = collector.recordCall({
    name: 'chrome_javascript',
    args: { code: 'document.querySelector("#input-field").value = "test-value";' },
  });
  assert.equal(setterCall.isInspection, false, 'Setter must not be classified as inspection');
  assert.equal(setterCall.isMutation, true, 'Setter must be classified as mutation');
  collector.recordCall({ name: 'chrome_read_page' });
  const summary = collector.finish(true);
  assert.equal(summary.pageInspectionCalls, 2);
  assert.equal(summary.repeatedPageInspections, 0);
});

test('BenchmarkMetricsCollector - classifies actual chrome_computer actions appropriately', () => {
  const collector = new BenchmarkMetricsCollector('computer-test');
  collector.start();

  const screenshot = collector.recordCall({
    name: 'chrome_computer',
    args: { action: 'screenshot' },
  });
  assert.equal(screenshot.isInspection, true);
  assert.equal(screenshot.isMutation, false);

  for (const action of ['left_click', 'left_click_drag', 'scroll', 'fill', 'fill_form', 'type', 'key']) {
    const evt = collector.recordCall({ name: 'chrome_computer', args: { action } });
    assert.equal(evt.isInspection, false, `${action} must not be an inspection`);
    assert.equal(evt.isMutation, true, `${action} must reset inspected state`);
  }

  const zoom = collector.recordCall({ name: 'chrome_computer', args: { action: 'zoom' } });
  assert.equal(zoom.isInspection, true);
  assert.equal(zoom.isMutation, false);
});

test('BenchmarkMetricsCollector - failed mutation does not reset inspection state', () => {
  const collector = new BenchmarkMetricsCollector('failed-mutation-test');
  collector.start();

  collector.recordCall({ name: 'chrome_read_page' });
  collector.recordCall({
    name: 'chrome_click_element',
    args: { selector: '#missing-button' },
    isError: true,
    error: 'Element not found',
  });
  collector.recordCall({ name: 'chrome_read_page' });

  const summary = collector.finish(false);
  assert.equal(summary.pageInspectionCalls, 2);
  assert.equal(
    summary.repeatedPageInspections,
    1,
    'Inspection after a failed action must still count as repeated',
  );
});
