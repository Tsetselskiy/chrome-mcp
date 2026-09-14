import assert from 'node:assert/strict';
import test from 'node:test';
import {
  rankActionableElements,
  formatCandidatesAsContent,
} from '../../packages/shared/dist/index.mjs';

/**
 * Holdout Domain Tests (Issue #2 Decontamination)
 *
 * Evaluates semantic action retrieval on four unrelated UI domains:
 *   1. Checkout & Shipping
 *   2. Settings & Appearance Theme
 *   3. Calendar & Date Scheduling
 *   4. Account Security & Credentials
 *
 * None of the domain-specific nouns (e.g. checkout, shipping, payment, theme,
 * dark mode, calendar, appointment, password, 2fa) exist in the semantic concept dictionary.
 * The retriever must generalize using only generic interaction semantics, token hashing,
 * subword n-grams, and lexical overlap.
 */

test('Holdout Domain 1: Checkout & Shipping - English action and input retrieval', () => {
  const elements = [
    {
      ref: 'ref_pay',
      role: 'button',
      name: 'Confirm Payment',
      context: 'Order Summary | Subtotal: $89.00',
      selector: '#confirm-payment-btn',
      coordinates: { x: 200, y: 500 },
    },
    {
      ref: 'ref_ship',
      role: 'textbox',
      name: 'Shipping Address',
      placeholder: 'Street address, suite, apartment',
      selector: '#shipping-addr-input',
      coordinates: { x: 200, y: 350 },
    },
    {
      ref: 'ref_cancel_order',
      role: 'button',
      name: 'Cancel Order',
      context: 'Checkout navigation',
      selector: '#cancel-order-btn',
      coordinates: { x: 100, y: 500 },
    },
    {
      ref: 'ref_promo',
      role: 'textbox',
      name: 'Promo Code',
      placeholder: 'Discount coupon',
      selector: '#coupon-input',
    },
  ];

  // Action retrieval for payment confirmation
  const payResult = rankActionableElements(elements, 'confirm payment and submit order');
  assert.ok(payResult.candidates.length > 0, 'Should find candidate for payment confirmation');
  assert.equal(payResult.topCandidate?.ref, 'ref_pay');
  assert.ok(payResult.topCandidate.score >= 0.5, 'Confidence score should be >= 0.5');

  // Input retrieval for shipping address
  const addrResult = rankActionableElements(elements, 'enter shipping street address');
  assert.ok(addrResult.candidates.length > 0, 'Should find candidate for shipping address');
  assert.equal(addrResult.topCandidate?.ref, 'ref_ship');
  assert.ok(addrResult.topCandidate.score >= 0.5, 'Confidence score should be >= 0.5');

  // Cancellation action
  const cancelResult = rankActionableElements(elements, 'cancel this checkout order');
  assert.equal(cancelResult.topCandidate?.ref, 'ref_cancel_order');
});

test('Holdout Domain 1: Checkout & Shipping - Multilingual action intents against English UI', () => {
  const elements = [
    {
      ref: 'ref_pay',
      role: 'button',
      name: 'Confirm Payment',
      context: 'Order Summary | Subtotal: $89.00',
      selector: '#confirm-payment-btn',
    },
    {
      ref: 'ref_ship',
      role: 'textbox',
      name: 'Shipping Address',
      placeholder: 'Street address',
      selector: '#shipping-addr-input',
    },
    {
      ref: 'ref_cancel_order',
      role: 'button',
      name: 'Cancel Order',
      context: 'Checkout navigation',
      selector: '#cancel-order-btn',
    },
  ];

  const multilingualIntents = [
    { lang: 'German', query: 'Zahlung bestätigen' },
    { lang: 'Spanish', query: 'confirmar pago' },
    { lang: 'French', query: 'confirmer le paiement' },
    { lang: 'Chinese', query: '确认付款' },
    { lang: 'Japanese', query: '支払いを送信' },
  ];

  for (const { lang, query } of multilingualIntents) {
    // Uses standard production threshold (default 0.25) without artificial relaxation
    const res = rankActionableElements(elements, query);
    assert.ok(res.candidates.length > 0, `${lang} should return candidates`);
    assert.equal(
      res.topCandidate?.ref,
      'ref_pay',
      `${lang} intent "${query}" should rank #confirm-payment-btn #1`,
    );
    assert.ok(res.topCandidate.score >= 0.35, `${lang} score should be >= 0.35`);
  }
});

