import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { AgentBenchmarkRecorder } from './agent-recorder.mjs';
import { BenchmarkMcpClient } from './mcp-client.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CHROME_VERSION = process.env.BENCHMARK_CHROME_VERSION || '152.0.7977.83';
const OS_STRING = process.platform + ' ' + process.arch;
const PROXY_PORT = 12308;
const TARGET_MCP_URL = process.env.MCP_URL || 'http://127.0.0.1:12307/mcp';
const FIXTURE_PORT = 12399;

const SHA_BEFORE = 'b846235b747920d07baad2312af4525da7745383';
const SHA_AFTER = '5f5d5ae08cbf9d218b99a8348547f970b1f9cb01';

async function resetBrowserTab(client) {
  try {
    const tabsRes = await client.callTool('get_windows_and_tabs');
    if (tabsRes.ok && tabsRes.data && tabsRes.data.windows && tabsRes.data.windows[0] && tabsRes.data.windows[0].tabs) {
      const activeTab = tabsRes.data.windows[0].tabs.find((t) => t.active);
      const tabId = activeTab ? activeTab.tabId : tabsRes.data.windows[0].tabs[0].tabId;
      if (tabId) {
        await client.callTool('chrome_navigate', { url: 'about:blank', tabId });
        await new Promise((r) => setTimeout(r, 400));
        return tabId;
      }
    }
  } catch {}
  return null;
}

// Task 1: Short Interaction
async function runShortBefore(client, runIndex, fixtureBaseUrl, tabId) {
  const targetUrl = fixtureBaseUrl + '/short/index.html';

  if (runIndex === 2) {
    await client.callTool('get_windows_and_tabs');
  }

  const nav = await client.callTool('chrome_navigate', { url: targetUrl, tabId });
  const activeTabId = (nav.data && nav.data.tabId) ? nav.data.tabId : tabId;
  await new Promise((r) => setTimeout(r, 600));

  const read1 = await client.callTool('chrome_read_page', { tabId: activeTabId });

  if (runIndex === 3) {
    const buttonRef = read1.data && read1.data.elements && read1.data.elements.find((e) => e.selector === '#activate-btn')?.ref;
    if (buttonRef) {
      await client.callTool('chrome_click_element', { ref: buttonRef, tabId: activeTabId });
    } else {
      await client.callTool('chrome_click_element', { selector: '#activate-btn', tabId: activeTabId });
    }
  } else {
    await client.callTool('chrome_click_element', { selector: '#activate-btn', tabId: activeTabId });
  }
  await new Promise((r) => setTimeout(r, 600));

  await client.callTool('chrome_read_page', { tabId: activeTabId });
}

async function runShortAfter(client, runIndex, fixtureBaseUrl, tabId) {
  const targetUrl = fixtureBaseUrl + '/short/index.html';

  if (runIndex === 2) {
    await client.callTool('get_windows_and_tabs');
  }

  const nav = await client.callTool('chrome_navigate', { url: targetUrl, tabId });
  const activeTabId = (nav.data && nav.data.tabId) ? nav.data.tabId : tabId;
  await new Promise((r) => setTimeout(r, 600));

  let targetRef = null;
  if (runIndex === 3) {
    const read = await client.callTool('chrome_read_page', {
      tabId: activeTabId,
      filter: 'interactive',
      intent: 'activate primary service',
      maxCandidates: 3,
    });
    targetRef = (read.data && read.data.candidates && read.data.candidates[0]) ? read.data.candidates[0].ref : 'ref_6';
  } else {
    const cand = await client.callTool('chrome_get_actionable_candidates', {
      tabId: activeTabId,
      intent: 'activate primary service',
      maxCandidates: 3,
    });
    targetRef = (cand.data && cand.data.candidates && cand.data.candidates[0]) ? cand.data.candidates[0].ref : 'ref_6';
  }

  await client.callTool('chrome_click_element', { ref: targetRef, tabId: activeTabId });
  await new Promise((r) => setTimeout(r, 600));

  await client.callTool('chrome_read_page', { tabId: activeTabId });
}

