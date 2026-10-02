// 用 GitHub REST API 发布本仓库 —— 绕开时通时断的 github.com。
//
// 为什么不用 git push：某些网络下 github.com（网页/OAuth）经常超时，而
// api.github.com 稳定。建仓库、传文件、建提交、打 tag、建 Release 都能走 REST。
// 附带解决一个硬限制：**空仓库不能用 Git Data API 建 blob**（409），
// 必须先用 Contents API 落一个文件引导。
//
// 用法（在包根目录执行）：
//   node tools/publish-to-github.mjs --dry-run            # 只列文件，不写任何东西
//   GH_TOKEN=<PAT> node tools/publish-to-github.mjs       # 建/更新仓库
//   GH_TOKEN=<PAT> node tools/publish-to-github.mjs --release
//   GH_TOKEN=<PAT> node tools/publish-to-github.mjs --release --force-tag
//
// PAT 需要 repo 与 workflow 两个 scope（仓库里有 .github/workflows/* 时必须）。
// owner/repo 默认从 package.json 的 repository 字段解析，可用 --owner/--repo 覆盖。

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  return hit.includes('=') ? hit.split('=').slice(1).join('=') : true;
};

function parseRepo() {
  const url = (pkg.repository && (pkg.repository.url || pkg.repository)) || pkg.homepage || '';
  const m = /github\.com[/:]([^/]+)\/([^/.#]+)/.exec(String(url));
  return m ? { owner: m[1], repo: m[2] } : { owner: null, repo: null };
}
const parsed = parseRepo();
const OWNER = String(arg('owner', process.env.GH_OWNER || parsed.owner || ''));
const REPO = String(arg('repo', process.env.GH_REPO || parsed.repo || pkg.name));
const DESCRIPTION = String(arg('description', pkg.description || ''));
const TOPICS = (pkg.keywords || [])
  .map((k) => String(k).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, ''))
  .filter((k) => k && k.length <= 50)
  .slice(0, 20);
const DRY = process.argv.includes('--dry-run');
const FORCE_TAG = process.argv.includes('--force-tag');
const releaseArg = process.argv.find((a) => a === '--release' || a.startsWith('--release='));
const RELEASE_TAG = releaseArg
  ? (String(releaseArg).includes('=') ? String(releaseArg).split('=')[1] : `v${pkg.version}`)
  : null;
const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';

if (!OWNER) {
  console.error('无法确定 owner：请在 package.json 里写 repository，或用 --owner=<user>');
  process.exit(2);
}

const SKIP = new Set(['.git', '.tmp', 'node_modules', '.DS_Store']);
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    if (name.startsWith('.') && name !== '.github' && name !== '.gitignore') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(relative(ROOT, full).split(sep).join('/'));
  }
  return out;
}

async function api(method, path, body) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${TOKEN}`,
      'user-agent': `${pkg.name}-publish`,
      ...(body ? { 'content-type': 'application/json' } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  if (!res.ok) {
    const detail = typeof json === 'object' ? JSON.stringify(json).slice(0, 300) : String(json).slice(0, 300);
    const hint = res.status === 403 ? '  ← 多半是 PAT 少了 workflow scope（仓库含 .github/workflows/*）' : '';
    const err = new Error(`${method} ${path} -> ${res.status} ${detail}${hint}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

const files = walk(ROOT).sort();
console.log(`包根  : ${ROOT}`);
console.log(`目标  : ${OWNER}/${REPO}（${files.length} 个文件）`);
if (DRY) {
  for (const f of files) console.log('  ', f);
  console.log(`\n--dry-run：未做任何网络写操作。topics 将是: ${TOPICS.join(', ') || '(无)'}`);
  process.exit(0);
}
if (!TOKEN) {
  console.error('缺少 GH_TOKEN：请用 GH_TOKEN=<PAT> 运行（需 repo + workflow scope）');
  process.exit(2);
}

const me = await api('GET', '/user');
console.log(`已认证为 ${me.login}`);

// 1) 仓库（存在则复用）
let repo;
try {
  repo = await api('POST', '/user/repos', {
    name: REPO,
    description: DESCRIPTION,
    homepage: `https://github.com/${OWNER}/${REPO}`,
    private: false,
    has_issues: true,
    has_wiki: false,
    has_projects: false,
    auto_init: false
  });
  console.log(`✓ 已创建仓库 ${repo.full_name}`);
} catch (err) {
  if (err.status !== 422) throw err;
  repo = await api('GET', `/repos/${OWNER}/${REPO}`);
  console.log(`· 仓库已存在，复用 ${repo.full_name}`);
}

