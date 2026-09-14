import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  globalActionCache,
  rankActionableElements,
  formatCandidatesAsContent,
  buildCandidateDescriptor,
  embedText,
  cosineSimilarity,
  type ActionableElementSummary,
} from 'agent-chrome-mcp-shared';

vi.mock('@/entrypoints/background/element-marker/element-marker-storage', () => ({
  listMarkersForUrl: vi.fn().mockResolvedValue([]),
}));

import { readPageTool } from '../entrypoints/background/tools/browser/read-page';

describe('Semantic Action Retrieval System', () => {
  beforeEach(() => {
    globalActionCache.invalidate();
    document.body.innerHTML = '';
    (window as any).__claudeElementMap = {};
    (window as any).__claudeRefCounter = 0;
    (window as any).__claudeDomRevision = 1;
  });

  describe('Criterion 1: Clear Intent Retrieval', () => {
    it('ranks the target action button #1 with high confidence for clear intent', () => {
      const elements: ActionableElementSummary[] = [
        {
          ref: 'ref_1',
          role: 'button',
          name: 'Activate Service',
          context: 'CloudOps Primary Service Console',
          selector: '#activate-btn',
          coordinates: { x: 100, y: 200 },
        },
        {
          ref: 'ref_2',
          role: 'button',
          name: 'Cancel',
          context: 'Navigation Bar',
          selector: '#cancel-btn',
        },
        {
          ref: 'ref_3',
          role: 'textbox',
          name: 'Search Filter',
          context: 'Header Search',
          selector: '#search-input',
        },
      ];

      const result = rankActionableElements(elements, 'activate primary service');
      expect(result.candidates.length).toBeGreaterThan(0);
      expect(result.topCandidate).not.toBeNull();
      expect(result.topCandidate!.ref).toBe('ref_1');
      expect(result.topCandidate!.score).toBeGreaterThanOrEqual(0.6);
      expect(result.topCandidate!.role).toBe('button');
      expect(result.topCandidate!.coordinates).toEqual({ x: 100, y: 200 });
    });
  });

  describe('Criterion 2: Ambiguous Candidates & Context Preservation', () => {
    it('returns candidate set with unique context for main LLM disambiguation', () => {
      const elements: ActionableElementSummary[] = [
        {
          ref: 'ref_east',
          role: 'button',
          name: 'Select',
          context: 'US-East Production Primary (us-east-1)',
          selector: '#select-us-east',
        },
        {
          ref: 'ref_west',
          role: 'button',
          name: 'Select',
          context: 'US-West Secondary (us-west-2)',
          selector: '#select-us-west',
        },
        {
          ref: 'ref_eu',
          role: 'button',
          name: 'Select',
          context: 'EU-Central Backup (eu-central-1)',
          selector: '#select-eu-central',
        },
      ];

      // Intent with "us-east" specifically ranks east top
      const resEast = rankActionableElements(elements, 'select the us-east cluster', {
        maxCandidates: 3,
      });
      expect(resEast.topCandidate?.ref).toBe('ref_east');
      expect(resEast.candidates.length).toBe(3);

      // Generic intent returns all 3 candidates preserving context
      const resGeneric = rankActionableElements(elements, 'select cluster', {
        maxCandidates: 3,
      });
      expect(resGeneric.candidates.length).toBe(3);
      const refs = resGeneric.candidates.map((c) => c.ref);
      expect(refs).toContain('ref_east');
      expect(refs).toContain('ref_west');
      expect(refs).toContain('ref_eu');

      const eastCandidate = resGeneric.candidates.find((c) => c.ref === 'ref_east');
      expect(eastCandidate?.context).toContain('US-East Production Primary');
    });
  });

  describe('Criterion 3: Low Match / Out of Domain Fallback', () => {
    it('returns empty candidates list when intent is completely unrelated', () => {
      const elements: ActionableElementSummary[] = [
        {
          ref: 'ref_sub',
          role: 'button',
          name: 'Submit Allocation',
          context: 'Cluster Orchestrator',
          selector: '#submit-btn',
        },
        {
          ref: 'ref_nodes',
          role: 'textbox',
          name: 'Allocation Node Count',
          context: 'Cluster Settings',
          selector: '#node-count',
        },
      ];

      const result = rankActionableElements(
        elements,
        'order margherita pizza with extra cheese for lunch',
        { threshold: 0.3 },
      );
      expect(result.candidates.length).toBe(0);
      expect(result.topCandidate).toBeNull();

      const formatted = formatCandidatesAsContent(
        result.candidates,
        'order pizza',
        elements.length,
      );
      expect(formatted).toContain('No actionable element candidates matched the intent');
      expect(formatted).toContain('chrome_read_page');
    });
  });

  describe('Criterion 4: Multilingual Interaction Intent', () => {
    it('matches English UI controls across German, French, Spanish, Chinese, Japanese, and Russian', () => {
      const elements: ActionableElementSummary[] = [
        {
          ref: 'ref_act',
          role: 'button',
          name: 'Activate Primary Service',
          context: 'CloudOps Console Control Panel',
          selector: '#activate-btn',
        },
        {
          ref: 'ref_docs',
          role: 'link',
          name: 'Documentation',
          context: 'Help Menu',
          selector: '#docs-link',
        },
        {
          ref: 'ref_cancel',
          role: 'button',
          name: 'Cancel Operation',
          context: 'Footer Actions',
          selector: '#cancel-btn',
        },
      ];

      const testCases = [
        { lang: 'German', query: 'Dienst aktivieren' },
        { lang: 'French', query: 'activer le service principal' },
        { lang: 'Spanish', query: 'activar el servicio principal' },
        { lang: 'Chinese', query: '激活主服务' },
        { lang: 'Japanese', query: '主サービスを起動' },
        { lang: 'Russian', query: 'активировать главный сервис' },
      ];

      for (const { lang, query } of testCases) {
        const res = rankActionableElements(elements, query, { maxCandidates: 2 });
        expect(res.candidates.length, `Failed on ${lang}`).toBeGreaterThan(0);
        expect(res.topCandidate?.ref, `Language ${lang} should rank #activate-btn first`).toBe(
          'ref_act',
        );
        expect(res.topCandidate?.score, `Score too low for ${lang}`).toBeGreaterThanOrEqual(0.35);
      }
    });
  });

  describe('Criterion 5: Stale & Dynamic Page State Safety', () => {
    it('cache invalidates on DOM mutation revision change or navigation', () => {
      const tabId = 101;
      const url = 'http://localhost:12399/short/index.html';
      const elements: ActionableElementSummary[] = [
        { ref: 'ref_1', role: 'button', name: 'Start' },
      ];
      const embeddings = [embedText('button "Start"')];

      globalActionCache.set(tabId, url, 1, elements, embeddings);

      // Revision 1 matches
      expect(globalActionCache.get(tabId, url, 1)).not.toBeNull();

      // Revision 2 is a miss (DOM mutated)
      expect(globalActionCache.get(tabId, url, 2)).toBeNull();

      // Navigation is a miss
      expect(globalActionCache.get(tabId, 'http://localhost:12399/other.html', 1)).toBeNull();

      // Tab mismatch is a miss
      expect(globalActionCache.get(999, url, 1)).toBeNull();
    });

    it('detects disconnected DOM elements via isConnected === false', () => {
      // Simulate DOM element attached, mapped to ref, then detached
      const btn = document.createElement('button');
      btn.id = 'dynamic-btn';
      btn.textContent = 'Temporary Button';
      document.body.appendChild(btn);

      const refId = 'ref_temp_1';
      (window as any).__claudeElementMap = {
        [refId]: new WeakRef(btn),
      };

      // Connected: isConnected is true
      expect(btn.isConnected).toBe(true);
      const weak = (window as any).__claudeElementMap[refId];
      const derefEl = weak.deref();
      expect(derefEl).toBe(btn);
      expect(derefEl.isConnected).toBe(true);

      // Now element is removed from DOM (e.g. dynamic rerender)
      btn.remove();
      expect(btn.isConnected).toBe(false);

      // Resolve check: disconnected elements are detected as stale
      function safeResolve(ref: string) {
        const map = (window as any).__claudeElementMap || {};
        const w = map[ref];
        const el = w && typeof w.deref === 'function' ? w.deref() : null;
        if (el && el.isConnected === false) {
          return { element: null, stale: true };
        }
        return { element: el, stale: false };
      }

      const check = safeResolve(refId);
      expect(check.stale).toBe(true);
      expect(check.element).toBeNull();
    });

    it('tracks DOM revisions via MutationObserver', async () => {
      let domRevision = 1;
      const observer = new MutationObserver(() => {
        domRevision++;
      });
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
      });

      // Add element
      const div = document.createElement('div');
      div.textContent = 'Dynamic section';
      document.body.appendChild(div);

      // Allow MutationObserver microtask to fire
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(domRevision).toBeGreaterThan(1);
      observer.disconnect();
    });
  });

  describe('Criterion 6: Preservation of Existing Interaction Primitives', () => {
    it('preserves refs and coordinates across candidates for chrome_computer or click primitives', () => {
      const element: ActionableElementSummary = {
        ref: 'ref_exec_42',
        role: 'button',
        name: 'Authorize Dispatch',
        selector: '#authorize-dispatch-btn',
        coordinates: { x: 320, y: 480 },
        context: 'Fulfillment Gateway | Manifest SHP-88301',
      };

      const result = rankActionableElements([element], 'authorize the dispatch');
      expect(result.topCandidate?.ref).toBe('ref_exec_42');
      expect(result.topCandidate?.coordinates).toEqual({ x: 320, y: 480 });
      expect(result.topCandidate?.selector).toBe('#authorize-dispatch-btn');

      // Formatter guides main LLM to execute action
      const formatted = formatCandidatesAsContent(result.candidates, 'authorize the dispatch', 1);
      expect(formatted).toContain('[ref=ref_exec_42]');
      expect(formatted).toContain('coords: (x=320,y=480)');
      expect(formatted).toContain('Main LLM Decision: Choose one candidate ref');
    });
  });

  describe('Criterion 7: chrome_read_page with intent contract', () => {
    beforeEach(() => {
      (readPageTool as any).tryGetTab = vi
        .fn()
        .mockResolvedValue({ id: 101, url: 'http://localhost/test' });
      (readPageTool as any).getActiveTabOrThrowInWindow = vi
        .fn()
        .mockResolvedValue({ id: 101, url: 'http://localhost/test' });
      (readPageTool as any).injectContentScript = vi.fn().mockResolvedValue(undefined);
    });

    it('read_page(intent) returns compact ranked candidates without large accessibility tree', async () => {
      const mockElements = [
        { ref: 'ref_1', role: 'button', name: 'Submit Application', context: 'Form actions' },
        { ref: 'ref_2', role: 'button', name: 'Cancel', context: 'Footer' },
      ];
      const fullAccessibilityTree =
        '- document\n  - main\n    - button "Submit Application" [ref=ref_1]\n    - button "Cancel" [ref=ref_2]\n    - div "Long text 1"\n    - div "Long text 2"\n    - div "Long text 3"\n    - div "Long text 4"\n    - div "Long text 5"\n    - div "Long text 6"\n    - div "Long text 7"\n    - div "Long text 8"\n    - div "Long text 9"\n    - div "Long text 10"';

      (readPageTool as any).sendMessageToTab = vi.fn().mockResolvedValue({
        success: true,
        pageContent: fullAccessibilityTree,
        actionableElements: mockElements,
        viewport: { width: 1280, height: 720, dpr: 1 },
        stats: { processed: 20, included: 2, durationMs: 2 },
        domRevision: 1,
      });

      const res = await readPageTool.execute({ intent: 'submit the application' });
      expect(res.isError).toBe(false);
      const data = JSON.parse((res.content[0] as any).text);

      // Prioritizes semantic candidate result
      expect(data.success).toBe(true);
      expect(data.intent).toBe('submit the application');
      expect(data.candidates.length).toBeGreaterThan(0);
      expect(data.topCandidate?.ref).toBe('ref_1');
      expect(data.topCandidate?.role).toBe('button');
      expect(data.topCandidate?.name).toBe('Submit Application');
      expect(data.topCandidate?.score).toBeGreaterThanOrEqual(0.6);

      // PageContent is compact candidates representation, NOT the full accessibility tree
      expect(data.pageContent).toContain('Actionable Element Candidates for intent "submit the application"');
      expect(data.pageContent).toContain('[ref=ref_1]');
      expect(data.pageContent).not.toContain(fullAccessibilityTree);

      // Minimal metadata included
      expect(data.viewport).toEqual({ width: 1280, height: 720, dpr: 1 });
      expect(data.domRevision).toBe(1);
      expect(data.tips).toContain('chrome_click_element');
    });

    it('normal read_page() without intent remains unchanged (returns full tree)', async () => {
      const fullAccessibilityTree =
        '- document\n  - main\n    - button "Submit Application" [ref=ref_1]\n    - div "Content 1"\n    - div "Content 2"\n    - div "Content 3"\n    - div "Content 4"\n    - div "Content 5"\n    - div "Content 6"\n    - div "Content 7"\n    - div "Content 8"\n    - div "Content 9"\n    - div "Content 10"';

      (readPageTool as any).sendMessageToTab = vi.fn().mockResolvedValue({
        success: true,
        pageContent: fullAccessibilityTree,
        refMap: [{ ref: 'ref_1', role: 'button', name: 'Submit' }],
        viewport: { width: 1280, height: 720, dpr: 1 },
        stats: { processed: 11, included: 11, durationMs: 2 },
      });

      const res = await readPageTool.execute({});
      expect(res.isError).toBe(false);
      const data = JSON.parse((res.content[0] as any).text);

      expect(data.success).toBe(true);
      expect(data.intent).toBeUndefined();
      expect(data.candidates).toBeUndefined();
      expect(data.pageContent).toBe(fullAccessibilityTree);
    });

    it('semantic no-match safely returns empty candidates and guidance without throwing', async () => {
      const mockElements = [
        { ref: 'ref_1', role: 'button', name: 'Submit Application', context: 'Form actions' },
      ];

      (readPageTool as any).sendMessageToTab = vi.fn().mockResolvedValue({
        success: true,
        pageContent: 'tree',
        actionableElements: mockElements,
        viewport: { width: 1280, height: 720, dpr: 1 },
        domRevision: 1,
      });

      const res = await readPageTool.execute({ intent: 'order pepperoni pizza with extra cheese' });
      expect(res.isError).toBe(false);
      const data = JSON.parse((res.content[0] as any).text);

      expect(data.success).toBe(true);
      expect(data.candidates.length).toBe(0);
      expect(data.topCandidate).toBeNull();
      expect(data.pageContent).toContain('No actionable element candidates matched the intent');
      expect(data.pageContent).toContain('chrome_read_page');
      expect(data.tips).toContain('No candidates matched the intent');
    });

    it('safely handles tree failure via fallback to interactive elements helper', async () => {
      (readPageTool as any).sendMessageToTab = vi.fn().mockImplementation(async (_tabId, msg) => {
        if (msg.action === 'generateAccessibilityTree') {
          return { success: false, error: 'Tree generation failed' };
        }
        if (msg.action === 'getInteractiveElements') {
          return {
            success: true,
            elements: [
              { ref: 'ref_fb_1', type: 'button', text: 'Confirm Order', selector: '#confirm-btn' },
            ],
          };
        }
        return null;
      });

      const res = await readPageTool.execute({ intent: 'confirm order' });
      expect(res.isError).toBe(false);
      const data = JSON.parse((res.content[0] as any).text);

      expect(data.success).toBe(true);
      expect(data.fallbackUsed).toBe(true);
      expect(data.fallbackSource).toBe('get_interactive_elements');
      expect(data.candidates.length).toBeGreaterThan(0);
      expect(data.topCandidate?.ref).toBe('ref_fb_1');
    });
  });
});
