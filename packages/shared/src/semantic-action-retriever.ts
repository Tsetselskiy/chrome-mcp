/**
 * Semantic Action Retriever
 *
 * Provides local embedding and cosine-similarity ranking for actionable UI elements.
 * Generates compact candidate sets from natural-language interaction intent,
 * preserving existing ref_* identifiers for execution by chrome_computer or click/fill primitives.
 */

import type {
  ActionableCandidate,
  ActionableElementSummary,
  SemanticRetrievalResult,
} from './types';

export const EMBEDDING_DIMENSION = 256;

// Multilingual UI semantic concept definitions mapping cross-language intents to canonical features
const CONCEPT_MAPPINGS: Record<string, string[]> = {
  ACTIVATE: [
    'activate', 'activating', 'activation', 'enable', 'start', 'launch', 'run', 'turn on',
    'aktivieren', 'aktivierung', 'activer', 'activation', 'activar', 'activación',
    'ligar', 'ativar', 'abilitare', 'attiva', 'включить', 'активировать', 'запустить',
    '激活', '开启', '启动', '有効化', '起動',
  ],
  SUBMIT: [
    'submit', 'submitting', 'submission', 'send', 'confirm', 'apply',
    'commit', 'post', 'execute', 'senden', 'absenden', 'bestätigen',
    'soumettre', 'envoyer', 'confirmer', 'valider', 'enviar', 'confirmar',
    'validar', 'отправить', 'подтвердить', '提交', '确认', '发布',
    '送信', '確定',
  ],
  SEARCH: [
    'search', 'searching', 'find', 'filter', 'filtering', 'query', 'lookup',
    'suchen', 'suche', 'filtern', 'filterung', 'chercher', 'rechercher', 'filtrer',
    'buscar', 'búsqueda', 'filtrar', 'поиск', 'искать', 'фильтр',
    '搜索', '查找', '查询', '过滤', '検索', '絞り込み',
  ],
  SELECT: [
    'select', 'selecting', 'selection', 'choose', 'pick', 'check',
    'auswählen', 'auswahl', 'wählen', 'choisir', 'sélectionner', 'sélection',
    'seleccionar', 'selección', 'elegir', 'выбрать', 'выбор',
    '选择', '挑选', '选中', '選択', '選ぶ',
  ],
  CANCEL: [
    'cancel', 'cancelling', 'abort', 'close', 'dismiss', 'clear', 'reset', 'exit',
    'abbrechen', 'schließen', 'verwerfen', 'annuler', 'fermer', 'quitter',
    'cancelar', 'cerrar', 'отмена', 'закрыть', '取消', '关闭', '放弃',
    'キャンセル', '閉じる',
  ],
  EDIT: [
    'edit', 'editing', 'modify', 'change', 'update', 'rename',
    'bearbeiten', 'ändern', 'modifier', 'editer', 'editar', 'modificar',
    'редактировать', 'изменить', '编辑', '修改', '更新', '編集',
  ],
  DELETE: [
    'delete', 'deleting', 'remove', 'removing', 'destroy', 'drop', 'trash',
    'löschen', 'entfernen', 'supprimer', 'effacer', 'eliminar', 'borrar',
    'удалить', 'стереть', '删除', '移除', '削除',
  ],
  NAVIGATE: [
    'navigate', 'go', 'visit', 'open', 'browse', 'next', 'previous', 'back', 'forward',
    'gehen', 'öffnen', 'weiter', 'zurück', 'naviguer', 'aller', 'ouvrir', 'suivant', 'précédent',
    'navegar', 'ir', 'abrir', 'siguiente', 'anterior', 'перейти', 'открыть', 'следующий', 'назад',
    '导航', '前往', '打开', '下一步', '上一页', '次へ', '戻る',
  ],
  INPUT: [
    'input', 'enter', 'type', 'write', 'fill', 'textbox',
    'eingeben', 'tippen', 'schreiben', 'ausfüllen', 'entrer', 'saisir', 'écrire', 'remplir',
    'ingresar', 'escribir', 'escribe', 'rellenar', 'ввести', 'напечатать', 'заполнить',
    '输入', '填写', '写入', '記入', '入力',
  ],
};

