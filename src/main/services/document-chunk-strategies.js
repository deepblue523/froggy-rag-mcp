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
    return { kind: 'markdown', suggestedChunkSize: 3200 };
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

/**
 * Split Markdown into logical units for the same pipeline as other profiles:
 * structured units → sentence-bounded subdivide → overlap merge.
 * Fence-aware (headings / rules inside fenced code do not start new sections).
 */
function splitMarkdownSections(text) {
  const lines = text.split(/\r?\n/);
  const { frontBlock, bodyLines: rawBody } = extractYamlFrontMatterLines(lines);
  const bodyLines = trimLeadingEmptyLines(rawBody);

  const starts = collectMarkdownSectionStarts(bodyLines);
  let units = sliceByLineStarts(bodyLines, starts).map((u) => u.trimEnd()).filter(Boolean);

  if (frontBlock) {
    const fb = frontBlock.trimEnd();
    if (fb) units = units.length ? [fb, ...units] : [fb];
  }

  units = coalesceStubHeadingUnits(units);

  if (units.length === 1 && units[0].length > 12000) {
    const paras = units[0].split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
    if (paras.length > 1) return paras;
  }

  return units.length ? units : [text];
}

/**
 * @param {string[]} lines
 * @returns {{ frontBlock: string | null, bodyLines: string[] }}
 */
function extractYamlFrontMatterLines(lines) {
  if (lines.length < 2) return { frontBlock: null, bodyLines: lines };
  if (lines[0].trim() !== '---') return { frontBlock: null, bodyLines: lines };
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      const frontLines = lines.slice(0, i + 1);
      const bodyLines = lines.slice(i + 1);
      return { frontBlock: frontLines.join('\n'), bodyLines };
    }
  }
  return { frontBlock: null, bodyLines: lines };
}

/** @param {string[]} lines */
function trimLeadingEmptyLines(lines) {
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i += 1;
  return i > 0 ? lines.slice(i) : lines;
}

/**
 * @param {string} line
 * @returns {{ ch: string, len: number } | null}
 */
