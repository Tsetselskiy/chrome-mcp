/**
 * Scenario 1: Short Navigation & Interaction
 *
 * Representative of quick browser lookup and single-action tasks:
 * 1. Navigate to target URL (focus tab)
 * 2. Inspect page contents (chrome_read_page)
 * 3. Locate and click activation button (chrome_click_element)
 * 4. Verify exact activated state via follow-up inspection
 */

export async function runShortScenario(client, collector, options = {}) {
  collector.scenarioName = 'short-navigation-interaction';
  collector.metadata = {
    category: 'short',
    description: 'Short navigation to single page with state-toggle click and verification',
  };

  const fixtureUrl = `${options.fixtureBaseUrl || 'http://localhost:12399'}/short/index.html`;

  try {
    const navRes = await client.callTool('chrome_navigate', {
      url: fixtureUrl,
      background: false,
    });
    if (!navRes.ok) {
      return collector.finish(false, `Navigation failed: ${navRes.error}`);
    }

    const tabId = navRes.data?.tabId;
    await new Promise((resolve) => setTimeout(resolve, 150));

    const inspect1 = await client.callTool('chrome_read_page', { tabId, depth: 8 });
    if (!inspect1.ok) {
      return collector.finish(false, `Initial page read failed: ${inspect1.error}`);
    }

    const clickRes = await client.callTool('chrome_click_element', {
      selector: '#activate-btn',
      tabId,
    });
    if (!clickRes.ok) {
      return collector.finish(false, `Click failed: ${clickRes.error}`);
    }

    const inspect2 = await client.callTool('chrome_read_page', { tabId, depth: 8 });
    if (!inspect2.ok) {
      return collector.finish(false, `Verification page read failed: ${inspect2.error}`);
    }

    const inspectText = inspect2.raw || (inspect2.data ? JSON.stringify(inspect2.data) : '');
    const hasExactActiveStatus = /Current Operational Status:\s*ACTIVE\b/.test(inspectText);
    const hasSuccessMessage = inspectText.includes('Service Activated Successfully');

    if (!hasExactActiveStatus || !hasSuccessMessage) {
      return collector.finish(
        false,
        'Verification failed: expected exact ACTIVE status and activation confirmation',
      );
    }

    return collector.finish(true);
  } catch (err) {
    return collector.finish(false, `Unexpected error: ${err.message}`);
  }
}
