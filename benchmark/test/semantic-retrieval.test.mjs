import assert from 'node:assert/strict';
import test from 'node:test';
import {
  rankActionableElements,
  embedText,
  cosineSimilarity,
  formatCandidatesAsContent,
  SemanticActionCache,
  buildCandidateDescriptor,
} from '../../packages/shared/dist/index.mjs';

test('Semantic Action Retrieval - 1. Clear intent ranks target button #1', () => {
  const elements = [
    {
      ref: 'ref_1',
      role: 'button',
      name: 'Activate Service',
      context: 'CloudOps Primary Service Console',
      selector: '#activate-btn',
      coordinates: { x: 150, y: 300 },
    },
    {
      ref: 'ref_2',
      role: 'button',
      name: 'Dismiss Warning',
      context: 'Notification Banner',
      selector: '#dismiss-btn',
      coordinates: { x: 400, y: 50 },
    },
    {
      ref: 'ref_3',
      role: 'textbox',
      name: 'Search Documentation',
      placeholder: 'Search docs...',
      context: 'Header Search Bar',
      selector: '#search-docs',
      coordinates: { x: 300, y: 20 },
    },
  ];

  const result = rankActionableElements(elements, 'activate the primary service');
  assert.ok(result.candidates.length > 0, 'Should find candidate for clear intent');
  assert.equal(result.topCandidate?.ref, 'ref_1');
  assert.ok(
    result.topCandidate.score >= 0.6,
    `Top candidate score ${result.topCandidate.score} should be >= 0.6`,
  );
  assert.equal(result.candidates[0].ref, 'ref_1');
});

test('Semantic Action Retrieval - 2. Ambiguous candidates returned with context for LLM disambiguation', () => {
  const elements = [
    {
      ref: 'ref_10',
      role: 'button',
      name: 'Select Cluster',
      context: 'US-East Production Primary (us-east-1)',
      selector: '#select-us-east',
    },
    {
      ref: 'ref_11',
      role: 'button',
      name: 'Select Cluster',
      context: 'EU-West Secondary (eu-west-1)',
      selector: '#select-eu-west',
    },
    {
      ref: 'ref_12',
      role: 'button',
      name: 'Select Cluster',
      context: 'AP-South Development (ap-south-1)',
      selector: '#select-ap-south',
    },
    {
      ref: 'ref_13',
      role: 'button',
      name: 'Cancel Allocation',
      context: 'Footer actions',
      selector: '#cancel-btn',
    },
  ];

  // Agent intent includes "us-east"
  const resultEast = rankActionableElements(elements, 'select us-east cluster', {
    maxCandidates: 3,
  });
  assert.equal(resultEast.candidates.length, 3);
  assert.equal(resultEast.topCandidate?.ref, 'ref_10');
  assert.ok(
    resultEast.candidates[0].score > resultEast.candidates[1].score,
    'US-East candidate should score higher than EU-West',
  );

  // Generic intent returns multiple candidates with distinct context for LLM decision
  const resultGeneric = rankActionableElements(elements, 'select cluster', {
    maxCandidates: 3,
  });
  assert.equal(resultGeneric.candidates.length, 3);
  const refs = resultGeneric.candidates.map((c) => c.ref);
  assert.ok(refs.includes('ref_10'));
  assert.ok(refs.includes('ref_11'));
  assert.ok(refs.includes('ref_12'));
  // Ensure context is preserved on each candidate
  assert.ok(resultGeneric.candidates.find((c) => c.ref === 'ref_10')?.context?.includes('US-East'));
  assert.ok(resultGeneric.candidates.find((c) => c.ref === 'ref_11')?.context?.includes('EU-West'));
});

test('Semantic Action Retrieval - 3. No useful match falls back cleanly below threshold', () => {
  const elements = [
    {
      ref: 'ref_1',
      role: 'button',
      name: 'Submit Allocation',
      context: 'Cluster Orchestrator',
      selector: '#submit-btn',
    },
    {
      ref: 'ref_2',
      role: 'textbox',
      name: 'Node Count',
      context: 'Capacity Settings',
      selector: '#node-count',
    },
  ];

  // Unrelated intent should yield zero candidates above default threshold
  const result = rankActionableElements(elements, 'order pepperoni pizza with cheese delivery', {
    threshold: 0.35,
  });
  assert.equal(result.candidates.length, 0);
  assert.equal(result.topCandidate, null);

  // Formatter produces fallback message advising standard page inspection
  const formatted = formatCandidatesAsContent(result.candidates, 'order pepperoni pizza', 2);
  assert.ok(formatted.includes('No actionable element candidates matched'));
  assert.ok(formatted.includes('chrome_read_page'));
});