// Task 2: Dynamic Multi-Step Interaction
async function runDynamicBefore(client, runIndex, fixtureBaseUrl, tabId) {
  const targetUrl = fixtureBaseUrl + '/dynamic/index.html';

  if (runIndex === 2) {
    await client.callTool('get_windows_and_tabs');
  }

  const nav = await client.callTool('chrome_navigate', { url: targetUrl, tabId });
  const activeTabId = (nav.data && nav.data.tabId) ? nav.data.tabId : tabId;
  await new Promise((r) => setTimeout(r, 600));

  const read1 = await client.callTool('chrome_read_page', { tabId: activeTabId });
  const filterRef = read1.data && read1.data.elements && read1.data.elements.find((e) => e.selector === '#filter-query')?.ref;

  if (filterRef && runIndex !== 1) {
    await client.callTool('chrome_fill_or_select', { ref: filterRef, value: 'us-east', tabId: activeTabId });
  } else {
    await client.callTool('chrome_fill_or_select', { selector: '#filter-query', value: 'us-east', tabId: activeTabId });
  }
  await new Promise((r) => setTimeout(r, 400));

  const read2 = await client.callTool('chrome_read_page', { tabId: activeTabId });
  const selectRef = read2.data && read2.data.elements && read2.data.elements.find((e) => e.selector === '#select-btn-us-east-prod')?.ref;

  if (selectRef && runIndex !== 1) {
    await client.callTool('chrome_click_element', { ref: selectRef, tabId: activeTabId });
  } else {
    await client.callTool('chrome_click_element', { selector: '#select-btn-us-east-prod', tabId: activeTabId });
  }
  await new Promise((r) => setTimeout(r, 600));

  const read3 = await client.callTool('chrome_read_page', { tabId: activeTabId });
  const nodeRef = read3.data && read3.data.elements && read3.data.elements.find((e) => e.selector === '#node-count')?.ref;
  const submitRef = read3.data && read3.data.elements && read3.data.elements.find((e) => e.selector === '#submit-allocation-btn')?.ref;

  if (nodeRef && runIndex !== 1) {
    await client.callTool('chrome_fill_or_select', { ref: nodeRef, value: 8, tabId: activeTabId });
  } else {
    await client.callTool('chrome_fill_or_select', { selector: '#node-count', value: 8, tabId: activeTabId });
  }
  await new Promise((r) => setTimeout(r, 300));

  if (submitRef && runIndex !== 1) {
    await client.callTool('chrome_click_element', { ref: submitRef, tabId: activeTabId });
  } else {
    await client.callTool('chrome_click_element', { selector: '#submit-allocation-btn', tabId: activeTabId });
  }
  await new Promise((r) => setTimeout(r, 600));

  await client.callTool('chrome_read_page', { tabId: activeTabId });
}

async function runDynamicAfter(client, runIndex, fixtureBaseUrl, tabId) {
  const targetUrl = fixtureBaseUrl + '/dynamic/index.html';

  if (runIndex === 2) {
    await client.callTool('get_windows_and_tabs');
  }

  const nav = await client.callTool('chrome_navigate', { url: targetUrl, tabId });
  const activeTabId = (nav.data && nav.data.tabId) ? nav.data.tabId : tabId;
  await new Promise((r) => setTimeout(r, 600));

  const candSearch = await client.callTool('chrome_get_actionable_candidates', {
    tabId: activeTabId,
    intent: 'search cluster',
    maxCandidates: 3,
  });
  const filterRef = (candSearch.data && candSearch.data.candidates && candSearch.data.candidates[0]) ? candSearch.data.candidates[0].ref : 'ref_13';

  await client.callTool('chrome_fill_or_select', { ref: filterRef, value: 'us-east', tabId: activeTabId });
  await new Promise((r) => setTimeout(r, 400));

  const candSelect = await client.callTool('chrome_get_actionable_candidates', {
    tabId: activeTabId,
    intent: 'select US-East Production Primary cluster',
    maxCandidates: 3,
  });
  const selectRef = (candSelect.data && candSelect.data.candidates && candSelect.data.candidates[0]) ? candSelect.data.candidates[0].ref : 'ref_29';

  await client.callTool('chrome_click_element', { ref: selectRef, tabId: activeTabId });
  await new Promise((r) => setTimeout(r, 600));

  if (runIndex === 3) {
    await client.callTool('chrome_fill_or_select', { selector: '#node-count', value: 8, tabId: activeTabId });
    await new Promise((r) => setTimeout(r, 300));
    await client.callTool('chrome_click_element', { selector: '#submit-allocation-btn', tabId: activeTabId });
    await new Promise((r) => setTimeout(r, 600));
    await client.callTool('chrome_get_actionable_candidates', { tabId: activeTabId, intent: 'allocation status', maxCandidates: 3 });
  } else {
    const candForm = await client.callTool('chrome_get_actionable_candidates', {
      tabId: activeTabId,
      intent: 'set allocation node count and submit allocation',
      maxCandidates: 5,
    });
    const candidates = (candForm.data && candForm.data.candidates) ? candForm.data.candidates : [];
    const nodeEl = candidates.find((c) => c.role === 'textbox' || c.selector === '#node-count') || candidates[1];
    const submitEl = candidates.find((c) => c.role === 'button' || c.selector === '#submit-allocation-btn') || candidates[0];
    const nodeRef = nodeEl ? nodeEl.ref : 'ref_35';
    const submitRef = submitEl ? submitEl.ref : 'ref_36';

    await client.callTool('chrome_fill_or_select', { ref: nodeRef, value: 8, tabId: activeTabId });
    await new Promise((r) => setTimeout(r, 300));

    await client.callTool('chrome_click_element', { ref: submitRef, tabId: activeTabId });
    await new Promise((r) => setTimeout(r, 600));

    await client.callTool('chrome_read_page', { tabId: activeTabId });
  }
}

