#!/usr/bin/env node
'use strict';

/**
 * Generates GitHub release notes for a tag: the matching CHANGELOG.md section first,
 * then all commits since the previous tag grouped by type with linked commit ids.
 *
 *   node .github/release-notes.js v1.9.0 > notes.md
 */

const {execFileSync} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const tag = process.argv[2];
if (!tag) {
    console.error('usage: release-notes.js <tag>');
    process.exit(1);
}

const git = (...args) => execFileSync('git', args, {encoding: 'utf8'}).trim();

const repoUrl = (() => {
    const remote = process.env.GITHUB_REPOSITORY
        ? 'https://github.com/' + process.env.GITHUB_REPOSITORY
        : git('remote', 'get-url', 'origin');
    return remote.replace(/^git@github\.com:/, 'https://github.com/').replace(/\.git$/, '');
})();

// previous tag in history (not just by name)
let previous = '';
try {
    previous = git('describe', '--tags', '--abbrev=0', tag + '^');
} catch {
    // first release
}

const range = previous ? previous + '..' + tag : tag;
const log = git('log', range, '--no-merges', '--format=%H%x1f%s%x1f%an');
const commits = log
    ? log.split('\n').map((line) => {
          const [sha, subject, author] = line.split('\x1f');
          return {sha, subject, author};
      })
    : [];

// order matters: the first matching group wins, output order is fixed below
const GROUPS = [
    {
        title: 'Tests & tooling',
        test: /^(test|tests|ci|chore|build|lint|style|refactor|perf)\b|\b(tests?|eslint|prettier|workflow|github actions|gitattributes|tooling|typings|tsc|release)\b/i,
    },
    {
        title: 'Documentation',
        test: /^(docs?|readme|changelog|roadmap)\b|\b(readme|changelog|roadmap|documentation|CLAUDE\.md)\b/i,
    },
    {title: 'Features', test: /^(feat|add|new|\d+\.\d+\.\d+)\b|^(add|implement|introduce|support)\s/i},
    {title: 'Fixes', test: /^(fix|bug|hotfix)\b|\b(fix|fixes|fixed|crash|normalize|handle|guard)\b/i},
];
const ORDER = ['Features', 'Fixes', 'Documentation', 'Tests & tooling'];
const OTHER = 'Other';
const SKIP = /^(bump version|release|v?\d+\.\d+\.\d+)$/i;

const grouped = new Map([...ORDER, OTHER].map((title) => [title, []]));
for (const c of commits) {
    if (SKIP.test(c.subject)) continue;
    const group = GROUPS.find((g) => g.test.test(c.subject));
    grouped.get(group ? group.title : OTHER).push(c);
}

function changelogSection(version) {
    // read the CHANGELOG as of the tag, so the job may run from any checkout
    let text;
    try {
        text = git('show', tag + ':CHANGELOG.md');
    } catch {
        try {
            text = fs.readFileSync(path.join(process.cwd(), 'CHANGELOG.md'), 'utf8');
        } catch {
            return '';
        }
    }
    const lines = text.split('\n');
    const start = lines.findIndex((l) => new RegExp('^## ' + version.replace(/\./g, '\\.') + '\\b').test(l));
    if (start === -1) return '';
    let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
    if (end === -1) end = lines.length;
    return (
        lines
            .slice(start + 1, end)
            .join('\n')
            .trim()
            // demote headings so they nest under the release title
            .replace(/^### /gm, '#### ')
    );
}

const out = [];
const section = changelogSection(tag.replace(/^v/, ''));
if (section) {
    out.push('## Changelog', '', section, '');
}

out.push('## Commits' + (previous ? ` since ${previous}` : ''), '');
for (const [title, list] of grouped) {
    if (!list.length) continue;
    out.push(`### ${title}`, '');
    for (const c of list) {
        const short = c.sha.slice(0, 7);
        out.push(`- ${c.subject} ([${short}](${repoUrl}/commit/${c.sha}))`);
    }
    out.push('');
}
if (previous) {
    out.push(`**Full diff**: [${previous}...${tag}](${repoUrl}/compare/${previous}...${tag})`, '');
}

process.stdout.write(out.join('\n'));
