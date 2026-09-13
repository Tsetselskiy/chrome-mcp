/**
 * Scenario 2: Dynamic Multi-Step Interaction
 *
 * Representative of complex, stateful web applications:
 * 1. Navigate to dynamic interactive console
 * 2. Initial page inspection
 * 3. Fill query input with search filter (chrome_fill_or_select)
 * 4. Wait for dynamic element rendering with retry/poll tracking
 * 5. Select filtered item (chrome_click_element)
 * 6. Inspect revealed sub-form
 * 7. Fill allocation options (chrome_fill_or_select)
 * 8. Submit form (chrome_click_element)
 * 9. Inspect final confirmation message (chrome_read_page)
 */

export async function runDynamicScenario(client, collector, options = {}) {
  collector.scenarioName = 'dynamic-multistep-interaction';
  collector.metadata = {
    category: 'dynamic',
    description: 'Dynamic search/filter, asynchronous item selection, form submission and confirmation',
  };

  const fixtureUrl = `${options.fixtureBaseUrl || 'http://localhost:12399'}/dynamic/index.html`;

  try {
    // 1. Navigate (foreground)
    const navRes = await client.callTool('chrome_navigate', {
      url: fixtureUrl,
      background: false,
    });
    if (!navRes.ok) {
      return collector.finish(false, `Navigation failed: ${navRes.error}`);
    }

    const tabId = navRes.data?.tabId;
    await new Promise((resolve) => setTimeout(resolve, 150));

    // 2. Initial inspection
    const inspect1 = await client.callTool('chrome_read_page', { tabId, depth: 8 });
    if (!inspect1.ok) {
      return collector.finish(false, `Page read failed: ${inspect1.error}`);
    }

    // 3. Fill search filter
    const fillRes1 = await client.callTool('chrome_fill_or_select', {
      selector: '#filter-query',
      value: 'us-east',
      tabId,
    });
    if (!fillRes1.ok) {
      return collector.finish(false, `Fill filter failed: ${fillRes1.error}`);
    }

    // 4. Poll / re-inspect until dynamic DOM update settles (simulate realistic agent check)
    let selectedBtnFound = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      const inspectDynamic = await client.callTool('chrome_read_page', { tabId, depth: 8 });
      const text = inspectDynamic.raw || JSON.stringify(inspectDynamic.data || {});
      if (text.includes('select-btn-us-east-prod') || text.includes('US-East Production Primary')) {
        selectedBtnFound = true;
        break;
      }
      collector.recordRetry(`Waiting for dynamic cluster filter to render (attempt ${attempt + 1})`);
    }

    if (!selectedBtnFound) {
      return collector.finish(false, 'Dynamic cluster selection button did not render');
    }

    // 5. Select the cluster
    const clickSelectRes = await client.callTool('chrome_click_element', {
      selector: '#select-btn-us-east-prod',
      tabId,
    });
    if (!clickSelectRes.ok) {
      return collector.finish(false, `Click select button failed: ${clickSelectRes.error}`);
    }

    // 6. Inspect revealed sub-form
    const inspectForm = await client.callTool('chrome_read_page', { tabId, depth: 8 });
    if (!inspectForm.ok) {
      return collector.finish(false, `Form read failed: ${inspectForm.error}`);
    }

    // 7. Fill node count
    const fillNodesRes = await client.callTool('chrome_fill_or_select', {
      selector: '#node-count',
      value: 8,
      tabId,
    });
    if (!fillNodesRes.ok) {
      return collector.finish(false, `Fill node count failed: ${fillNodesRes.error}`);
    }

    // 8. Submit allocation
    const clickSubmitRes = await client.callTool('chrome_click_element', {
      selector: '#submit-allocation-btn',
      tabId,
    });
    if (!clickSubmitRes.ok) {
      return collector.finish(false, `Click submit failed: ${clickSubmitRes.error}`);
    }

    // 9. Inspect final confirmation
    const inspectFinal = await client.callTool('chrome_read_page', { tabId, depth: 8 });
    const finalText = inspectFinal.raw || JSON.stringify(inspectFinal.data || {});

    const succeeded = finalText.includes('ALLOC-8891') || finalText.includes('Allocation confirmed');
    if (!succeeded) {
      return collector.finish(false, 'Final confirmation ALLOC-8891 not found in page');
    }

    return collector.finish(true);
  } catch (err) {
    return collector.finish(false, `Unexpected error: ${err.message}`);
  }
}
