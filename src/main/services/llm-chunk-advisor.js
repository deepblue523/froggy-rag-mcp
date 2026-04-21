/**
 * Optional small-LLM helper for chunking: OpenAI-compatible chat or Ollama.
 * Disabled when base URL or model is missing.
 */

const DEFAULT_TIMEOUT_MS = 45000;

function stripJsonFence(text) {
  let s = String(text || '').trim();
  if (s.startsWith('```')) {
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  }
  return s.trim();
}

function isOllamaUrl(baseUrl) {
  return /11434|ollama/i.test(baseUrl);
}

/**
 * @param {object} settings
 * @param {boolean} [settings.chunkingLlmEnabled]
 * @param {string} [settings.chunkingLlmBaseUrl]
 * @param {string} [settings.chunkingLlmModel]
 * @param {string} [settings.chunkingLlmApiKey]
 * @param {number} [settings.chunkingLlmTimeoutMs]
 */
function createLlmChunkAdvisor(settings) {
  if (!settings || settings.chunkingLlmEnabled !== true) return null;
  const baseUrl = String(settings.chunkingLlmBaseUrl || '').trim().replace(/\/+$/, '');
  const model = String(settings.chunkingLlmModel || '').trim();
  if (!baseUrl || !model) return null;

  const apiKey = settings.chunkingLlmApiKey ? String(settings.chunkingLlmApiKey) : '';
  const timeoutMs = Number(settings.chunkingLlmTimeoutMs) || DEFAULT_TIMEOUT_MS;
  const ollama = isOllamaUrl(baseUrl);

  async function chatJson(system, user) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
      if (ollama) {
        const url = `${baseUrl}/api/chat`;
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            stream: false,
            format: 'json',
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: user }
            ]
          }),
          signal: controller.signal
        });
        if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
        const data = await res.json();
        const raw = data.message?.content ?? data.response ?? '';
        return JSON.parse(stripJsonFence(raw));
      }

      const url = `${baseUrl}/v1/chat/completions`;
      const headers = { 'Content-Type': 'application/json' };
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model,
          temperature: 0,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user }
          ]
        }),
        signal: controller.signal
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`Chat HTTP ${res.status} ${errText.slice(0, 200)}`);
      }
      const data = await res.json();
      const raw = data.choices?.[0]?.message?.content ?? '';
      return JSON.parse(stripJsonFence(raw));
    } finally {
      clearTimeout(t);
    }
  }

  return {
    /**
     * Refine document kind / whether to keep as one chunk / target size.
     * @param {string} content
     * @param {{ fileName?: string, fileType?: string }} metadata
     * @param {{ kind: string, subkind?: string }} heuristic
     */
    async refineProfile(content, metadata, heuristic) {
      const snippet = content.slice(0, 4000);
      const user = [
        `File: ${metadata.fileName || 'unknown'}`,
        `Extension: ${metadata.fileType || ''}`,
        `Heuristic classification: ${JSON.stringify(heuristic)}`,
        'Document beginning:',
        '---',
        snippet,
        '---',
        'Reply with JSON only: {"kind":"string","subkind":"string|null","useWholeDocument":boolean,',
        '"suggestedMaxChars":number,"notes":"short string"}.',
        'Kinds should be one of: prose, markdown, code, openapi-json, openapi-yaml, json-object, json-array, yaml-generic, tabular.',
        'useWholeDocument true if splitting would harm retrieval (tiny doc, cohesive spec, etc.).'
      ].join('\n');

      const system =
        'You classify documents for RAG chunking. Output compact JSON only, no markdown.';

      try {
        const out = await chatJson(system, user);
        if (!out || typeof out !== 'object') return null;
        return {
          kind: typeof out.kind === 'string' ? out.kind : heuristic.kind,
          subkind: out.subkind ?? heuristic.subkind,
          useWholeDocument: out.useWholeDocument === true,
          suggestedMaxChars:
            typeof out.suggestedMaxChars === 'number' && out.suggestedMaxChars > 200
              ? Math.min(out.suggestedMaxChars, 32000)
              : undefined,
          llmNotes: typeof out.notes === 'string' ? out.notes : undefined
        };
      } catch (e) {
        console.warn('[LlmChunkAdvisor] refineProfile failed:', e.message);
        return null;
      }
    },

    /**
     * Given paragraph blocks, return indices (1..n-1) where a seam (new chunk) should start.
     * @param {string[]} paragraphs
     * @returns {Promise<number[]|null>} indices after which a break occurs (break before paragraphs[i])
     */
    async seamIndicesAfterParagraphs(paragraphs) {
      if (!paragraphs || paragraphs.length < 3) return null;
      const maxBlocks = 24;
      const blocks = paragraphs.slice(0, maxBlocks);
      const numbered = blocks.map((p, i) => `###${i}\n${p.slice(0, 1200)}`).join('\n\n');

      const user = [
        'Each section starts with ###N where N is the paragraph index (0-based).',
        'Decide where a NEW chunk should begin (topic shift).',
        'Return JSON only: {"breakBeforeIndices":[number,...]} — indices in 1..length-1 where a chunk boundary should occur before that paragraph.',
        'Use few breaks; merge related paragraphs.',
        numbered
      ].join('\n\n');

      const system =
        'You find topic boundaries between paragraphs for RAG. Output JSON only: {"breakBeforeIndices":[...]}';

      try {
        const out = await chatJson(system, user);
        const arr = out?.breakBeforeIndices;
        if (!Array.isArray(arr)) return null;
        return arr
          .map((x) => Number(x))
          .filter((n) => Number.isInteger(n) && n >= 1 && n < blocks.length);
      } catch (e) {
        console.warn('[LlmChunkAdvisor] seamIndices failed:', e.message);
        return null;
      }
    }
  };
}

module.exports = { createLlmChunkAdvisor, stripJsonFence };