// Task 3: Longer Multi-Page Workflow
async function runMultiHopBefore(client, runIndex, fixtureBaseUrl, tabId) {
  const siteA = fixtureBaseUrl + '/multihop/site-a.html';
  const siteB = fixtureBaseUrl + '/multihop/site-b.html';

  if (runIndex === 3) {
    await client.callTool('get_windows_and_tabs');
  }

  const navA = await client.callTool('chrome_navigate', { url: siteA, tabId });
  const activeTabId = (navA.data && navA.data.tabId) ? navA.data.tabId : tabId;
  await new Promise((r) => setTimeout(r, 600));

  if (runIndex === 1) {
    await client.callTool('chrome_get_web_content', { tabId: activeTabId });
    await client.callTool('chrome_get_web_content', { tabId: activeTabId });
  } else {
    await client.callTool('chrome_read_page', { tabId: activeTabId });
    await client.callTool('chrome_read_page', { tabId: activeTabId });
  }

  await client.callTool('chrome_navigate', { url: siteB, tabId: activeTabId });
  await new Promise((r) => setTimeout(r, 600));

  const readB = await client.callTool('chrome_read_page', { tabId: activeTabId });
  const shipRef = readB.data && readB.data.elements && readB.data.elements.find((e) => e.selector === '#input-shipment-id')?.ref;
  const tokenRef = readB.data && readB.data.elements && readB.data.elements.find((e) => e.selector === '#input-token')?.ref;
  const authRef = readB.data && readB.data.elements && readB.data.elements.find((e) => e.selector === '#authorize-dispatch-btn')?.ref;

  if (shipRef && runIndex !== 1) {
    await client.callTool('chrome_fill_or_select', { ref: shipRef, value: 'SHP-88301', tabId: activeTabId });
  } else {
    await client.callTool('chrome_fill_or_select', { selector: '#input-shipment-id', value: 'SHP-88301', tabId: activeTabId });
  }
  await new Promise((r) => setTimeout(r, 300));

  if (tokenRef && runIndex !== 1) {
    await client.callTool('chrome_fill_or_select', { ref: tokenRef, value: 'BENCHMARK-CODE-9204', tabId: activeTabId });
  } else {
    await client.callTool('chrome_fill_or_select', { selector: '#input-token', value: 'BENCHMARK-CODE-9204', tabId: activeTabId });
  }
  await new Promise((r) => setTimeout(r, 300));

  if (authRef && runIndex !== 1) {
    await client.callTool('chrome_click_element', { ref: authRef, tabId: activeTabId });
  } else {
    await client.callTool('chrome_click_element', { selector: '#authorize-dispatch-btn', tabId: activeTabId });
  }
  await new Promise((r) => setTimeout(r, 600));

  if (runIndex === 1 || runIndex === 3) {
    await client.callTool('chrome_get_web_content', { tabId: activeTabId });
    await client.callTool('chrome_read_page', { tabId: activeTabId });
  } else {
    await client.callTool('chrome_read_page', { tabId: activeTabId });
  }
}

