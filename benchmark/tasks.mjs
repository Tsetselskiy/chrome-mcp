/**
 * Agent / Task-Level Benchmark Definitions (Issue #1)
 *
 * The agent receives only the task prompt. Verification runs separately after the
 * agent stops and is not included in the agent's measured MCP call trace.
 */

function decodeToolObject(response) {
  if (!response?.ok) return null;
  let value = response.data;

  for (let i = 0; i < 3; i++) {
    if (typeof value === 'string') {
      try {
        value = JSON.parse(value);
        continue;
      } catch {
        return null;
      }
    }
    if (value && typeof value === 'object' && value.result !== undefined) {
      value = value.result;
      continue;
    }
    break;
  }

  return value && typeof value === 'object' ? value : null;
}

async function inspectExactDomState(client, tabId, code) {
  if (tabId === undefined || tabId === null) {
    return { ok: false, reason: 'Cannot verify task: final tabId was not captured' };
  }

  const res = await client.callTool('chrome_javascript', { tabId, code });
  if (!res.ok) {
    return { ok: false, reason: `DOM verification failed: ${res.error}` };
  }

  const state = decodeToolObject(res);
  if (!state) {
    return { ok: false, reason: 'DOM verification returned an unparseable result' };
  }

  return { ok: true, state };
}

export const AGENT_BENCHMARK_TASKS = [
  {
    id: 'short-interaction',
    name: 'Short Interaction: Service Activation',
    category: 'short-interaction',
    startUrlPath: '/short/index.html',
    prompt:
      'Navigate to the CloudOps Console at http://localhost:12399/short/index.html and activate the primary service. Confirm that the status changes to ACTIVE.',
    successCriteria: [
      'Final page is /short/index.html.',
      'Status badge (#status-badge) is exactly "ACTIVE".',
      'System message (#system-message) is visible and exactly confirms activation.',
      'Activation button is disabled after the successful action.',
    ],
    async verify(client, options = {}) {
      const inspected = await inspectExactDomState(
        client,
        options.tabId,
        `(() => {
          const badge = document.getElementById('status-badge');
          const message = document.getElementById('system-message');
          const button = document.getElementById('activate-btn');
          return {
            pathname: location.pathname,
            status: badge?.textContent?.trim() || '',
            message: message?.textContent?.trim() || '',
            messageVisible: Boolean(message && getComputedStyle(message).display !== 'none'),
            buttonDisabled: Boolean(button?.disabled)
          };
        })()`,
      );
      if (!inspected.ok) return { success: false, reason: inspected.reason };

      const s = inspected.state;
      const success =
        s.pathname.endsWith('/short/index.html') &&
        s.status === 'ACTIVE' &&
        s.message === 'Service Activated Successfully' &&
        s.messageVisible === true &&
        s.buttonDisabled === true;

      return {
        success,
        reason: success ? null : `Unexpected final short-task state: ${JSON.stringify(s)}`,
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
      'Final page is /dynamic/index.html.',
      'Filter input is exactly "us-east".',
      'Selected and confirmed cluster is exactly "US-East Production Primary".',
      'Node count and confirmed node count are exactly 8.',
      'Success alert is visible and reference ID is exactly ALLOC-8891.',
    ],
    async verify(client, options = {}) {
      const inspected = await inspectExactDomState(
        client,
        options.tabId,
        `(() => {
          const success = document.getElementById('success-alert');
          const submit = document.getElementById('submit-allocation-btn');
          return {
            pathname: location.pathname,
            filter: document.getElementById('filter-query')?.value || '',
            selectedCluster: document.getElementById('selected-cluster-name')?.textContent?.trim() || '',
            nodeCount: document.getElementById('node-count')?.value || '',
            successVisible: Boolean(success && getComputedStyle(success).display !== 'none'),
            confirmedTarget: document.getElementById('confirmed-target')?.textContent?.trim() || '',
            confirmedNodes: document.getElementById('confirmed-nodes')?.textContent?.trim() || '',
            reference: document.getElementById('ref-code')?.textContent?.trim() || '',
            submitDisabled: Boolean(submit?.disabled)
          };
        })()`,
      );
      if (!inspected.ok) return { success: false, reason: inspected.reason };

      const s = inspected.state;
      const success =
        s.pathname.endsWith('/dynamic/index.html') &&
        s.filter === 'us-east' &&
        s.selectedCluster === 'US-East Production Primary' &&
        String(s.nodeCount) === '8' &&
        s.successVisible === true &&
        s.confirmedTarget === 'US-East Production Primary' &&
        String(s.confirmedNodes) === '8' &&
        s.reference === 'ALLOC-8891' &&
        s.submitDisabled === true;

      return {
        success,
        reason: success ? null : `Unexpected final dynamic-task state: ${JSON.stringify(s)}`,
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
      'Final page is /multihop/site-b.html.',
      'Shipment input is exactly SHP-88301.',
      'Transfer token input is exactly BENCHMARK-CODE-9204.',
      'Success banner is visible and error banner is hidden.',
      'Confirmed shipment and dispatch code are exact.',
    ],
    async verify(client, options = {}) {
      const inspected = await inspectExactDomState(
        client,
        options.tabId,
        `(() => {
          const success = document.getElementById('dispatch-success');
          const error = document.getElementById('dispatch-error');
          const button = document.getElementById('authorize-dispatch-btn');
          return {
            pathname: location.pathname,
            shipmentInput: document.getElementById('input-shipment-id')?.value?.trim() || '',
            tokenInput: document.getElementById('input-token')?.value?.trim() || '',
            successVisible: Boolean(success && getComputedStyle(success).display !== 'none'),
            errorVisible: Boolean(error && getComputedStyle(error).display !== 'none'),
            confirmedShipment: document.getElementById('res-shipment')?.textContent?.trim() || '',
            dispatchCode: document.getElementById('res-key')?.textContent?.trim() || '',
            buttonDisabled: Boolean(button?.disabled)
          };
        })()`,
      );
      if (!inspected.ok) return { success: false, reason: inspected.reason };

      const s = inspected.state;
      const success =
        s.pathname.endsWith('/multihop/site-b.html') &&
        s.shipmentInput === 'SHP-88301' &&
        s.tokenInput === 'BENCHMARK-CODE-9204' &&
        s.successVisible === true &&
        s.errorVisible === false &&
        s.confirmedShipment === 'SHP-88301' &&
        s.dispatchCode === 'DISPATCHED-OK-2026' &&
        s.buttonDisabled === true;

      return {
        success,
        reason: success ? null : `Unexpected final multi-page task state: ${JSON.stringify(s)}`,
      };
    },
  },
];

export function getTaskById(taskId) {
  return AGENT_BENCHMARK_TASKS.find((t) => t.id === taskId || t.category === taskId);
}