test('Holdout Domain 1: Checkout & Shipping - Non-English UI elements & Shipping context disambiguation', () => {
  // Localized German checkout UI controls
  const germanElements = [
    {
      ref: 'ref_de_pay',
      role: 'button',
      name: 'Zahlung absenden',
      selector: '#de-pay-btn',
    },
    {
      ref: 'ref_de_cancel',
      role: 'button',
      name: 'Bestellung abbrechen',
      selector: '#de-cancel-btn',
    },
    {
      ref: 'ref_de_addr',
      role: 'textbox',
      placeholder: 'Lieferadresse eingeben',
      selector: '#de-addr-input',
    },
  ];

  // English intent querying German UI
  const payMatch = rankActionableElements(germanElements, 'confirm payment and submit order');
  assert.equal(payMatch.topCandidate?.ref, 'ref_de_pay');
  assert.ok(
    payMatch.topCandidate.score >= 0.35,
    'English intent on German UI should score >= 0.35',
  );

  const cancelMatch = rankActionableElements(germanElements, 'cancel checkout order');
  assert.equal(cancelMatch.topCandidate?.ref, 'ref_de_cancel');

  const addrMatch = rankActionableElements(germanElements, 'enter shipping street address');
  assert.equal(addrMatch.topCandidate?.ref, 'ref_de_addr');

  // Contextual shipping method disambiguation (same button label, distinct context)
  const shippingOptions = [
    {
      ref: 'ref_std_ship',
      role: 'button',
      name: 'Select',
      context: 'Standard Shipping (3-5 business days) $4.99',
      selector: '#select-std-shipping',
    },
    {
      ref: 'ref_exp_ship',
      role: 'button',
      name: 'Select',
      context: 'Express Overnight Shipping ($15.00)',
      selector: '#select-exp-shipping',
    },
  ];

  const expResult = rankActionableElements(shippingOptions, 'select express overnight shipping');
  assert.equal(expResult.topCandidate?.ref, 'ref_exp_ship');
  assert.ok(expResult.topCandidate.score >= 0.5);
});

test('Holdout Domain 2: Settings & Appearance Theme - English and Multilingual controls', () => {
  const elements = [
    {
      ref: 'ref_dark',
      role: 'button',
      name: 'Enable Dark Mode',
      context: 'Appearance & Themes',
      selector: '#dark-mode-btn',
    },
    {
      ref: 'ref_filter',
      role: 'textbox',
      name: 'Filter Settings',
      placeholder: 'Search preferences...',
      selector: '#filter-settings-input',
    },
    {
      ref: 'ref_reset',
      role: 'button',
      name: 'Reset Preferences',
      context: 'Danger Zone',
      selector: '#reset-preferences-btn',
    },
  ];

  // English toggle / enable
  const resDark = rankActionableElements(elements, 'enable dark theme mode');
  assert.equal(resDark.topCandidate?.ref, 'ref_dark');

  // English search / filter
  const resFilter = rankActionableElements(elements, 'filter settings preferences');
  assert.equal(resFilter.topCandidate?.ref, 'ref_filter');

  // Multilingual toggle intents - uses default production threshold without relaxation
  const multilingualIntents = [
    { lang: 'German', query: 'Dunkelmodus aktivieren' },
    { lang: 'French', query: 'activer le mode sombre' },
    { lang: 'Spanish', query: 'activar modo oscuro' },
    { lang: 'Chinese', query: '开启深色模式' },
    { lang: 'Japanese', query: 'ダークモードを有効化' },
  ];

  for (const { lang, query } of multilingualIntents) {
    const res = rankActionableElements(elements, query);
    assert.ok(res.candidates.length > 0, `${lang} should return candidates`);
    assert.equal(
      res.topCandidate?.ref,
      'ref_dark',
      `${lang} intent "${query}" should rank #dark-mode-btn #1`,
    );
    assert.ok(res.topCandidate.score >= 0.35, `${lang} score should be >= 0.35`);
  }
});