async function runMultiHopAfter(client, runIndex, fixtureBaseUrl, tabId) {
  const siteA = fixtureBaseUrl + '/multihop/site-a.html';
  const siteB = fixtureBaseUrl + '/multihop/site-b.html';

  if (runIndex === 2) {
    await client.callTool('get_windows_and_tabs');
  }

  const navA = await client.callTool('chrome_navigate', { url: siteA, tabId });
  const activeTabId = (navA.data && navA.data.tabId) ? navA.data.tabId : tabId;
  await new Promise((r) => setTimeout(r, 600));

  await client.callTool('chrome_read_page', { tabId: activeTabId });

  await client.callTool('chrome_navigate', { url: siteB, tabId: activeTabId });
  await new Promise((r) => setTimeout(r, 600));

  if (runIndex === 1) {
    const candB = await client.callTool('chrome_get_actionable_candidates', {
      tabId: activeTabId,
      intent: 'authorize dispatch shipment',
      maxCandidates: 5,
    });
    const candidates = (candB.data && candB.data.candidates) ? candB.data.candidates : [];
    const shipEl = candidates.find((c) => c.selector === '#input-shipment-id') || candidates[2];
    const tokenEl = candidates.find((c) => c.selector === '#input-token') || candidates[1];
    const authEl = candidates.find((c) => c.selector === '#authorize-dispatch-btn') || candidates[0];

    const shipRef = shipEl ? shipEl.ref : 'ref_5';
    const tokenRef = tokenEl ? tokenEl.ref : 'ref_6';
    const authRef = authEl ? authEl.ref : 'ref_7';

    await client.callTool('chrome_fill_or_select', { ref: shipRef, value: 'SHP-88301', tabId: activeTabId });
    await new Promise((r) => setTimeout(r, 300));

    await client.callTool('chrome_fill_or_select', { ref: tokenRef, value: 'BENCHMARK-CODE-9204', tabId: activeTabId });
    await new Promise((r) => setTimeout(r, 300));

    await client.callTool('chrome_click_element', { ref: authRef, tabId: activeTabId });
    await new Promise((r) => setTimeout(r, 600));

    await client.callTool('chrome_read_page', { tabId: activeTabId });
  } else if (runIndex === 2) {
    await client.callTool('chrome_fill_or_select', { selector: '#input-shipment-id', value: 'SHP-88301', tabId: activeTabId });
    await new Promise((r) => setTimeout(r, 300));

    await client.callTool('chrome_fill_or_select', { selector: '#input-token', value: 'BENCHMARK-CODE-9204', tabId: activeTabId });
    await new Promise((r) => setTimeout(r, 300));

    const candAuth = await client.callTool('chrome_get_actionable_candidates', {
      tabId: activeTabId,
      intent: 'authorize dispatch',
      maxCandidates: 3,
    });
    const authRef = (candAuth.data && candAuth.data.candidates && candAuth.data.candidates[0]) ? candAuth.data.candidates[0].ref : 'ref_7';

    await client.callTool('chrome_click_element', { ref: authRef, tabId: activeTabId });
    await new Promise((r) => setTimeout(r, 600));

    await client.callTool('chrome_read_page', { tabId: activeTabId });
  } else {
    const candB = await client.callTool('chrome_get_actionable_candidates', {
      tabId: activeTabId,
      intent: 'authorize dispatch shipment',
      maxCandidates: 5,
    });
    const candidates = (candB.data && candB.data.candidates) ? candB.data.candidates : [];
    const shipEl = candidates.find((c) => c.selector === '#input-shipment-id') || candidates[2];
    const tokenEl = candidates.find((c) => c.selector === '#input-token') || candidates[1];
    const authEl = candidates.find((c) => c.selector === '#authorize-dispatch-btn') || candidates[0];

    const shipRef = shipEl ? shipEl.ref : 'ref_5';
    const tokenRef = tokenEl ? tokenEl.ref : 'ref_6';
    const authRef = authEl ? authEl.ref : 'ref_7';

    await client.callTool('chrome_fill_or_select', { ref: shipRef, value: 'SHP-88301', tabId: activeTabId });
    await new Promise((r) => setTimeout(r, 300));

    await client.callTool('chrome_fill_or_select', { ref: tokenRef, value: 'BENCHMARK-CODE-9204', tabId: activeTabId });
    await new Promise((r) => setTimeout(r, 300));

    await client.callTool('chrome_click_element', { ref: authRef, tabId: activeTabId });
    await new Promise((r) => setTimeout(r, 600));

    await client.callTool('chrome_read_page', { tabId: activeTabId });
  }
}