// 2) 分支头（空仓库先用 Contents API 引导）
const branch = repo.default_branch || 'main';
let parentSha = null;
let baseTree = null;
async function readHead() {
  try {
    const ref = await api('GET', `/repos/${OWNER}/${REPO}/git/ref/heads/${branch}`);
    parentSha = ref.object.sha;
    const commit = await api('GET', `/repos/${OWNER}/${REPO}/git/commits/${parentSha}`);
    baseTree = commit.tree.sha;
    return true;
  } catch (err) {
    if (err.status === 404 || err.status === 409) return false;
    throw err;
  }
}
if (await readHead()) {
  console.log(`· ${branch} 当前指向 ${parentSha.slice(0, 7)}`);
} else {
  console.log(`· 仓库还是空的：先用 Contents API 引导 ${branch}（空仓库不允许直接建 blob）`);
  const seedPath = 'README.md';
  await api('PUT', `/repos/${OWNER}/${REPO}/contents/${seedPath}`, {
    message: 'chore: initialize repository',
    content: readFileSync(join(ROOT, seedPath)).toString('base64')
  });
  if (!(await readHead())) throw new Error(`引导之后仍然读不到 ${branch}`);
  console.log(`· 引导提交 ${parentSha.slice(0, 7)} 已建立`);
}

// 3) 逐文件建 blob
const tree = [];
for (const file of files) {
  const blob = await api('POST', `/repos/${OWNER}/${REPO}/git/blobs`, {
    content: readFileSync(join(ROOT, file)).toString('base64'),
    encoding: 'base64'
  });
  tree.push({ path: file, mode: '100644', type: 'blob', sha: blob.sha });
  console.log(`  ↑ ${file}`);
}

// 4) tree + commit + 移动分支
const newTree = await api('POST', `/repos/${OWNER}/${REPO}/git/trees`, {
  ...(baseTree ? { base_tree: baseTree } : {}),
  tree
});
const message = `${pkg.name}@${pkg.version}\n\nPublished from the local repository via the GitHub REST API.`;
const commit = await api('POST', `/repos/${OWNER}/${REPO}/git/commits`, {
  message,
  tree: newTree.sha,
  ...(parentSha ? { parents: [parentSha] } : {})
});
await api('PATCH', `/repos/${OWNER}/${REPO}/git/refs/heads/${branch}`, { sha: commit.sha, force: false });
console.log(`✓ ${branch} 已更新到 ${commit.sha.slice(0, 7)}`);

// 5) topics（影响插件市场/搜索的发现）
if (TOPICS.length) {
  await api('PUT', `/repos/${OWNER}/${REPO}/topics`, { names: TOPICS });
  console.log(`✓ topics: ${TOPICS.join(', ')}`);
}

// 6) 可选：tag + Release（正文取 CHANGELOG 里对应版本那一段）
if (RELEASE_TAG) {
  const changelog = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8');
  const version = RELEASE_TAG.replace(/^v/, '');
  const start = changelog.indexOf(`## ${version}`);
  let body = changelog.slice(0, 1500);
  if (start !== -1) {
    const next = changelog.indexOf('\n## ', start + 1);
    body = changelog.slice(start, next === -1 ? undefined : next).trim();
  }

  let tagRef = null;
  try {
    tagRef = await api('GET', `/repos/${OWNER}/${REPO}/git/ref/tags/${RELEASE_TAG}`);
  } catch (err) {
    if (err.status !== 404 && err.status !== 409) throw err;
  }
  if (!tagRef) {
    await api('POST', `/repos/${OWNER}/${REPO}/git/refs`, { ref: `refs/tags/${RELEASE_TAG}`, sha: commit.sha });
    console.log(`✓ 已打 tag ${RELEASE_TAG} -> ${commit.sha.slice(0, 7)}`);
  } else if (tagRef.object.sha === commit.sha) {
    console.log(`· tag ${RELEASE_TAG} 已指向本次提交，跳过`);
  } else if (FORCE_TAG) {
    await api('DELETE', `/repos/${OWNER}/${REPO}/git/refs/tags/${RELEASE_TAG}`);
    await api('POST', `/repos/${OWNER}/${REPO}/git/refs`, { ref: `refs/tags/${RELEASE_TAG}`, sha: commit.sha });
    console.log(`✓ tag ${RELEASE_TAG} 已从 ${tagRef.object.sha.slice(0, 7)} 移到 ${commit.sha.slice(0, 7)}（Release 跟着走）`);
  } else {
    console.log(`! tag ${RELEASE_TAG} 现指向 ${tagRef.object.sha.slice(0, 7)}，本次提交是 ${commit.sha.slice(0, 7)}；要挪过来就加 --force-tag`);
  }

  try {
    const rel = await api('POST', `/repos/${OWNER}/${REPO}/releases`, {
      tag_name: RELEASE_TAG,
      name: RELEASE_TAG,
      body,
      draft: false,
      prerelease: false
    });
    console.log(`✓ 已发布 Release ${rel.tag_name}: ${rel.html_url}`);
  } catch (err) {
    if (err.status !== 422) throw err;
    console.log(`· Release ${RELEASE_TAG} 已存在，跳过`);
  }
} else {
  console.log('提示：加 --release 可顺带打 tag 并建 Release');
}

console.log(`\n完成：https://github.com/${OWNER}/${REPO}`);
console.log(`别人安装：dsh plugin --profile web add github:${OWNER}/${REPO}`);