test('Holdout Domain 2: Settings & Appearance Theme - Icon buttons and aria-label / placeholder controls', () => {
  // Elements relying strictly on ariaLabel or placeholder without explicit name
  const iconElements = [
    {
      ref: 'ref_dark_icon',
      role: 'button',
      ariaLabel: 'Enable dark mode appearance',
      selector: '#dark-icon-btn',
    },
    {
      ref: 'ref_pref_search',
      role: 'textbox',
      placeholder: 'Search all user preferences',
      selector: '#pref-search-box',
    },
  ];

  const darkRes = rankActionableElements(iconElements, 'enable dark theme mode');
  assert.equal(darkRes.topCandidate?.ref, 'ref_dark_icon');
  assert.ok(darkRes.topCandidate.score >= 0.35);

  const searchRes = rankActionableElements(iconElements, 'search user preferences');
  assert.equal(searchRes.topCandidate?.ref, 'ref_pref_search');
  assert.ok(searchRes.topCandidate.score >= 0.4);
});

test('Holdout Domain 3: Calendar & Scheduling Date Picker - English controls and combobox dropdown', () => {
  const elements = [
    {
      ref: 'ref_pick_date',
      role: 'button',
      name: 'Select Meeting Date',
      context: 'Schedule Appointment | September 2026',
      selector: '#date-picker-btn',
    },
    {
      ref: 'ref_month_sel',
      role: 'combobox',
      name: 'Select Appointment Month',
      selector: '#month-dropdown',
    },
    {
      ref: 'ref_title',
      role: 'textbox',
      name: 'Event Title',
      placeholder: 'Enter meeting subject',
      selector: '#event-title-input',
    },
    {
      ref: 'ref_cancel_book',
      role: 'button',
      name: 'Cancel Booking',
      context: 'Reservation Dialog',
      selector: '#cancel-booking-btn',
    },
  ];

  // English select date
  const resDate = rankActionableElements(elements, 'select meeting date on calendar');
  assert.equal(resDate.topCandidate?.ref, 'ref_pick_date');

  // English combobox month selection
  const resMonth = rankActionableElements(elements, 'select appointment month');
  assert.equal(resMonth.topCandidate?.ref, 'ref_month_sel');

  // English input subject
  const resTitle = rankActionableElements(elements, 'enter event title and subject');
  assert.equal(resTitle.topCandidate?.ref, 'ref_title');
});

test('Holdout Domain 3: Calendar & Scheduling Date Picker - Multilingual date selection intents', () => {
  const elements = [
    {
      ref: 'ref_pick_date',
      role: 'button',
      name: 'Select Meeting Date',
      context: 'Schedule Appointment | September 2026',
      selector: '#date-picker-btn',
    },
    {
      ref: 'ref_title',
      role: 'textbox',
      name: 'Event Title',
      placeholder: 'Enter meeting subject',
      selector: '#event-title-input',
    },
    {
      ref: 'ref_cancel_book',
      role: 'button',
      name: 'Cancel Booking',
      context: 'Reservation Dialog',
      selector: '#cancel-booking-btn',
    },
  ];

  // Multilingual date selection intents - uses default production threshold without relaxation
  const multilingualIntents = [
    { lang: 'German', query: 'Datum auswählen' },
    { lang: 'French', query: 'sélectionner la date' },
    { lang: 'Spanish', query: 'seleccionar fecha' },
    { lang: 'Chinese', query: '选择日期' },
    { lang: 'Japanese', query: '日付を選択' },
  ];

  for (const { lang, query } of multilingualIntents) {
    const res = rankActionableElements(elements, query);
    assert.ok(res.candidates.length > 0, `${lang} should return candidates`);
    assert.equal(
      res.topCandidate?.ref,
      'ref_pick_date',
      `${lang} intent "${query}" should rank #date-picker-btn #1`,
    );
    assert.ok(res.topCandidate.score >= 0.35, `${lang} score should be >= 0.35`);
  }
});

