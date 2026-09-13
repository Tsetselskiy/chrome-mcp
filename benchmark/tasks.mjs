/**
 * Agent / Task-Level Benchmark Definitions (Issue #1)
 *
 * Defines standardized, reproducible task specifications for evaluating LLM agents
 * against Chrome MCP without hardcoded tool sequences.
 *
 * In this benchmark layer, the agent receives ONLY the task goal and prompt,
 * and autonomously decides which MCP tools to call.
 */

export const AGENT_BENCHMARK_TASKS = [
  {
    id: 'short-interaction',
    name: 'Short Interaction: Service Activation',
    category: 'short-interaction',
    startUrlPath: '/short/index.html',
    prompt:
      'Navigate to the CloudOps Console at http://localhost:12399/short/index.html and activate the primary service. Confirm that the status changes to ACTIVE.',
    successCriteria: [
      'The primary service activation button (#activate-btn) is clicked.',
      'Status badge (#status-badge) displays "ACTIVE".',
      'System message (#system-message) confirms "Service Activated Successfully".',
    ],
    async verify(client, options = {}) {
      const { tabId } = options;
      // Query DOM state using read_page or direct JS query
      const readRes = await client.callTool('chrome_read_page', { tabId, depth: 8 });
      if (!readRes.ok) {
        return { success: false, reason: `Page read verification failed: ${readRes.error}` };
      }
      const rawText = readRes.raw || JSON.stringify(readRes.data || {});
      const activeFound = (/\bACTIVE\b/).test(rawText) || rawText.includes('Service Activated');
      return {
        success: activeFound,
        reason: activeFound ? null : 'Page content does not show ACTIVE status badge',
      };
    },
  },
  {
    id: 'dynamic-multistep-interaction',
    name: 'Dynamic Multi-Step Interaction: Cluster Allocation',
    category: 'dynamic-multistep',
    startUrlPath: '/dynamic/index.html',
    prompt:
      'Navigate to the Cluster Orchestrator at http://localhost:12399/dynamic/index.html. Search for cluster "us-east", select the "US-East Production Primary" cluster from the dynamically filtered results, set the allocation node count to 8, and submit the allocation. Confirm that allocation reference ALLOC-8891 is displayed.',
    successCriteria: [
      'Filter input (#filter-query) is filled with "us-east".',
      'Dynamic selection button for US-East (#select-btn-us-east-prod) is clicked.',
      'Node count input (#node-count) is set to 8.',
      'Allocation form is submitted (#submit-allocation-btn clicked).',
      'Success alert (#success-alert) displays reference ID "ALLOC-8891".',
    ],
    async verify(client, options = {}) {
      const { tabId } = options;
      const readRes = await client.callTool('chrome_read_page', { tabId, depth: 8 });
      if (!readRes.ok) {
        return { success: false, reason: `Page read verification failed: ${readRes.error}` };
      }
      const rawText = readRes.raw || JSON.stringify(readRes.data || {});
      const allocFound = rawText.includes('ALLOC-8891') || rawText.includes('Allocation confirmed');
      return {
        success: allocFound,
        reason: allocFound ? null : 'Page content does not show ALLOC-8891 confirmation',
      };
    },
  },
  {
    id: 'longer-multipage-workflow',
    name: 'Longer Multi-Page Workflow: Dispatch & Gateway Authorization',
    category: 'longer-multipage',
    startUrlPath: '/multihop/site-a.html',
    prompt:
      'Navigate to the Origin Hub dispatch manifest at http://localhost:12399/multihop/site-a.html. Find the transfer auth token and shipment ID. Then proceed to the Fulfillment Gateway at http://localhost:12399/multihop/site-b.html, enter both the shipment ID and transfer auth token into the authorization form, and authorize the dispatch. Confirm that authorization code DISPATCHED-OK-2026 is displayed.',
    successCriteria: [
      'Navigated to Origin Hub (Site A) and extracted transfer token (BENCHMARK-CODE-9204) and shipment ID (SHP-88301).',
      'Cross-navigated to Fulfillment Gateway (Site B).',
      'Filled shipment ID into #input-shipment-id.',
      'Filled transfer auth token into #input-token.',
      'Submitted authorization form (#authorize-dispatch-btn clicked).',
      'Fulfillment Gateway confirms dispatch with code "DISPATCHED-OK-2026".',
    ],
    async verify(client, options = {}) {
      const { tabId } = options;
      const readRes = await client.callTool('chrome_read_page', { tabId, depth: 8 });
      if (!readRes.ok) {
        return { success: false, reason: `Page read verification failed: ${readRes.error}` };
      }
      const rawText = readRes.raw || JSON.stringify(readRes.data || {});
      const codeFound = rawText.includes('DISPATCHED-OK-2026') || rawText.includes('Dispatched successfully');
      return {
        success: codeFound,
        reason: codeFound ? null : 'Site B does not show DISPATCHED-OK-2026 confirmation',
      };
    },
  },
];

export function getTaskById(taskId) {
  return AGENT_BENCHMARK_TASKS.find((t) => t.id === taskId || t.category === taskId);
}
