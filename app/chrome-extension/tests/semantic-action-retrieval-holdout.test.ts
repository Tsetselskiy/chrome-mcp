import { describe, expect, it } from 'vitest';
import {
  rankActionableElements,
  formatCandidatesAsContent,
  type ActionableElementSummary,
} from 'agent-chrome-mcp-shared';

/**
 * Holdout Domain Tests for Chrome Extension (Issue #2 Decontamination)
 *
 * Verifies that the semantic action retrieval layer successfully generalizes
 * to completely unrelated UI domains without relying on domain-specific vocabulary:
 *   1. Checkout & Shipping
 *   2. Settings & Appearance Theme
 *   3. Calendar & Date Scheduling
 *   4. Account Security & Credentials
 *
 * No words from these holdout domains exist in the semantic concept dictionary.
 */
describe('Holdout Domain Generalization Tests', () => {
  describe('Holdout Domain 1: Checkout & Shipping', () => {
    const elements: ActionableElementSummary[] = [
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

    it('retrieves target action button and input field in English', () => {
      const payRes = rankActionableElements(elements, 'confirm payment and submit order');
      expect(payRes.candidates.length).toBeGreaterThan(0);
      expect(payRes.topCandidate?.ref).toBe('ref_pay');
      expect(payRes.topCandidate?.score).toBeGreaterThanOrEqual(0.5);

      const addrRes = rankActionableElements(elements, 'enter shipping street address');
      expect(addrRes.candidates.length).toBeGreaterThan(0);
      expect(addrRes.topCandidate?.ref).toBe('ref_ship');
      expect(addrRes.topCandidate?.score).toBeGreaterThanOrEqual(0.5);

      const cancelRes = rankActionableElements(elements, 'cancel checkout order');
      expect(cancelRes.topCandidate?.ref).toBe('ref_cancel_order');
    });

    it('matches checkout interaction intents across multiple languages with default threshold', () => {
      const multilingualIntents = [
        { lang: 'German', query: 'Zahlung bestätigen' },
        { lang: 'Spanish', query: 'confirmar pago' },
        { lang: 'French', query: 'confirmer le paiement' },
        { lang: 'Chinese', query: '确认付款' },
        { lang: 'Japanese', query: '支払いを送信' },
      ];

      for (const { lang, query } of multilingualIntents) {
        // Standard production default threshold without relaxation
        const res = rankActionableElements(elements, query);
        expect(res.candidates.length, `${lang} should return candidates`).toBeGreaterThan(0);
        expect(
          res.topCandidate?.ref,
          `${lang} ("${query}") should rank #confirm-payment-btn #1`,
        ).toBe('ref_pay');
        expect(res.topCandidate?.score, `${lang} score`).toBeGreaterThanOrEqual(0.35);
      }
    });

    it('handles localized German checkout UI and shipping context disambiguation', () => {
      const germanElements: ActionableElementSummary[] = [
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

      const payMatch = rankActionableElements(germanElements, 'confirm payment and submit order');
      expect(payMatch.topCandidate?.ref).toBe('ref_de_pay');
      expect(payMatch.topCandidate?.score).toBeGreaterThanOrEqual(0.35);

      const cancelMatch = rankActionableElements(germanElements, 'cancel checkout order');
      expect(cancelMatch.topCandidate?.ref).toBe('ref_de_cancel');

      const addrMatch = rankActionableElements(germanElements, 'enter shipping street address');
      expect(addrMatch.topCandidate?.ref).toBe('ref_de_addr');

      // Shipping option disambiguation
      const shippingOptions: ActionableElementSummary[] = [
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

      const expResult = rankActionableElements(
        shippingOptions,
        'select express overnight shipping',
      );
      expect(expResult.topCandidate?.ref).toBe('ref_exp_ship');
      expect(expResult.topCandidate?.score).toBeGreaterThanOrEqual(0.5);
    });
  });

  describe('Holdout Domain 2: Settings & Appearance Theme', () => {
    const elements: ActionableElementSummary[] = [
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

    it('retrieves settings controls in English and across languages', () => {
      const darkRes = rankActionableElements(elements, 'enable dark theme mode');
      expect(darkRes.topCandidate?.ref).toBe('ref_dark');

      const filterRes = rankActionableElements(elements, 'filter settings preferences');
      expect(filterRes.topCandidate?.ref).toBe('ref_filter');

      const multilingualIntents = [
        { lang: 'German', query: 'Dunkelmodus aktivieren' },
        { lang: 'French', query: 'activer le mode sombre' },
        { lang: 'Spanish', query: 'activar modo oscuro' },
        { lang: 'Chinese', query: '开启深色模式' },
        { lang: 'Japanese', query: 'ダークモードを有効化' },
      ];

      for (const { lang, query } of multilingualIntents) {
        const res = rankActionableElements(elements, query);
        expect(res.candidates.length, `${lang} should return candidates`).toBeGreaterThan(0);
        expect(res.topCandidate?.ref, `${lang} should rank #dark-mode-btn #1`).toBe('ref_dark');
        expect(res.topCandidate?.score, `${lang} score`).toBeGreaterThanOrEqual(0.35);
      }
    });

    it('matches icon buttons and aria-label / placeholder controls', () => {
      const iconElements: ActionableElementSummary[] = [
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
      expect(darkRes.topCandidate?.ref).toBe('ref_dark_icon');
      expect(darkRes.topCandidate?.score).toBeGreaterThanOrEqual(0.35);

      const searchRes = rankActionableElements(iconElements, 'search user preferences');
      expect(searchRes.topCandidate?.ref).toBe('ref_pref_search');
      expect(searchRes.topCandidate?.score).toBeGreaterThanOrEqual(0.4);
    });
  });

  describe('Holdout Domain 3: Calendar & Scheduling Date Picker', () => {
    const elements: ActionableElementSummary[] = [
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

    it('retrieves date picking and combobox actions in English', () => {
      const dateRes = rankActionableElements(elements, 'select meeting date on calendar');
      expect(dateRes.topCandidate?.ref).toBe('ref_pick_date');

      const monthRes = rankActionableElements(elements, 'select appointment month');
      expect(monthRes.topCandidate?.ref).toBe('ref_month_sel');

      const titleRes = rankActionableElements(elements, 'enter event title and subject');
      expect(titleRes.topCandidate?.ref).toBe('ref_title');
    });

    it('matches date selection across languages with default threshold', () => {
      const dateElements: ActionableElementSummary[] = [
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

      const multilingualIntents = [
        { lang: 'German', query: 'Datum auswählen' },
        { lang: 'French', query: 'sélectionner la date' },
        { lang: 'Spanish', query: 'seleccionar fecha' },
        { lang: 'Chinese', query: '选择日期' },
        { lang: 'Japanese', query: '日付を選択' },
      ];

      for (const { lang, query } of multilingualIntents) {
        const res = rankActionableElements(dateElements, query);
        expect(res.candidates.length, `${lang} should return candidates`).toBeGreaterThan(0);
        expect(res.topCandidate?.ref, `${lang} should rank #date-picker-btn #1`).toBe(
          'ref_pick_date',
        );
        expect(res.topCandidate?.score, `${lang} score`).toBeGreaterThanOrEqual(0.35);
      }
    });
  });

  describe('Holdout Domain 4: Account Security & Credentials', () => {
    const elements: ActionableElementSummary[] = [
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

    it('retrieves security controls in English and localized inputs', () => {
      const authRes = rankActionableElements(elements, 'enable two-factor authentication');
      expect(['ref_2fa', 'ref_2fa_chk']).toContain(authRes.topCandidate?.ref);

      const pwdRes = rankActionableElements(elements, 'enter current account password');
      expect(pwdRes.topCandidate?.ref).toBe('ref_pwd');

      const pwdFrRes = rankActionableElements(elements, 'saisir mot de passe');
      expect(pwdFrRes.topCandidate?.ref).toBe('ref_pwd_fr');

      const delRes = rankActionableElements(elements, 'delete account permanently');
      expect(delRes.topCandidate?.ref).toBe('ref_delete_acc');
    });

    it('matches security intents across languages with default threshold', () => {
      const multilingualIntents = [
        { lang: 'German', query: 'Zwei-Faktor aktivieren' },
        { lang: 'French', query: 'activer double authentification' },
        { lang: 'Spanish', query: 'activar autenticación de dos factores' },
        { lang: 'Chinese', query: '开启双重认证' },
        { lang: 'Japanese', query: '2段階認証を有効化' },
      ];

      for (const { lang, query } of multilingualIntents) {
        const res = rankActionableElements(elements, query);
        expect(res.candidates.length, `${lang} should return candidates`).toBeGreaterThan(0);
        expect(['ref_2fa', 'ref_2fa_chk']).toContain(res.topCandidate?.ref);
        expect(res.topCandidate?.score, `${lang} score`).toBeGreaterThanOrEqual(0.35);
      }
    });
  });

  describe('Holdout Domain 5: Negative & Out-of-Domain Control', () => {
    it('cleanly rejects unrelated queries below threshold without false positives', () => {
      const elements: ActionableElementSummary[] = [
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

      const res = rankActionableElements(
        elements,
        'order pepperoni pizza with extra cheesy crust for delivery',
      );
      expect(res.candidates.length).toBe(0);
      expect(res.topCandidate).toBeNull();

      const formatted = formatCandidatesAsContent(res.candidates, 'order pizza', elements.length);
      expect(formatted).toContain('No actionable element candidates matched the intent');
      expect(formatted).toContain('chrome_read_page');
    });
  });

  describe('Holdout Domain 6: Edge Cases & Robustness', () => {
    const validElements: ActionableElementSummary[] = [
      { ref: 'ref_1', role: 'button', name: 'Submit Application' },
      { ref: 'ref_2', role: 'textbox', name: 'Full Legal Name' },
    ];

    it('handles empty/whitespace intents and empty candidate lists gracefully', () => {
      expect(rankActionableElements(validElements, '').candidates).toHaveLength(0);
      expect(rankActionableElements(validElements, '     ').candidates).toHaveLength(0);
      expect(rankActionableElements([], 'submit').candidates).toHaveLength(0);

      const minimalElements: ActionableElementSummary[] = [{ ref: 'ref_bare' }];
      expect(Array.isArray(rankActionableElements(minimalElements, 'submit').candidates)).toBe(
        true,
      );

      const manyElements: ActionableElementSummary[] = [
        { ref: 'ref_a', role: 'button', name: 'Submit 1' },
        { ref: 'ref_b', role: 'button', name: 'Submit 2' },
        { ref: 'ref_c', role: 'button', name: 'Submit 3' },
      ];
      expect(
        rankActionableElements(manyElements, 'submit', { maxCandidates: 1 }).candidates,
      ).toHaveLength(1);
    });
  });
});