function parseFenceStart(line) {
  const m = line.match(/^ {0,3}(`{3,}|~{3,})/);
  if (!m) return null;
  const fence = m[1];
  return { ch: fence[0], len: fence.length };
}

/** @param {string} line */
function isFenceClose(line, ch, minLen) {
  const t = line.trim();
  const run = ch === '`' ? /^`+/ : /^~+/;
  const mm = t.match(run);
  if (!mm || mm[0].length < minLen) return false;
  return t === mm[0] || t.slice(mm[0].length).trim() === '';
}

/**
 * @param {string[]} bodyLines
 * @returns {number[]} sorted unique line indices where a new section begins (0-based in bodyLines)
 */
function collectMarkdownSectionStarts(bodyLines) {
  const starts = new Set([0]);
  let inFence = null;

  for (let i = 0; i < bodyLines.length; i++) {
    const line = bodyLines[i];

    if (inFence) {
      if (isFenceClose(line, inFence.ch, inFence.len)) {
        inFence = null;
      }
      continue;
    }

    const fs = parseFenceStart(line);
    if (fs) {
      inFence = { ch: fs.ch, len: fs.len };
      continue;
    }

    if (isAtxHeadingLine(line)) {
      if (i > 0) starts.add(i);
      continue;
    }

    const setextUnderline =
      i > 0 &&
      couldBeSetextTitle(bodyLines[i - 1]) &&
      (/^ {0,3}=+\s*$/.test(line) || /^ {0,3}-{2,}\s*$/.test(line));

    if (setextUnderline) {
      starts.add(i - 1);
      continue;
    }

    if (isThematicBreakLine(line)) {
      if (i + 1 < bodyLines.length) starts.add(i + 1);
    }
  }

  return [...starts].sort((a, b) => a - b);
}

/** @param {string} line */
function isAtxHeadingLine(line) {
  return /^ {0,3}#{1,6}(?:\s|$)/.test(line);
}

/** @param {string} line */
function isThematicBreakLine(line) {
  const t = line.trim();
  if (!t) return false;
  if (/^(\*{3,}|-{3,}|_{3,})\s*$/.test(t)) return true;
  return /^(?:\* *){3,}\s*$/.test(t);
}

/** @param {string} line */
function couldBeSetextTitle(line) {
  const t = line.trimEnd();
  if (!t) return false;
  if (/^#{1,6}\s/.test(t)) return false;
  if (/^[-*+]\s/.test(t)) return false;
  if (/^\d+\.\s/.test(t)) return false;
  if (/^>\s?/.test(t)) return false;
  if (/^<{1,3}[!/]?/i.test(t)) return false;
  if (/^[-=]{2,}\s*$/.test(t)) return false;
  if (t.length > 280) return false;
  return true;
}

/**
 * @param {string[]} bodyLines
 * @param {number[]} starts
 */
function sliceByLineStarts(bodyLines, starts) {
  const sorted = [...new Set(starts)].filter((i) => i >= 0 && i < bodyLines.length).sort((a, b) => a - b);
  const units = [];
  for (let u = 0; u < sorted.length; u++) {
    const a = sorted[u];
    const b = sorted[u + 1] ?? bodyLines.length;
    if (a < b) units.push(bodyLines.slice(a, b).join('\n'));
  }
  return units;
}

/**
 * Merge isolated short heading lines into the following section so embeddings carry the heading + body.
 * @param {string[]} units
 */
function coalesceStubHeadingUnits(units) {
  if (units.length < 2) return units;
  const out = [];
  for (let i = 0; i < units.length; i++) {
    const u = units[i];
    if (
      i + 1 < units.length &&
      isStubHeadingUnit(u)
    ) {
      out.push(`${u.trimEnd()}\n\n${units[i + 1].trimEnd()}`.trimEnd());
      i += 1;
    } else {
      out.push(u);
    }
  }
  return out;
}

/** @param {string} unit */
function isStubHeadingUnit(unit) {
  const t = unit.trim();
  if (!t) return false;
  const lines = t.split(/\r?\n/);
  if (
    lines.length === 2 &&
    couldBeSetextTitle(lines[0]) &&
    /^ {0,3}[=-]+\s*$/.test(lines[1])
  ) {
    return t.length <= 400;
  }
  if (lines.length === 1 && isAtxHeadingLine(lines[0])) {
    return t.length <= 220;
  }
  return false;
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

/**
 * If a Markdown unit exceeds maxChars, subdivide on Markdown block boundaries.
 * Tables and fenced code blocks are treated as indivisible unless they alone exceed maxChars.
 * @param {string} unit
 * @param {number} maxChars
 * @param {(t: string) => string[]} splitSentences
 * @returns {string[]}
 */
function subdivideMarkdownUnit(unit, maxChars, splitSentences) {
  if (unit.length <= maxChars) return [unit];

  const blocks = splitMarkdownBlocks(unit);
  if (blocks.length <= 1) return subdivideUnit(unit, maxChars, splitSentences);

  const out = [];
  let buf = [];
  let len = 0;

  const flush = () => {
    if (!buf.length) return;
    out.push(buf.join('\n\n').trimEnd());
    buf = [];
    len = 0;
  };

  for (const block of blocks) {
    const blockLen = block.length + (buf.length ? 2 : 0);
    if (block.length > maxChars) {
      flush();
      out.push(...subdivideUnit(block, maxChars, splitSentences));
      continue;
    }
    if (len + blockLen > maxChars && buf.length > 0) {
      flush();
    }
    buf.push(block);
    len += block.length + (buf.length > 1 ? 2 : 0);
  }

  flush();
  return out.length ? out : subdivideUnit(unit, maxChars, splitSentences);
}

/** @param {string} text */
function splitMarkdownBlocks(text) {
  const lines = text.split(/\r?\n/);
  const blocks = [];
  let normal = [];
  let inFence = null;

  const flushNormal = () => {
    const block = normal.join('\n').trim();
    if (block) blocks.push(block);
    normal = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (inFence) {
      normal.push(line);
      if (isFenceClose(line, inFence.ch, inFence.len)) {
        inFence = null;
        flushNormal();
      }
      continue;
    }

    const fs = parseFenceStart(line);
    if (fs) {
      flushNormal();
      inFence = { ch: fs.ch, len: fs.len };
      normal.push(line);
      continue;
    }

    if (isMarkdownTableStart(lines, i)) {
      flushNormal();
      const tableLines = [line, lines[i + 1]];
      i += 2;
      while (i < lines.length && isMarkdownTableRow(lines[i])) {
        tableLines.push(lines[i]);
        i += 1;
      }
      i -= 1;
      blocks.push(tableLines.join('\n').trimEnd());
      continue;
    }

    if (
      i + 1 < lines.length &&
      couldBeSetextTitle(line) &&
      (/^ {0,3}=+\s*$/.test(lines[i + 1]) || /^ {0,3}-{2,}\s*$/.test(lines[i + 1]))
    ) {
      flushNormal();
      blocks.push(`${line}\n${lines[i + 1]}`.trimEnd());
      i += 1;
      continue;
    }

    if (line.trim() === '') {
      flushNormal();
      continue;
    }

    normal.push(line);
  }

  flushNormal();
  return blocks;
}

function isMarkdownTableStart(lines, index) {
  return (
    index + 1 < lines.length &&
    isMarkdownTableRow(lines[index]) &&
    isMarkdownTableDelimiter(lines[index + 1])
  );
}

/** @param {string} line */
function isMarkdownTableRow(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('>')) return false;
  return trimmed.includes('|') && !isMarkdownTableDelimiter(line);
}

/** @param {string} line */
function isMarkdownTableDelimiter(line) {
  const trimmed = line.trim();
  if (!trimmed.includes('|')) return false;
  const cells = trimmed.replace(/^\|/, '').replace(/\|$/, '').split('|');
  if (cells.length < 2) return false;
  return cells.every((cell) => /^\s*:?-{3,}:?\s*$/.test(cell));
}

module.exports = {
  CODE_LIKE_EXT,
  MARKDOWN_EXT,
  DATA_EXT,
  detectDocumentProfile,
  splitStructuredUnits,
  subdivideUnit,
  subdivideMarkdownUnit
};
