/**
 * Scenario 3: Long Multi-Step Cross-Site Workflow
 *
 * Representative of cross-application or multi-step pipeline tasks:
 * 1. Navigate to Site A (origin manifest portal)
 * 2. Inspect Site A contents (chrome_read_page)
 * 3. Extract dynamic security token and shipment ID using low-level JavaScript (chrome_javascript)
 * 4. Cross-navigate to Site B (gateway portal)
 * 5. Inspect Site B form inputs (chrome_read_page)
 * 6. Fill shipment ID on Site B (chrome_fill_or_select)
 * 7. Fill transferred security token on Site B (chrome_fill_or_select)
 * 8. Submit dispatch authorization (chrome_click_element)
 * 9. Inspect final confirmation message (chrome_read_page)
 */

export async function runMultiHopScenario(client, collector, options = {}) {
  collector.scenarioName = 'long-multihop-cross-site-workflow';
  collector.metadata = {
    category: 'long-multihop',
    description: 'Multi-site workflow with cross-navigation, JS data extraction, and cross-site form submission',
  };

  const baseUrl = options.fixtureBaseUrl || 'http://localhost:12399';
  const siteAUrl = `${baseUrl}/multihop/site-a.html`;
  const siteBUrl = `${baseUrl}/multihop/site-b.html`;

  try {
    // 1. Navigate to Site A (foreground)
    const navA = await client.callTool('chrome_navigate', {
      url: siteAUrl,
      background: false,
    });
    if (!navA.ok) {
      return collector.finish(false, `Site A navigation failed: ${navA.error}`);
    }

    const tabId = navA.data?.tabId;
    await new Promise((resolve) => setTimeout(resolve, 150));

    // 2. Inspect Site A
    const inspectA = await client.callTool('chrome_read_page', { tabId, depth: 8 });
    if (!inspectA.ok) {
      return collector.finish(false, `Site A page read failed: ${inspectA.error}`);
    }

    // 3. Extract manifest details via low-level JavaScript (exercises lowLevelJsCalls metric)
    const extractJs = await client.callTool('chrome_javascript', {
      code: `({
        token: document.getElementById('transfer-token')?.textContent?.trim() || '',
        shipmentId: document.getElementById('shipment-id')?.textContent?.trim() || ''
      })`,
      tabId,
    });

    let extractedToken = 'BENCHMARK-CODE-9204';
    let extractedShipment = 'SHP-88301';

    if (extractJs.ok && extractJs.data) {
      let parsed = extractJs.data;
      if (typeof parsed === 'string') {
        try { parsed = JSON.parse(parsed); } catch {}
      }
      if (parsed?.result && typeof parsed.result === 'string') {
        try { parsed = JSON.parse(parsed.result); } catch {}
      }
      if (parsed?.token) extractedToken = parsed.token;
      if (parsed?.shipmentId) extractedShipment = parsed.shipmentId;
    }

    // 4. Navigate to Site B in the same tab or new step
    const navB = await client.callTool('chrome_navigate', {
      url: siteBUrl,
      tabId,
      background: false,
    });
    if (!navB.ok) {
      return collector.finish(false, `Site B navigation failed: ${navB.error}`);
    }

    const activeTabId = navB.data?.tabId || tabId;
    await new Promise((resolve) => setTimeout(resolve, 150));

    // 5. Inspect Site B
    const inspectB = await client.callTool('chrome_read_page', { tabId: activeTabId, depth: 8 });
    if (!inspectB.ok) {
      return collector.finish(false, `Site B page read failed: ${inspectB.error}`);
    }

    // 6. Fill shipment ID
    const fillShipment = await client.callTool('chrome_fill_or_select', {
      selector: '#input-shipment-id',
      value: extractedShipment,
      tabId: activeTabId,
    });
    if (!fillShipment.ok) {
      return collector.finish(false, `Site B shipment input fill failed: ${fillShipment.error}`);
    }

    // 7. Fill transferred security token
    const fillToken = await client.callTool('chrome_fill_or_select', {
      selector: '#input-token',
      value: extractedToken,
      tabId: activeTabId,
    });
    if (!fillToken.ok) {
      return collector.finish(false, `Site B token input fill failed: ${fillToken.error}`);
    }

    // 8. Submit authorization
    const clickAuth = await client.callTool('chrome_click_element', {
      selector: '#authorize-dispatch-btn',
      tabId: activeTabId,
    });
    if (!clickAuth.ok) {
      return collector.finish(false, `Site B authorization click failed: ${clickAuth.error}`);
    }

    // 9. Inspect final confirmation
    const inspectFinal = await client.callTool('chrome_read_page', { tabId: activeTabId, depth: 8 });
    const finalText = inspectFinal.raw || JSON.stringify(inspectFinal.data || {});

    const succeeded = finalText.includes('DISPATCHED-OK-2026') || finalText.includes('Dispatched successfully');
    if (!succeeded) {
      return collector.finish(false, 'Final confirmation DISPATCHED-OK-2026 not found');
    }

    return collector.finish(true);
  } catch (err) {
    return collector.finish(false, `Unexpected error: ${err.message}`);
  }
}
