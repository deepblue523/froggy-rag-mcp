const { marked } = require('marked');

/** Mirrors `src/renderer/styles.css` `.markdown-viewer` rules for isolated iframe documents. */
const MARKDOWN_VIEWER_CSS = `
.markdown-viewer {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
  line-height: 1.6;
  color: #212121;
  margin: 0;
  padding: 14px 16px;
}
.markdown-viewer h1 {
  font-size: 28px;
  font-weight: 600;
  color: #2c3e50;
  margin: 20px 0 16px 0;
  padding-bottom: 10px;
  border-bottom: 2px solid #e0e0e0;
}
.markdown-viewer h2 {
  font-size: 24px;
  font-weight: 600;
  color: #2c3e50;
  margin: 24px 0 12px 0;
  padding-top: 8px;
}
.markdown-viewer h3 {
  font-size: 20px;
  font-weight: 600;
  color: #424242;
  margin: 20px 0 10px 0;
}
.markdown-viewer h4 {
  font-size: 16px;
  font-weight: 600;
  color: #616161;
  margin: 16px 0 8px 0;
}
.markdown-viewer p {
  margin: 12px 0;
  color: #424242;
}
.markdown-viewer ul, .markdown-viewer ol {
  margin: 12px 0;
  padding-left: 30px;
}
.markdown-viewer li {
  margin: 8px 0;
  color: #424242;
}
.markdown-viewer code {
  background: #f5f5f5;
  padding: 2px 6px;
  border-radius: 3px;
  font-family: 'Courier New', monospace;
  font-size: 13px;
  color: #d32f2f;
}
.markdown-viewer pre {
  background: #1e1e1e;
  color: #d4d4d4;
  padding: 16px;
  border-radius: 4px;
  overflow-x: auto;
  margin: 16px 0;
  font-family: 'Courier New', monospace;
  font-size: 13px;
  line-height: 1.5;
}
.markdown-viewer pre code {
  background: transparent;
  padding: 0;
  color: inherit;
  font-size: inherit;
}
.markdown-viewer strong {
  font-weight: 600;
  color: #2c3e50;
}
.markdown-viewer a {
  color: #1976d2;
  text-decoration: none;
}
.markdown-viewer a:hover {
  text-decoration: underline;
}
.markdown-viewer blockquote {
  border-left: 4px solid #1976d2;
  padding-left: 16px;
  margin: 16px 0;
  color: #616161;
  font-style: italic;
}
.markdown-viewer table {
  width: 100%;
  border-collapse: collapse;
  margin: 16px 0;
}
.markdown-viewer table th,
.markdown-viewer table td {
  padding: 8px 12px;
  border: 1px solid #e0e0e0;
  text-align: left;
}
.markdown-viewer table th {
  background: #f5f5f5;
  font-weight: 600;
  color: #424242;
}
.markdown-viewer table tr:nth-child(even) {
  background: #fafafa;
}
`;

/**
 * Full HTML document for a sandboxed iframe (no scripts; inline handlers disabled by sandbox).
 * @param {string} markdown
 * @returns {string}
 */
function markdownToViewerDocument(markdown) {
  const raw = typeof markdown === 'string' ? markdown : '';
  const inner = marked.parse(raw, { async: false });
  const body =
    typeof inner === 'string'
      ? inner
      : '<p></p>';
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><style>${MARKDOWN_VIEWER_CSS}</style></head><body class="markdown-viewer">${body}</body></html>`;
}

module.exports = { markdownToViewerDocument };
