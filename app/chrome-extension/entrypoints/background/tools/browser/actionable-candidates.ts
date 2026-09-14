import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import {
  TOOL_NAMES,
  globalActionCache,
  rankActionableElements,
  formatCandidatesAsContent,
  type ActionableCandidate,
} from 'agent-chrome-mcp-shared';
import { TOOL_MESSAGE_TYPES } from '@/common/message-types';
import { ERROR_MESSAGES } from '@/common/constants';

interface ActionableCandidatesParams {
  intent: string;
  maxCandidates?: number;
  tabId?: number;
  windowId?: number;
}

class ActionableCandidatesTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.GET_ACTIONABLE_CANDIDATES;

  async execute(args: ActionableCandidatesParams): Promise<ToolResult> {
    const { intent, maxCandidates } = args || {};

    if (!intent || typeof intent !== 'string' || !intent.trim()) {
      return createErrorResponse(
        `${ERROR_MESSAGES.INVALID_PARAMETERS}: intent is required and must be a non-empty string describing the target action`,
      );
    }

    const trimmedIntent = intent.trim();
    const candidateLimit =
      maxCandidates !== undefined && Number.isInteger(Number(maxCandidates)) && Number(maxCandidates) > 0
        ? Number(maxCandidates)
        : 5;

    try {
      const explicit = await this.tryGetTab(args?.tabId);
      const tab = explicit || (await this.getActiveTabOrThrowInWindow(args?.windowId));
      if (!tab.id) {
        return createErrorResponse(ERROR_MESSAGES.TAB_NOT_FOUND + ': Active tab has no ID');
      }

      const currentUrl = String(tab.url || '');

      // Inject helper in ISOLATED world
      await this.injectContentScript(
        tab.id,
        ['inject-scripts/accessibility-tree-helper.js'],
        false,
        'ISOLATED',
        true,
      );

      // Ask content script for actionable elements
      const resp = await this.sendMessageToTab(tab.id, {
        action: TOOL_MESSAGE_TYPES.GET_ACTIONABLE_ELEMENTS,
      });

      if (!resp || resp.success === false) {
        return createErrorResponse(
          resp?.error ||
            'Failed to retrieve actionable elements from page accessibility tree. Consider calling chrome_read_page or chrome_screenshot.',
        );
      }

      const elements = Array.isArray(resp?.actionableElements)
        ? resp.actionableElements
        : Array.isArray(resp?.refMap)
          ? resp.refMap
          : [];

      const domRevision = Number(resp?.domRevision || 1);

      // Check stable page state cache
      const cached = globalActionCache.get(tab.id, currentUrl, domRevision);
      let ranked: {
        candidates: ActionableCandidate[];
        topCandidate: ActionableCandidate | null;
        embeddings: Float32Array[];
      };

      if (cached && cached.elements && cached.embeddings) {
        ranked = rankActionableElements(cached.elements, trimmedIntent, {
          maxCandidates: candidateLimit,
          cachedEmbeddings: cached.embeddings,
        });
      } else {
        ranked = rankActionableElements(elements, trimmedIntent, {
          maxCandidates: candidateLimit,
        });
        globalActionCache.set(tab.id, currentUrl, domRevision, elements, ranked.embeddings);
      }

      const pageContent = formatCandidatesAsContent(
        ranked.candidates,
        trimmedIntent,
        elements.length,
      );

      const resultPayload = {
        success: true,
        intent: trimmedIntent,
        candidates: ranked.candidates,
        topCandidate: ranked.topCandidate,
        returnedCandidatesCount: ranked.candidates.length,
        totalActionableElements: elements.length,
        pageContent,
        isStale: false,
        domRevision,
        viewport: resp?.viewport || { width: null, height: null, dpr: null },
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(resultPayload) }],
        isError: false,
      };
    } catch (error) {
      console.error('Error in actionable candidates tool:', error);
      return createErrorResponse(
        `Failed to retrieve actionable candidates: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export const actionableCandidatesTool = new ActionableCandidatesTool();
