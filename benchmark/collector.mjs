/**
 * Benchmark Metrics Collector
 *
 * Records and analyzes interaction metrics for Chrome MCP benchmark scenarios:
 * - total MCP calls
 * - low-level JavaScript calls
 * - browser execution time (ms)
 * - repeated page inspections
 * - retries
 * - task success / failure
 */

export const INSPECTION_TOOL_NAMES = [
  'chrome_read_page',
  'chrome_get_web_content',
  'chrome_screenshot',
  'chrome_get_interactive_elements',
  'search_tabs_content',
  'chrome_console',
  'get_windows_and_tabs',
];

export const LOW_LEVEL_JS_TOOLS = [
  'chrome_javascript',
  'chrome_inject_script',
  'chrome_send_command_to_inject_script',
];

export const DOM_MUTATION_TOOLS = [
  'chrome_click_element',
  'chrome_fill_or_select',
  'chrome_keyboard',
  'chrome_handle_dialog',
  'chrome_upload_file',
  'chrome_navigate',
  'chrome_switch_tab',
  'chrome_tabs_create',
  'chrome_close_tabs',
  'chrome_tabs_adopt',
  'record_replay_flow_run',
];

export function isJsMutation(code) {
  if (typeof code !== 'string') return false;
  return /(?:\.click\s*\(|\.submit\s*\(|\.focus\s*\(|\.blur\s*\(|\.remove\s*\(|\.setValue|\.dispatchEvent\s*\(|\.setAttribute\s*\(|\.appendChild\s*\(|\.value\s*=|\.textContent\s*=|\.innerText\s*=|\.innerHTML\s*=|location\.href\s*=)/i.test(
    code,
  );
}

export function isJsInspectionQuery(code) {
  if (typeof code !== 'string') return false;
  const trimmed = code.trim();
  if (isJsMutation(trimmed)) return false;
  return /(?:querySelector|querySelectorAll|getElementById|getElementsBy|textContent|innerText|innerHTML|value|getAttribute|title|readyState|getComputedStyle|location\.href)/i.test(
    trimmed,
  );
}

export class BenchmarkMetricsCollector {
  constructor(scenarioName = 'unnamed-scenario', options = {}) {
    this.scenarioName = scenarioName;
    this.options = options;
    this.autoClassifyJsQueries = Boolean(options.autoClassifyJsQueries);
    this.events = [];
    this.retriesCount = 0;
    this.taskSuccess = false;
    this.failureReason = null;
    this.metadata = {};
    this.startTime = null;
    this.endTime = null;
  }

  start() {
    this.startTime = performance.now();
    return this;
  }

  recordCall(event) {
    const {
      name,
      args = {},
      durationMs = 0,
      isError = false,
      error = null,
      retried = false,
      resultMeta = {},
    } = event;

    const isLowLevelJs = LOW_LEVEL_JS_TOOLS.includes(name);

    let isInspection = false;
    if (typeof event.isInspection === 'boolean') {
      isInspection = event.isInspection;
    } else if (INSPECTION_TOOL_NAMES.includes(name)) {
      isInspection = true;
    } else if (name === 'chrome_computer' && ['screenshot', 'inquire'].includes(args?.action)) {
      isInspection = true;
    } else if (this.autoClassifyJsQueries && name === 'chrome_javascript' && isJsInspectionQuery(args?.code)) {
      isInspection = true;
    }

    let isMutation = false;
    if (typeof event.isMutation === 'boolean') {
      isMutation = event.isMutation;
    } else if (DOM_MUTATION_TOOLS.includes(name)) {
      isMutation = true;
    } else if (name === 'chrome_javascript' && isJsMutation(args?.code)) {
      isMutation = true;
    } else if (
      name === 'chrome_computer' &&
      [
        'click',
        'left_click',
        'right_click',
        'middle_click',
        'double_click',
        'triple_click',
        'mouse_down',
        'type',
        'key_down',
        'key',
        'hotkey',
        'drag_and_drop',
      ].includes(args?.action)
    ) {
      isMutation = true;
    }

    const callEvent = {
      index: this.events.length + 1,
      timestamp: new Date().toISOString(),
      name,
      argsSummary: this._summarizeArgs(name, args),
      durationMs: Math.round(durationMs * 100) / 100,
      isError,
      error: error ? String(error) : null,
      isLowLevelJs,
      isInspection,
      isMutation,
      retried,
      resultMeta,
    };

    this.events.push(callEvent);

    if (retried) {
      this.retriesCount++;
    }

    return callEvent;
  }

  recordRetry(reason = '') {
    this.retriesCount++;
    this.events.push({
      index: this.events.length + 1,
      timestamp: new Date().toISOString(),
      name: '__benchmark_retry__',
      reason,
      isRetryEvent: true,
      durationMs: 0,
    });
  }

  finish(success, reason = null) {
    this.endTime = performance.now();
    this.taskSuccess = Boolean(success);
    this.failureReason = reason;
    return this.getSummary();
  }

  getSummary() {
    const totalDurationMs = this.endTime && this.startTime
      ? Math.round((this.endTime - this.startTime) * 100) / 100
      : 0;

    const toolEvents = this.events.filter((e) => !e.isRetryEvent);

    let totalMcpCalls = toolEvents.length;
    let lowLevelJsCalls = 0;
    let browserExecutionTimeMs = 0;
    let pageInspectionCalls = 0;
    let repeatedPageInspections = 0;

    const toolBreakdown = {};

    let hasInspectedCurrentState = false;

    for (const evt of toolEvents) {
      toolBreakdown[evt.name] = (toolBreakdown[evt.name] || 0) + 1;
      browserExecutionTimeMs += evt.durationMs || 0;

      if (evt.isLowLevelJs) {
        lowLevelJsCalls++;
      }

      if (evt.isInspection) {
        pageInspectionCalls++;
        if (hasInspectedCurrentState) {
          repeatedPageInspections++;
        }
        hasInspectedCurrentState = true;
      } else if (evt.isMutation) {
        hasInspectedCurrentState = false;
      }
    }

    return {
      scenario: this.scenarioName,
      taskSuccess: this.taskSuccess,
      failureReason: this.failureReason,
      totalMcpCalls,
      lowLevelJsCalls,
      browserExecutionTimeMs: Math.round(browserExecutionTimeMs * 100) / 100,
      wallClockDurationMs: totalDurationMs,
      pageInspectionCalls,
      repeatedPageInspections,
      retries: this.retriesCount,
      toolBreakdown,
      metadata: this.metadata,
      events: this.events,
    };
  }

  _summarizeArgs(toolName, args) {
    if (!args || typeof args !== 'object') return {};
    const summary = {};
    if (args.url) summary.url = args.url;
    if (args.selector) summary.selector = args.selector;
    if (args.ref) summary.ref = args.ref;
    if (args.tabId) summary.tabId = args.tabId;
    if (args.value !== undefined) {
      summary.value = typeof args.value === 'string' && args.value.length > 30
        ? `${args.value.slice(0, 27)}...`
        : args.value;
    }
    if (args.code) {
      summary.code = typeof args.code === 'string' && args.code.length > 50
        ? `${args.code.slice(0, 47)}...`
        : args.code;
    }
    if (args.filter) summary.filter = args.filter;
    return summary;
  }
}