// Flatten concepts into quick lookup map: alias -> conceptKey
const CONCEPT_LOOKUP = new Map<string, string>();
for (const [conceptKey, aliases] of Object.entries(CONCEPT_MAPPINGS)) {
  for (const alias of aliases) {
    CONCEPT_LOOKUP.set(alias.toLowerCase(), conceptKey);
  }
}

// 32-bit FNV-1a hash
function fnv1a(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Clean and normalize arbitrary string for semantic embedding
 */
export function normalizeText(text: string): string {
  if (!text) return '';
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Tokenize string into words and CJK characters
 */
export function tokenize(text: string): string[] {
  const norm = normalizeText(text);
  if (!norm) return [];
  const tokens: string[] = [];
  const rawWords = norm.split(/\s+/);

  for (const word of rawWords) {
    if (!word) continue;
    tokens.push(word);
    // Split CJK characters into unigrams and bigrams for robust word segment matching
    for (let i = 0; i < word.length; i++) {
      const code = word.charCodeAt(i);
      if (
        (code >= 0x4e00 && code <= 0x9fff) || // CJK Unified Ideographs
        (code >= 0x3040 && code <= 0x309f) || // Hiragana
        (code >= 0x30a0 && code <= 0x30ff)    // Katakana
      ) {
        tokens.push(word[i]);
        if (i <= word.length - 2) {
          tokens.push(word.substring(i, i + 2));
        }
      }
    }
  }

  return tokens;
}

/**
 * Generate local vector embedding for text using concept mapping + subword character n-grams
 */
export function embedText(text: string, dim: number = EMBEDDING_DIMENSION): Float32Array {
  const vec = new Float32Array(dim);
  const norm = normalizeText(text);
  if (!norm) return vec;

  const tokens = tokenize(norm);
  const matchedConcepts = new Set<string>();

  // 1. Match semantic concepts across languages
  for (const token of tokens) {
    const concept = CONCEPT_LOOKUP.get(token);
    if (concept) {
      matchedConcepts.add(concept);
    }
  }

  // Check multi-word phrase concepts (e.g. "turn on") and unspaced CJK phrases
  for (const [conceptKey, aliases] of Object.entries(CONCEPT_MAPPINGS)) {
    for (const alias of aliases) {
      if (alias.includes(' ')) {
        if (norm.includes(alias)) {
          matchedConcepts.add(conceptKey);
        }
      } else if (/[\u4e00-\u9fff\u3040-\u30ff]/.test(alias)) {
        if (norm.includes(alias)) {
          matchedConcepts.add(conceptKey);
        }
      }
    }
  }

  // 1. Concept dimensions allocated in dedicated partition (0 .. NUM_CONCEPTS - 1)
  const NUM_CONCEPTS = Object.keys(CONCEPT_MAPPINGS).length;
  const NUM_ROLE_DIMS = 3;
  const HASH_START = NUM_CONCEPTS;
  const HASH_RANGE = Math.max(1, dim - NUM_CONCEPTS - NUM_ROLE_DIMS);

  let conceptIdx = 0;
  for (const conceptKey of Object.keys(CONCEPT_MAPPINGS)) {
    if (matchedConcepts.has(conceptKey)) {
      vec[conceptIdx] += 6.0;
    }
    conceptIdx++;
  }

  // 2. Token hashing (word-level features) in dedicated partition
  for (const token of tokens) {
    const h = fnv1a(token);
    const targetIdx = HASH_START + (h % HASH_RANGE);
    const sign = (h & 1) === 0 ? 1 : -1;
    vec[targetIdx] += sign * 1.5;
  }

  // 3. Subword character 3-grams & 4-grams (morphology & typo resilience) in dedicated partition
  for (const token of tokens) {
    if (token.length >= 3) {
      for (let i = 0; i <= token.length - 3; i++) {
        const trigram = token.substring(i, i + 3);
        const h = fnv1a(trigram);
        const idx = HASH_START + (h % HASH_RANGE);
        const sign = (h & 1) === 0 ? 1 : -1;
        vec[idx] += sign * 0.6;
      }
    }
    if (token.length >= 4) {
      for (let i = 0; i <= token.length - 4; i++) {
        const fourgram = token.substring(i, i + 4);
        const h = fnv1a(fourgram);
        const idx = HASH_START + (h % HASH_RANGE);
        const sign = (h & 1) === 0 ? 1 : -1;
        vec[idx] += sign * 0.4;
      }
    }
  }

  // 4. Role alignment features (dim - 3 .. dim - 1)
  if (/\b(click|press|tap|button|activate|submit|link)\b/i.test(norm)) {
    vec[dim - 1] += 2.0;
  }
  if (/\b(enter|type|input|write|fill|field|box|textbox)\b/i.test(norm)) {
    vec[dim - 2] += 2.0;
  }
  if (/\b(select|choose|pick|dropdown|option|combobox)\b/i.test(norm)) {
    vec[dim - 3] += 2.0;
  }

  // 5. L2 Normalize vector
  let normSum = 0;
  for (let i = 0; i < dim; i++) {
    normSum += vec[i] * vec[i];
  }
  const magnitude = Math.sqrt(normSum);
  if (magnitude > 1e-8) {
    for (let i = 0; i < dim; i++) {
      vec[i] /= magnitude;
    }
  }

  return vec;
}

/**
 * Compute cosine similarity between two unit-normalized vectors
 */
export function cosineSimilarity(vecA: Float32Array, vecB: Float32Array): number {
  if (vecA.length !== vecB.length || vecA.length === 0) return 0;
  let dot = 0;
  for (let i = 0; i < vecA.length; i++) {
    dot += vecA[i] * vecB[i];
  }
  // For normalized vectors, positive dot product reflects semantic similarity; clamp to [0, 1]
  return Math.max(0, Math.min(1, dot));
}

/**
 * Construct composite descriptor for an actionable element
 */
export function buildCandidateDescriptor(el: ActionableElementSummary): string {
  const parts: string[] = [];
  if (el.role) parts.push(el.role);
  if (el.name) parts.push(`"${el.name}"`);
  if (el.ariaLabel && el.ariaLabel !== el.name) parts.push(`label: "${el.ariaLabel}"`);
  if (el.placeholder) parts.push(`placeholder: "${el.placeholder}"`);
  if (el.type && el.type !== 'button' && el.type !== 'submit') parts.push(`type: "${el.type}"`);
  if (el.context) parts.push(`context: ${el.context}`);
  if (el.href) parts.push(`href: "${el.href}"`);
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * Compute lexical overlap ratio between query tokens and candidate text
 */
function computeLexicalOverlap(queryTokens: string[], candidateText: string): number {
  if (queryTokens.length === 0) return 0;
  const candNorm = normalizeText(candidateText);
  if (!candNorm) return 0;

  const candWords = new Set(tokenize(candNorm));
  let matchCount = 0;

  for (const token of queryTokens) {
    if (candWords.has(token) || (token.length >= 3 && candNorm.includes(token))) {
      matchCount++;
    }
  }

  return matchCount / queryTokens.length;
}

/**
 * In-memory tab-level cache for element descriptors and embeddings within a stable page state
 */
export class SemanticActionCache {
  private cache = new Map<
    number,
    {
      url: string;
      domRevision: number;
      timestamp: number;
      elements: ActionableElementSummary[];
      embeddings: Float32Array[];
    }
  >();

  get(tabId: number, url: string, domRevision: number) {
    const entry = this.cache.get(tabId);
    if (!entry) return null;
    if (entry.url !== url || entry.domRevision !== domRevision) {
      // Stale or navigated
      this.cache.delete(tabId);
      return null;
    }
    return entry;
  }

  set(
    tabId: number,
    url: string,
    domRevision: number,
    elements: ActionableElementSummary[],
    embeddings: Float32Array[],
  ) {
    this.cache.set(tabId, {
      url,
      domRevision,
      timestamp: Date.now(),
      elements,
      embeddings,
    });
  }

  invalidate(tabId?: number) {
    if (tabId !== undefined) {
      this.cache.delete(tabId);
    } else {
      this.cache.clear();
    }
  }
}

export const globalActionCache = new SemanticActionCache();

/**
 * Rank actionable elements against a natural-language interaction intent
 */
export function rankActionableElements(
  elements: ActionableElementSummary[],
  intent: string,
  options: {
    maxCandidates?: number;
    threshold?: number;
    cachedEmbeddings?: Float32Array[];
  } = {},
): {
  candidates: ActionableCandidate[];
  embeddings: Float32Array[];
  topCandidate: ActionableCandidate | null;
} {
  const maxCandidates = Math.max(1, options.maxCandidates || 5);
  const minThreshold = options.threshold !== undefined ? options.threshold : 0.25;

  const trimmedIntent = (intent || '').trim();
  if (!trimmedIntent || !Array.isArray(elements) || elements.length === 0) {
    return { candidates: [], embeddings: [], topCandidate: null };
  }

  const queryVec = embedText(trimmedIntent);
  const queryTokens = tokenize(trimmedIntent);

  const embeddings: Float32Array[] = [];
  const scoredItems: { candidate: ActionableCandidate; score: number }[] = [];

  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];
    const descriptor = el.descriptor || buildCandidateDescriptor(el);

    // Reuse cached embedding if provided and valid
    let elemVec: Float32Array;
    if (options.cachedEmbeddings && options.cachedEmbeddings[i]) {
      elemVec = options.cachedEmbeddings[i];
    } else {
      elemVec = embedText(descriptor);
    }
    embeddings.push(elemVec);

    // 1. Vector cosine similarity
    const cosScore = cosineSimilarity(queryVec, elemVec);

    // 2. Lexical & token overlap
    const lexicalScore = computeLexicalOverlap(queryTokens, descriptor);

    // 3. Exact phrase match bonus
    const normIntent = normalizeText(trimmedIntent);
    const normDescriptor = normalizeText(descriptor);
    const exactPhraseMatch = normDescriptor.includes(normIntent) ? 0.3 : 0;

    // Combined score: dense vector cosine similarity is the primary semantic signal;
    // lexical overlap and exact phrase matches provide confidence boost.
    let combinedScore = cosScore;
    if (lexicalScore > 0) {
      combinedScore += lexicalScore * 0.25;
    }
    if (exactPhraseMatch > 0) {
      combinedScore += exactPhraseMatch;
    }
    combinedScore = Math.min(1.0, combinedScore);

    const roundedScore = Math.round(combinedScore * 100) / 100;

    const candidate: ActionableCandidate = {
      ref: el.ref,
      role: el.role || 'element',
      name: el.name || '',
      score: roundedScore,
      ariaLabel: el.ariaLabel,
      href: el.href,
      placeholder: el.placeholder,
      type: el.type,
      context: el.context,
      descriptor,
      selector: el.selector,
      coordinates: el.coordinates,
      disabled: el.disabled,
    };

    scoredItems.push({ candidate, score: roundedScore });
  }

  // Sort candidates by score descending
  scoredItems.sort((a, b) => b.score - a.score);

  // Filter out items below minimum confidence threshold
  const filtered = scoredItems.filter((item) => item.score >= minThreshold);
  const topSlice = filtered.slice(0, maxCandidates).map((item) => item.candidate);

  return {
    candidates: topSlice,
    embeddings,
    topCandidate: topSlice[0] || null,
  };
}

/**
 * Format actionable element candidates as concise page content for LLM consumption
 */
export function formatCandidatesAsContent(
  candidates: ActionableCandidate[],
  intent: string,
  totalConsidered: number,
): string {
  if (candidates.length === 0) {
    return `No actionable element candidates matched the intent "${intent}". (${totalConsidered} actionable elements examined).\nUse normal page inspection (e.g. chrome_read_page without intent or chrome_screenshot) to locate target elements.`;
  }

  const lines = [
    `Actionable Element Candidates for intent "${intent}" (Top ${candidates.length} of ${totalConsidered}):`,
  ];

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    let line = `${i + 1}. [ref=${c.ref}] ${c.role} "${c.name || 'unnamed'}" (score: ${c.score.toFixed(2)})`;
    if (c.context) line += ` context: ${c.context}`;
    if (c.selector) line += ` selector: ${c.selector}`;
    if (c.coordinates) line += ` coords: (x=${c.coordinates.x},y=${c.coordinates.y})`;
    if (c.disabled) line += ` [DISABLED]`;
    lines.push(line);
  }

  lines.push('');
  lines.push(
    'Main LLM Decision: Choose one candidate ref and execute your action via chrome_computer (with ref) or chrome_click_element / chrome_fill_or_select.',
  );

  return lines.join('\n');
}