test('Semantic Action Retrieval - 4. Multilingual intent matches English UI elements', () => {
  const elements = [
    {
      ref: 'ref_act',
      role: 'button',
      name: 'Activate Primary Service',
      context: 'CloudOps Console Service Controls',
      selector: '#activate-btn',
    },
    {
      ref: 'ref_view',
      role: 'link',
      name: 'View Documentation',
      context: 'Help Menu',
      selector: '#docs-link',
    },
    {
      ref: 'ref_del',
      role: 'button',
      name: 'Delete Service',
      context: 'Danger Zone',
      selector: '#delete-btn',
    },
  ];

  const multilingualIntents = [
    { lang: 'German', query: 'Dienst aktivieren' },
    { lang: 'French', query: 'activer le service principal' },
    { lang: 'Spanish', query: 'activar el servicio principal' },
    { lang: 'Chinese', query: '激活主服务' },
    { lang: 'Japanese', query: '主サービスを起動' },
    { lang: 'Russian', query: 'активировать главный сервис' },
  ];

  for (const { lang, query } of multilingualIntents) {
    const res = rankActionableElements(elements, query, { maxCandidates: 2 });
    assert.ok(
      res.candidates.length > 0,
      `Language ${lang} ("${query}") should return at least one candidate`,
    );
    assert.equal(
      res.topCandidate?.ref,
      'ref_act',
      `Language ${lang} ("${query}") must rank #activate-btn as #1, got: ${res.topCandidate?.ref}`,
    );
    assert.ok(
      res.topCandidate.score >= 0.35,
      `Language ${lang} score ${res.topCandidate.score} must be >= 0.35`,
    );
  }
});

test('Semantic Action Retrieval - 5. Stable page cache invalidates on DOM revision or URL change', () => {
  const cache = new SemanticActionCache();
  const tabId = 42;
  const urlA = 'http://localhost:12399/short/index.html';
  const urlB = 'http://localhost:12399/dynamic/index.html';

  const elements = [
    {
      ref: 'ref_1',
      role: 'button',
      name: 'Activate',
      descriptor: 'button "Activate"',
    },
  ];
  const embeddings = [embedText('button "Activate"')];

  // Set cache at DOM revision 1
  cache.set(tabId, urlA, 1, elements, embeddings);

  // Hit: same tab, same URL, same DOM revision
  const hit = cache.get(tabId, urlA, 1);
  assert.ok(hit !== null, 'Cache should hit for identical tab, url, revision');
  assert.equal(hit.elements.length, 1);

  // Miss: DOM revision incremented (e.g. after dynamic mutation)
  const staleRevision = cache.get(tabId, urlA, 2);
  assert.equal(staleRevision, null, 'Cache must miss when domRevision changes');

  // Re-populate at revision 2
  cache.set(tabId, urlA, 2, elements, embeddings);

  // Miss: navigated to different URL
  const navigated = cache.get(tabId, urlB, 2);
  assert.equal(navigated, null, 'Cache must miss when URL changes');

  // Miss: different tab ID
  const differentTab = cache.get(999, urlA, 2);
  assert.equal(differentTab, null, 'Cache must miss for different tab');

  // Explicit invalidation by tab
  cache.set(tabId, urlA, 3, elements, embeddings);
  cache.invalidate(tabId);
  assert.equal(cache.get(tabId, urlA, 3), null, 'Cache must be null after invalidate(tabId)');
});

test('Semantic Action Retrieval - 6. Candidate descriptor construction and content formatting', () => {
  const el = {
    ref: 'ref_42',
    role: 'button',
    name: 'Deploy Cluster',
    ariaLabel: 'Deploy New Production Cluster',
    placeholder: null,
    type: 'submit',
    context: 'Cluster Management | Region: us-east',
    href: null,
    selector: '#deploy-btn',
    coordinates: { x: 250, y: 400 },
    disabled: false,
  };

  const descriptor = buildCandidateDescriptor(el);
  assert.ok(descriptor.includes('button'));
  assert.ok(descriptor.includes('Deploy Cluster'));
  assert.ok(descriptor.includes('Deploy New Production Cluster'));
  assert.ok(descriptor.includes('Cluster Management'));

  const ranked = rankActionableElements([el], 'deploy new production cluster');
  assert.equal(ranked.topCandidate?.ref, 'ref_42');

  const formatted = formatCandidatesAsContent(ranked.candidates, 'deploy cluster', 1);
  assert.ok(formatted.includes('[ref=ref_42]'));
  assert.ok(formatted.includes('Main LLM Decision: Choose one candidate ref'));
  assert.ok(formatted.includes('chrome_computer'));
});