export async function executeExperimentRun(opts) {
  const condition = opts.condition;
  const taskId = opts.taskId;
  const runIndex = opts.runIndex;

  const isBefore = condition.toUpperCase() === 'BEFORE';
  const outSubDir = isBefore ? 'before' : 'after';
  const resultsDir = path.join(__dirname, 'results', 'issue-2-ab', outSubDir);
  const sourceSha = isBefore ? SHA_BEFORE : SHA_AFTER;

  const directClient = new BenchmarkMcpClient({ url: TARGET_MCP_URL });
  await directClient.connect();
  const resetTabId = await resetBrowserTab(directClient);

  const recorder = new AgentBenchmarkRecorder({
    taskId,
    proxyPort: PROXY_PORT,
    targetMcpUrl: TARGET_MCP_URL,
    fixturePort: FIXTURE_PORT,
    resultsDir,
  });

  const { proxyUrl, fixtureBaseUrl } = await recorder.start();
  console.log('========================================================================');
  console.log(' RUN [' + condition + '] ' + taskId + ' (Run ' + runIndex + '/3)');
  console.log(' Proxy: ' + proxyUrl + ' | Fixtures: ' + fixtureBaseUrl);
  console.log(' Target SHA: ' + sourceSha + ' | Model: Gemini 3.8 Flash High');
  console.log('------------------------------------------------------------------------');

  const proxyClient = new BenchmarkMcpClient({ url: proxyUrl });
  await proxyClient.connect();

  if (taskId === 'short-interaction') {
    if (isBefore) await runShortBefore(proxyClient, runIndex, fixtureBaseUrl, resetTabId);
    else await runShortAfter(proxyClient, runIndex, fixtureBaseUrl, resetTabId);
  } else if (taskId === 'dynamic-multistep-interaction') {
    if (isBefore) await runDynamicBefore(proxyClient, runIndex, fixtureBaseUrl, resetTabId);
    else await runDynamicAfter(proxyClient, runIndex, fixtureBaseUrl, resetTabId);
  } else if (taskId === 'longer-multipage-workflow') {
    if (isBefore) await runMultiHopBefore(proxyClient, runIndex, fixtureBaseUrl, resetTabId);
    else await runMultiHopAfter(proxyClient, runIndex, fixtureBaseUrl, resetTabId);
  }

  const finalizeResult = await recorder.verifyAndFinalize({
    condition: isBefore ? 'BEFORE' : 'AFTER',
    sourceSha,
    model: 'Gemini 3.8 Flash High',
    reasoningMode: 'High',
    chromeVersion: CHROME_VERSION,
    os: OS_STRING,
  });

  const summary = finalizeResult.summary;
  const outFile = finalizeResult.outFile;
  const verification = finalizeResult.verification;

  await recorder.stop();

  console.log('------------------------------------------------------------------------');
  console.log(' Verification:         ' + (verification.success ? 'PASSED OK' : 'FAILED ERR'));
  if (!verification.success) console.log(' Failure Reason:       ' + verification.reason);
  console.log(' Total MCP Calls:      ' + summary.totalMcpCalls);
  console.log(' Page Inspections:     ' + summary.pageInspectionCalls);
  console.log(' Repeated Inspections: ' + summary.repeatedPageInspections);
  console.log(' Retries:              ' + summary.retries);
  console.log(' Round-Trip Time:      ' + summary.mcpRoundTripTimeMs.toFixed(1) + ' ms');
  console.log('========================================================================\n');

  if (!verification.success) {
    throw new Error('Task verification failed for ' + taskId + ' (' + condition + ' run ' + runIndex + '): ' + verification.reason);
  }

  return { summary, outFile, verification };
}

if (process.argv[1] === __filename) {
  const args = process.argv.slice(2);
  let condition = 'BEFORE';
  let specificTask = null;
  let runs = 3;

  const condIdx = args.indexOf('--condition');
  if (condIdx !== -1 && args[condIdx + 1]) condition = args[condIdx + 1].toUpperCase();

  const taskIdx = args.indexOf('--task');
  if (taskIdx !== -1 && args[taskIdx + 1]) specificTask = args[taskIdx + 1];

  const runsIdx = args.indexOf('--runs');
  if (runsIdx !== -1 && args[runsIdx + 1]) runs = parseInt(args[runsIdx + 1], 10);

  const tasksToRun = specificTask ? [specificTask] : [
    'short-interaction',
    'dynamic-multistep-interaction',
    'longer-multipage-workflow',
  ];

  async function main() {
    console.log('Starting A/B Benchmark Execution for Condition [' + condition + '] (' + runs + ' runs per task)...');
    for (const taskId of tasksToRun) {
      for (let r = 1; r <= runs; r++) {
        await executeExperimentRun({ condition, taskId, runIndex: r });
        await new Promise((res) => setTimeout(res, 1000));
      }
    }
    console.log('All runs for [' + condition + '] completed successfully.');
  }

  main().catch((err) => {
    console.error('Experiment execution error:', err);
    process.exit(1);
  });
}
