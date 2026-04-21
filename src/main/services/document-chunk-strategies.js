/**
 * Heuristic document classification and structure-aware splitting for ingestion.
 * Optional LLM refinement is handled in document-processor via LlmChunkAdvisor.
 */

const CODE_LIKE_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.cs', '.py', '.java', '.go', '.rs',
  '.sql', '.graphql', '.proto', '.swift', '.kt', '.kts', '.rb', '.php', '.cpp', '.c', '.h',
  '.hpp', '.vue', '.svelte', '.sh', '.ps1', '.bash', '.zsh', '.dockerfile'
]);

const MARKDOWN_EXT = new Set(['.md', '.markdown', '.mdx']);

const DATA_EXT = new Set(['.json', '.yaml', '.yml']);

/**
 * @param {string} content
 * @param {{ fileType?: string, fileName?: string }} metadata
 * @returns {{ kind: string, subkind?: string, suggestedChunkSize?: number }}
 */
function detectDocumentProfile(content, metadata = {}) {
  const ext = (metadata.fileType || '').toLowerCase();
  const head = content.slice(0, 12000).trimStart();

  if (CODE_LIKE_EXT.has(ext)) {
    return { kind: 'code', subkind: ext.replace(/^\./, '') };
  }
  if (MARKDOWN_EXT.has(ext)) {
    return { kind: 'markdown' };
  }

  const jsonObj = tryParseJsonObject(content);
  if (jsonObj) {
    if (jsonObj.openapi || jsonObj.swagger) {
      if (jsonObj.paths && typeof jsonObj.paths === 'object' && !Array.isArray(jsonObj.paths)) {
        return { kind: 'openapi-json', subkind: String(jsonObj.openapi || jsonObj.swagger || ''), suggestedChunkSize: 6000 };
      }
      return { kind: 'openapi-schema-json', subkind: 'components-only', suggestedChunkSize: 4000 };
    }
    if (Array.isArray(jsonObj)) {
      return { kind: 'json-array', suggestedChunkSize: 3500 };
    }
    return { kind: 'json-object', suggestedChunkSize: 3500 };
  }

  if (DATA_EXT.has(ext) || looksLikeYaml(head)) {
    if (isLikelyOpenApiYaml(content)) {
      return { kind: 'openapi-yaml', suggestedChunkSize: 6000 };
    }
    if (ext === '.yaml' || ext === '.yml' || head.includes('---')) {
      return { kind: 'yaml-generic', suggestedChunkSize: 3000 };
    }
  }

  if (ext === '.csv' || ext === '.xlsx') {
    return { kind: 'tabular', suggestedChunkSize: 4000 };
  }

  if ((ext === '.txt' || ext === '') && content.length < 500000) {
    const jTxt = tryParseJsonObject(content);
    if (jTxt && typeof jTxt === 'object') {
      if (!Array.isArray(jTxt) && (jTxt.openapi || jTxt.swagger)) {
        if (jTxt.paths && typeof jTxt.paths === 'object' && !Array.isArray(jTxt.paths)) {
          return { kind: 'openapi-json', subkind: 'from-txt', suggestedChunkSize: 6000 };
        }
        return { kind: 'openapi-schema-json', subkind: 'from-txt', suggestedChunkSize: 4000 };
      }
      if (Array.isArray(jTxt)) return { kind: 'json-array', subkind: 'from-txt', suggestedChunkSize: 3500 };
      if (!Array.isArray(jTxt)) return { kind: 'json-object', subkind: 'from-txt', suggestedChunkSize: 3500 };
    }
  }

  return { kind: 'prose', subkind: ext || 'unknown' };
}

