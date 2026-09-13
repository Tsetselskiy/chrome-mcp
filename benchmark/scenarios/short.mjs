/**
 * Scenario 1: Short Navigation & Interaction
 *
 * Representative of quick browser lookup and single-action tasks:
 * 1. Navigate to target URL (focus tab)
 * 2. Inspect page contents (chrome_read_page)
 * 3. Locate and click activation button (chrome_click_element)
 * 4. Verify status change via follow-up inspection (chrome_read_page)
 */

export async function runShortScenario(client, collector, options = {}) {
  collector.scenarioName = 'short-navigation-interaction';
  collector.metadata = {
    category: 'short',
    description: 'Short navigation to single page with state-toggle click and verification',
  };

  const fixtureUrl = `${options.fixtureBaseUrl || 'http://localhost:12399'}/short/index.html`;

  try {
    // 1. Navigate to page (foreground tab)
    const navRes = await client.callTool('chrome_navigate', {
      url: fixtureUrl,
      background: false,
    });
    if (!navRes.ok) {
      return collector.finish(false, `Navigation failed: ${navRes.error}`);
    }

    const tabId = navRes.data?.tabId;

    // Small delay to allow initial DOM rendering
    await new Promise((resolve) => setTimeout(resolve, 150));

    // 2. First inspection to discover DOM elements
    const inspect1 = await client.callTool('chrome_read_page', { tabId, depth: 8 });
    if (!inspect1.ok) {
      return collector.finish(false, `Initial page read failed: ${inspect1.error}`);
    }

    // 3. Click the activation button
    const clickRes = await client.callTool('chrome_click_element', {
      selector: '#activate-btn',
      tabId,
    });
    if (!clickRes.ok) {
      return collector.finish(false, `Click failed: ${clickRes.error}`);
    }

    // 4. Follow-up inspection to verify state update
    const inspect2 = await client.callTool('chrome_read_page', { tabId, depth: 8 });
    const inspectText = inspect2.raw || (inspect2.data ? JSON.stringify(inspect2.data) : '');

    const succeeded = inspectText.includes('ACTIVE') || inspectText.includes('Service Activated');
    if (!succeeded) {
      return collector.finish(false, `Verification failed: expected ACTIVE status in page content`);
    }

    return collector.finish(true);
  } catch (err) {
    return collector.finish(false, `Unexpected error: ${err.message}`);
  }
}