test('Holdout Domain 4: Account Security & Credentials - English and Multilingual', () => {
  const elements = [
    {
      ref: 'ref_2fa_chk',
      role: 'checkbox',
      name: 'Enable two-factor authentication for login',
      selector: '#2fa-chk',
    },
    {
      ref: 'ref_2fa',
      role: 'button',
      name: 'Enable Two-Factor Auth',
      context: 'Security Credentials & Access',
      selector: '#enable-2fa-btn',
    },
    {
      ref: 'ref_pwd_fr',
      role: 'textbox',
      placeholder: 'Saisir mot de passe actuel',
      type: 'password',
      selector: '#pwd-fr',
    },
    {
      ref: 'ref_pwd',
      role: 'textbox',
      name: 'Current Password',
      type: 'password',
      placeholder: 'Enter existing password',
      selector: '#pwd-input',
    },
    {
      ref: 'ref_delete_acc',
      role: 'button',
      name: 'Delete Account',
      context: 'Danger Zone',
      selector: '#delete-account-btn',
    },
  ];

  // English enable 2FA
  const res2fa = rankActionableElements(elements, 'enable two-factor authentication');
  assert.ok(res2fa.topCandidate?.ref === 'ref_2fa' || res2fa.topCandidate?.ref === 'ref_2fa_chk');

  // English password input
  const resPwd = rankActionableElements(elements, 'enter current account password');
  assert.equal(resPwd.topCandidate?.ref, 'ref_pwd');

  // Multilingual password input (French placeholder)
  const resPwdFr = rankActionableElements(elements, 'saisir mot de passe');
  assert.equal(resPwdFr.topCandidate?.ref, 'ref_pwd_fr');

  // English account deletion
  const resDel = rankActionableElements(elements, 'delete account permanently');
  assert.equal(resDel.topCandidate?.ref, 'ref_delete_acc');

  // Multilingual enable 2FA intents - uses default production threshold without relaxation
  const multilingualIntents = [
    { lang: 'German', query: 'Zwei-Faktor aktivieren' },
    { lang: 'French', query: 'activer double authentification' },
    { lang: 'Spanish', query: 'activar autenticación de dos factores' },
    { lang: 'Chinese', query: '开启双重认证' },
    { lang: 'Japanese', query: '2段階認証を有効化' },
  ];

  for (const { lang, query } of multilingualIntents) {
    const res = rankActionableElements(elements, query);
    assert.ok(res.candidates.length > 0, `${lang} should return candidates`);
    assert.ok(
      res.topCandidate?.ref === 'ref_2fa' || res.topCandidate?.ref === 'ref_2fa_chk',
      `${lang} intent "${query}" should rank 2FA control #1`,
    );
    assert.ok(res.topCandidate.score >= 0.35, `${lang} score should be >= 0.35`);
  }
});

test('Holdout Domain 5: Negative & Out-of-Domain Control - Unrelated queries rejected cleanly', () => {
  const elements = [
    {
      ref: 'ref_2fa',
      role: 'button',
      name: 'Enable Two-Factor Auth',
      context: 'Security Credentials & Access',
      selector: '#enable-2fa-btn',
    },
    {
      ref: 'ref_pwd',
      role: 'textbox',
      name: 'Current Password',
      selector: '#pwd-input',
    },
  ];

  // Completely unrelated intent
  const res = rankActionableElements(
    elements,
    'order pepperoni pizza with extra cheesy crust for delivery',
  );
  assert.equal(res.candidates.length, 0, 'Should yield 0 candidates above threshold');
  assert.equal(res.topCandidate, null);

  const formatted = formatCandidatesAsContent(res.candidates, 'order pizza', elements.length);
  assert.ok(formatted.includes('No actionable element candidates matched'));
  assert.ok(formatted.includes('chrome_read_page'));
});

test('Holdout Domain 6: Edge Cases & Robustness - Boundary conditions handled cleanly', () => {
  const validElements = [
    { ref: 'ref_1', role: 'button', name: 'Submit Application' },
    { ref: 'ref_2', role: 'textbox', name: 'Full Legal Name' },
  ];

  // Empty string intent
  const emptyIntentRes = rankActionableElements(validElements, '');
  assert.equal(emptyIntentRes.candidates.length, 0);
  assert.equal(emptyIntentRes.topCandidate, null);

  // Whitespace-only intent
  const wsIntentRes = rankActionableElements(validElements, '     ');
  assert.equal(wsIntentRes.candidates.length, 0);
  assert.equal(wsIntentRes.topCandidate, null);

  // Empty element list
  const emptyListRes = rankActionableElements([], 'submit form');
  assert.equal(emptyListRes.candidates.length, 0);
  assert.equal(emptyListRes.topCandidate, null);

  // Minimal element without optional metadata fields does not throw
  const minimalElements = [{ ref: 'ref_bare' }];
  const minimalRes = rankActionableElements(minimalElements, 'submit');
  assert.ok(Array.isArray(minimalRes.candidates));

  // Max candidates slicing boundary
  const manyElements = [
    { ref: 'ref_a', role: 'button', name: 'Submit 1' },
    { ref: 'ref_b', role: 'button', name: 'Submit 2' },
    { ref: 'ref_c', role: 'button', name: 'Submit 3' },
  ];
  const max1Res = rankActionableElements(manyElements, 'submit', { maxCandidates: 1 });
  assert.equal(max1Res.candidates.length, 1);
});
