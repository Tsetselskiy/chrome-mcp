/**
 * Scenario 3: Long Multi-Step Multi-Page Workflow
 *
 * Representative of cross-application or multi-step pipeline tasks:
 * 1. Navigate to Site A (origin manifest portal)
 * 2. Inspect Site A contents (chrome_read_page)
 * 3. Extract token and shipment ID using low-level JavaScript
 * 4. Navigate to Site B
 * 5. Inspect Site B form inputs
 * 6. Fill shipment ID and token
 * 7. Submit dispatch authorization
 * 8. Inspect final confirmation message
 */

function decodeExtractionResult(response) {
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

  if (!value || typeof value !== 'object') return null;
  const token = typeof value.token === 'string' ? value.token.trim() : '';
  const shipmentId = typeof value.shipmentId === 'string' ? value.shipmentId.trim() : '';
  return token && shipmentId ? { token, shipmentId } : null;
}

export async function runMultiHopScenario(client, collector, options = {}) {
  collector.scenarioName = 'long-multihop-multipage-workflow';
  collector.metadata = {
    category: 'long-multihop',
    description: 'Multi-page workflow with navigation, JS data extraction, and form submission',
  };

  const baseUrl = options.fixtureBaseUrl || 'http://localhost:12399';
  const siteAUrl = `${baseUrl}/multihop/site-a.html`;
  const siteBUrl = `${baseUrl}/multihop/site-b.html`;

  try {
    const navA = await client.callTool('chrome_navigate', {
      url: siteAUrl,
      background: false,
    });
    if (!navA.ok) {
      return collector.finish(false, `Site A navigation failed: ${navA.error}`);
    }

    const tabId = navA.data?.tabId;
    await new Promise((resolve) => setTimeout(resolve, 150));

    const inspectA = await client.callTool('chrome_read_page', { tabId, depth: 8 });
    if (!inspectA.ok) {
      return collector.finish(false, `Site A page read failed: ${inspectA.error}`);
    }

    const extractJs = await client.callTool('chrome_javascript', {
      code: `({
        token: document.getElementById('transfer-token')?.textContent?.trim() || '',
        shipmentId: document.getElementById('shipment-id')?.textContent?.trim() || ''
      })`,
      tabId,
    });

    if (!extractJs.ok) {
      return collector.finish(false, `Manifest extraction failed: ${extractJs.error}`);
    }

    const extracted = decodeExtractionResult(extractJs);
    if (!extracted) {
      return collector.finish(false, 'Manifest extraction returned missing or unparseable values');
    }

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

    const inspectB = await client.callTool('chrome_read_page', { tabId: activeTabId, depth: 8 });
    if (!inspectB.ok) {
      return collector.finish(false, `Site B page read failed: ${inspectB.error}`);
    }

    const fillShipment = await client.callTool('chrome_fill_or_select', {
      selector: '#input-shipment-id',
      value: extracted.shipmentId,
      tabId: activeTabId,
    });
    if (!fillShipment.ok) {
      return collector.finish(false, `Site B shipment input fill failed: ${fillShipment.error}`);
    }

    const fillToken = await client.callTool('chrome_fill_or_select', {
      selector: '#input-token',
      value: extracted.token,
      tabId: activeTabId,
    });
    if (!fillToken.ok) {
      return collector.finish(false, `Site B token input fill failed: ${fillToken.error}`);
    }

    const clickAuth = await client.callTool('chrome_click_element', {
      selector: '#authorize-dispatch-btn',
      tabId: activeTabId,
    });
    if (!clickAuth.ok) {
      return collector.finish(false, `Site B authorization click failed: ${clickAuth.error}`);
    }

    const inspectFinal = await client.callTool('chrome_read_page', {
      tabId: activeTabId,
      depth: 8,
    });
    if (!inspectFinal.ok) {
      return collector.finish(false, `Final verification read failed: ${inspectFinal.error}`);
    }

    const finalText = inspectFinal.raw || JSON.stringify(inspectFinal.data || {});
    const succeeded =
      finalText.includes('DISPATCHED-OK-2026') && finalText.includes('SHP-88301');
    if (!succeeded) {
      return collector.finish(false, 'Final dispatch confirmation was incomplete or incorrect');
    }

    return collector.finish(true);
  } catch (err) {
    return collector.finish(false, `Unexpected error: ${err.message}`);
  }
}