function tryParseJsonObject(text) {
  const t = text.trim();
  if (!t || (t[0] !== '{' && t[0] !== '[')) return null;
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

function looksLikeYaml(head) {
  return /(^|\n)(openapi|swagger)\s*:\s*['"]?3/i.test(head) || /(^|\n)paths\s*:/m.test(head);
}

function isLikelyOpenApiYaml(text) {
  const h = text.slice(0, 6000);
  return /(^|\n)openapi\s*:/m.test(h) || /(^|\n)swagger\s*:/m.test(h);
}

/**
 * Split OpenAPI JSON into one string per path (all methods + shared path item).
 * @param {string} content raw JSON text
 * @returns {string[] | null}
 */
function splitOpenApiJsonByPath(content) {
  const root = tryParseJsonObject(content);
  if (!root || typeof root !== 'object' || Array.isArray(root)) return null;
  if (!root.paths || typeof root.paths !== 'object') return null;

  const base = { ...root };
  delete base.paths;

  const pieces = [];
  for (const pathKey of Object.keys(root.paths)) {
    const slice = {
      ...base,
      paths: { [pathKey]: root.paths[pathKey] }
    };
    try {
      pieces.push(JSON.stringify(slice, null, 2));
    } catch {
      pieces.push(`${pathKey}\n${JSON.stringify(root.paths[pathKey], null, 2)}`);
    }
  }
  return pieces.length ? pieces : null;
}

/**
 * Best-effort OpenAPI YAML: split on top-level path entries under `paths:`.
 * @param {string} content
 * @returns {string[] | null}
 */
function splitOpenApiYamlByPath(content) {
  const pathsMatch = content.match(/^\s*paths\s*:/m);
  if (!pathsMatch || pathsMatch.index == null) return null;
  const start = pathsMatch.index;
  const tail = content.slice(start);
  const blocks = tail.split(/(?=\n {2}\/[^\s:]+:\s*(?:#.*)?$)/m).filter((b) => b.trim().length > 0);
  if (blocks.length <= 1) {
    const alt = tail.split(/(?=\n\s{2}\/)/g).filter((b) => b.trim().length > 10);
    if (alt.length <= 1) return [content];
    return alt.map((b) => content.slice(0, start) + b.trimEnd());
  }
  const preamble = content.slice(0, start).trimEnd();
  return blocks.map((b) => (preamble ? `${preamble}\n\n${b.trim()}` : b.trim()));
}

/**
 * @param {string} content
 * @param {{ kind: string }} profile
 * @returns {string[] | null} logical units (may still be large)
 */
function splitStructuredUnits(content, profile) {
  if (profile.kind === 'openapi-json') {
    const p = splitOpenApiJsonByPath(content);
    if (p && p.length) return p;
    return null;
  }
  if (profile.kind === 'openapi-yaml') {
    const p = splitOpenApiYamlByPath(content);
    if (p && p.length) return p;
    return null;
  }

  const j = tryParseJsonObject(content);
  if (j && typeof j === 'object' && !Array.isArray(j)) {
    if (profile.kind === 'json-object' || profile.kind === 'openapi-schema-json') {
      const keys = Object.keys(j);
      if (keys.length === 0) return null;
      const units = [];
      for (const k of keys) {
        try {
          units.push(`${k}\n${JSON.stringify(j[k], null, 2)}`);
        } catch {
          units.push(`${k}\n${String(j[k])}`);
        }
      }
      return units;
    }
  }

  if (Array.isArray(j) && j.length > 0 && profile.kind === 'json-array') {
    const units = [];
    for (let i = 0; i < j.length; i++) {
      try {
        units.push(JSON.stringify(j[i], null, 2));
      } catch {
        units.push(String(j[i]));
      }
    }
    return units;
  }

  if (profile.kind === 'markdown') {
    return splitMarkdownSections(content);
  }

  if (profile.kind === 'code') {
    return splitCodeUnits(content);
  }

  return null;
}

function splitMarkdownSections(text) {
  const lines = text.split(/\r?\n/);
  const units = [];
  let buf = [];
  for (const line of lines) {
    if (/^#{1,6}\s+/.test(line) && buf.length > 0) {
      units.push(buf.join('\n'));
      buf = [line];
    } else {
      buf.push(line);
    }
  }
  if (buf.length) units.push(buf.join('\n'));
  const merged = units.map((u) => u.trim()).filter(Boolean);
  return merged.length ? merged : [text];
}

function splitCodeUnits(text) {
  const blocks = text.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  if (blocks.length <= 1) return splitCodeByAnchors(text);
  return blocks;
}

/** Split on lines that often start a new logical unit in source code. */
function splitCodeByAnchors(text) {
  const anchor = /^(export\s+(default\s+)?|async\s+function\s+\w|function\s+\w|class\s+\w|interface\s+\w|type\s+\w|enum\s+\w|#\w+)/m;
  const lines = text.split(/\r?\n/);
  const units = [];
  let buf = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (buf.length > 0 && anchor.test(line)) {
      units.push(buf.join('\n'));
      buf = [line];
    } else {
      buf.push(line);
    }
  }
  if (buf.length) units.push(buf.join('\n'));
  const out = units.map((u) => u.trim()).filter(Boolean);
  return out.length ? out : [text];
}

/**
 * If a unit exceeds maxChars, subdivide with sentence-ish boundaries.
 * @param {string} unit
 * @param {number} maxChars
 * @param {(t: string) => string[]} splitSentences
 * @returns {string[]}
 */
function subdivideUnit(unit, maxChars, splitSentences) {
  if (unit.length <= maxChars) return [unit];
  const sentences = splitSentences(unit);
  if (sentences.length <= 1) {
    const chunks = [];
    for (let i = 0; i < unit.length; i += maxChars) {
      chunks.push(unit.slice(i, i + maxChars));
    }
    return chunks;
  }
  const out = [];
  let buf = [];
  let len = 0;
  for (const s of sentences) {
    const add = s.length + (buf.length ? 1 : 0);
    if (len + add > maxChars && buf.length > 0) {
      out.push(buf.join(' '));
      buf = [s];
      len = s.length;
    } else {
      buf.push(s);
      len += add;
    }
  }
  if (buf.length) out.push(buf.join(' '));
  return out;
}

module.exports = {
  CODE_LIKE_EXT,
  MARKDOWN_EXT,
  DATA_EXT,
  detectDocumentProfile,
  splitStructuredUnits,
  subdivideUnit
};
