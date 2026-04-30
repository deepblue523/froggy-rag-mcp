#!/usr/bin/env node

/**
 * After electron-builder publishes assets, update the GitHub release for `tag`:
 * - Set release body from release-notes/<tag>.md (e.g. v1.3.0.md)
 * - Set as latest release (make_latest)
 *
 * Usage:
 *   node scripts/patch-github-release.js --tag v1.3.0 [--dry-run] [--allow-missing-release-notes]
 *
 * Auth: GH_TOKEN or GITHUB_TOKEN (same as electron-builder).
 */

const fs = require('fs');
const path = require('path');

const projectRoot = path.join(__dirname, '..');

function readPublishTarget() {
  const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
  const pub = pkg.build && pkg.build.publish;
  if (!pub || pub.provider !== 'github' || !pub.owner || !pub.repo) {
    return null;
  }
  return { owner: pub.owner, repo: pub.repo };
}

function parseArgs(argv) {
  const flags = new Set();
  let tag = '';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--tag' && argv[i + 1]) {
      tag = argv[++i];
    } else if (a.startsWith('--')) {
      flags.add(a);
    }
  }
  return { flags, tag };
}

async function githubFetch(url, token, { method = 'GET', body } = {}) {
  const init = {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'froggy-on-rag-release',
    },
  };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${method} ${url} -> ${res.status}: ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

/**
 * @param {{ tag: string, dryRun?: boolean, allowMissingReleaseNotes?: boolean }} opts
 */
async function patchGithubReleaseNotes(opts) {
  const target = readPublishTarget();
  if (!target) {
    console.log('package.json build.publish is not GitHub; skipping release notes update.');
    return;
  }

  const { owner, repo } = target;
  const tag = opts.tag;
  if (!tag || typeof tag !== 'string' || !/^v/.test(tag)) {
    throw new Error(`Invalid or missing --tag (expected a version tag like v1.3.0): ${tag}`);
  }

  const notesPath = path.join(projectRoot, 'release-notes', `${tag}.md`);
  let bodyText = null;
  if (fs.existsSync(notesPath)) {
    bodyText = fs.readFileSync(notesPath, 'utf8').trim();
  } else if (opts.allowMissingReleaseNotes) {
    console.warn(`No release notes at ${notesPath}; will only set make_latest.`);
  } else {
    throw new Error(
      `Missing release notes: ${notesPath}\n` +
        'Add that file before releasing, or pass --allow-missing-release-notes.',
    );
  }

  const base = `https://api.github.com/repos/${owner}/${repo}`;
  const getUrl = `${base}/releases/tags/${encodeURIComponent(tag)}`;

  if (opts.dryRun) {
    console.log(`[dry-run] GET ${getUrl}`);
    console.log(
      `[dry-run] PATCH release (make_latest: true${bodyText !== null ? `, body ${bodyText.length} chars` : ''})`,
    );
    return;
  }

  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error('Missing GH_TOKEN or GITHUB_TOKEN');
  }

  const release = await githubFetch(getUrl, token);
  const patchUrl = `${base}/releases/${release.id}`;
  const patchBody = { make_latest: 'true' };
  if (bodyText !== null) {
    patchBody.body = bodyText;
  }
  await githubFetch(patchUrl, token, { method: 'PATCH', body: patchBody });
  console.log(`Updated GitHub release ${tag}: make_latest=true${bodyText !== null ? ' and release notes from file' : ''}.`);
}

async function main() {
  const { flags, tag } = parseArgs(process.argv.slice(2));
  const dryRun = flags.has('--dry-run');
  const allowMissingReleaseNotes = flags.has('--allow-missing-release-notes');
  if (!tag) {
    console.error('Usage: node scripts/patch-github-release.js --tag v1.2.3 [--dry-run] [--allow-missing-release-notes]');
    process.exit(1);
  }
  await patchGithubReleaseNotes({ tag, dryRun, allowMissingReleaseNotes });
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e.message || e);
    process.exit(1);
  });
}

module.exports = { patchGithubReleaseNotes, readPublishTarget };
