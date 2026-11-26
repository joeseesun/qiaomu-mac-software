import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { constants } from 'node:fs';
import { access, copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify, parseArgs } from 'node:util';

const exec = promisify(execFile);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaults = ['/Applications', join(homedir(), 'Applications'), '/System/Applications'];
// QIAOMU_SOFTWARE_ORIGIN lets maintainers test against a local copy of the site; it only accepts https or loopback http.
function siteOrigin() {
  const value = process.env.QIAOMU_SOFTWARE_ORIGIN;
  if (!value) return 'https://software.qiaomu.ai';
  const url = URL.canParse(value) ? new URL(value) : null;
  if (!url || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)))) {
    throw new Error('QIAOMU_SOFTWARE_ORIGIN 只接受 https 或本机 http 地址。');
  }
  return url.origin;
}
const shareEndpoint = () => siteOrigin() + '/api/v1/shares';
const lookupEndpoint = () => siteOrigin() + '/api/v1/icons/lookup';
const iconSize = 128;
const maxIconBytes = 64 * 1024;
const maxIconTotal = 1536 * 1024;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const localDay = (value) => {
  const date = new Date(value);
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()]
    .map((part) => String(part).padStart(2, '0')).join('-');
};

function sixMonthsAgo(now) {
  const date = new Date(now);
  const maxDay = new Date(date.getFullYear(), date.getMonth() - 5, 0).getDate();
  date.setDate(1);
  date.setMonth(date.getMonth() - 6);
  date.setDate(Math.min(now.getDate(), maxDay));
  date.setHours(0, 0, 0, 0);
  return date;
}

async function readMetadata(path, keys) {
  try {
    const { stdout } = await exec('/usr/bin/mdls', [...keys.flatMap(key => ['-name', key]), path], { timeout: 4000 });
    return stdout;
  } catch { return ''; }
}

async function appPaths(root, depth = 0) {
  if (depth > 8) return [];
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const results = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const path = join(root, entry.name);
    if (entry.name.toLowerCase().endsWith('.app') && (entry.isDirectory() || entry.isSymbolicLink())) {
      results.push(path);
    } else if (entry.isDirectory()) {
      results.push(...await appPaths(path, depth + 1));
    }
  }
  return results;
}

const ROLES = ['独立开发者', '全栈开发', '前端开发', '后端开发', 'AI 工程师', '设计师', '产品经理', '内容创作者', '效率极客', '学生'];

function inferredGroup(name) {
  if (/codex|chatgpt|claude|deepseek|doubao|豆包|kimi|gemini|antigravity|workbuddy|qoder|cursor|t3 code|factory|zcode|xcode|visual studio|zed|sublime|terminal|iterm|ghostty|warp|wezterm|kitty|alacritty|cmux|orbstack|docker|tableplus|proxyman|bruno|postman|fork|tower|ollama|lm studio|cherry studio|jetbrains|webstorm|pycharm|intellij|goland|datagrip/i.test(name)) return 'AI 与开发';
  if (/chrome|firefox|safari|arc|zen|dia|brave|wechat|微信|lark|飞书|dingtalk|钉钉|telegram|edge|会议|ego lite|flclash|clash|surge|tailscale|slack|discord/i.test(name)) return '浏览与沟通';
  if (/obsidian|\bword\b|powerpoint|notion|pages|excel|notes|备忘录|anki|keynote|typora|bear|heptabase|logseq|craft|ulysses|ia writer|wps|xmind|reeder|netnewswire|readwise|ticktick|滴答|todoist|things|linear|fantastical/i.test(name)) return '写作与办公';
  if (/studio|capwise|photos|final cut|davinci|blender|录|shot|pixpin|snipaste|kap|subcast|figma|sketch|pixelmator|iina|infuse|vlc|spotify|音乐|downie|permute|handbrake/i.test(name)) return '创作';
  return '效率与工具';
}

async function readApp(path, cutoff, end) {
  try {
    const canonical = await realpath(path);
    const plist = join(canonical, 'Contents', 'Info.plist');
    const { stdout } = await exec('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', plist], { timeout: 3000 });
    const id = stdout.trim();
    if (!id) return null;
    const fallback = basename(path).replace(/\.app$/i, '');
    const data = await readMetadata(path, ['kMDItemUsedDates', 'kMDItemLastUsedDate', 'kMDItemDisplayName']);
    // Spotlight's display name follows the system language, so Chinese systems get 腾讯会议 rather than TencentMeeting.
    const display = data.match(/^kMDItemDisplayName\s*=\s*"(.+)"$/m)?.[1].replace(/\.app$/i, '').trim();
    const name = display || fallback;
    const last = data.match(/^kMDItemLastUsedDate\s*=\s*(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d [+-]\d{4})/m)?.[1];
    const lastDate = last ? localDay(last) : null;
    const observedDays = [...new Set(
      [...data.matchAll(/"(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d [+-]\d{4})"/g)]
        .map(match => localDay(match[1])).filter(date => date >= cutoff && date <= end)
    )].sort();
    return { id, name, path, group: inferredGroup(name), activeDays: observedDays.length,
      firstObservedDay: observedDays[0] ?? null, lastObservedDay: observedDays.at(-1) ?? null,
      lastUsed: lastDate && lastDate >= cutoff && lastDate <= end ? lastDate : null };
  } catch { return null; }
}

async function pool(items, handler) {
  const results = [];
  for (let i = 0; i < items.length; i += 12) {
    results.push(...await Promise.all(items.slice(i, i + 12).map(handler)));
  }
  return results.filter(Boolean);
}

async function isFile(path) {
  return (await stat(path).catch(() => null))?.isFile() === true;
}

async function readClaude(apps) {
  const command = await exec('/usr/bin/which', ['claude'], { timeout: 2500 }).catch(() => null);
  if (!command && !await isFile(join(homedir(), '.local/bin/claude'))) return;
  const claude = apps.find(app => app.id === 'com.anthropic.claudefordesktop');
  const path = claude?.path ?? '/System/Applications/Utilities/Terminal.app';
  apps.push({ id: 'cli:claude-code', name: 'Claude Code', path, group: 'AI 与开发',
    activeDays: 0, firstObservedDay: null, lastObservedDay: null, lastUsed: null, isCommandLine: true });
}

async function saveJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
}

function str(value, label, limit) {
  if (typeof value !== 'string' || !value.trim() || Array.from(value.trim()).length > limit || /[\x00-\x1f\x7f]/u.test(value)) {
    throw new Error(label + ' 应为 1–' + limit + ' 字的单行文字。');
  }
  return value.trim();
}

async function scan(values) {
  const now = new Date();
  const since = localDay(sixMonthsAgo(now));
  const until = localDay(now);
  const roots = [...defaults, ...(values.root ?? []).map(path => resolve(path))];
  const paths = (await Promise.all(roots.map(root => appPaths(root)))).flat();
  const matches = await pool([...new Set(paths)], path => readApp(path, since, until));
  const unique = new Map();
  for (const app of matches) {
    const previous = unique.get(app.id.toLowerCase());
    if (!previous || app.activeDays > previous.activeDays || (app.activeDays === previous.activeDays && (app.lastUsed ?? '') > (previous.lastUsed ?? ''))) {
      unique.set(app.id.toLowerCase(), app);
    }
  }
  const apps = [...unique.values()];
  await readClaude(apps);
  apps.sort((a, b) => b.activeDays - a.activeDays || (b.lastUsed ?? '').localeCompare(a.lastUsed ?? '') || a.name.localeCompare(b.name));
  const starts = apps.map(app => app.firstObservedDay).filter(Boolean).sort();
  const suggested = apps.filter(app => app.activeDays > 0 || app.lastUsed)
    .filter(app => !/(?:helper|installer|uninstaller|beta preview)$/i.test(app.name))
    .filter(app => !['com.apple.systempreferences','com.apple.appstore','com.apple.ActivityMonitor'].includes(app.id)).slice(0, 24);
  const folders = resolve(values.dir ?? '.');
  const selection = { title: '我推荐的 Mac 软件', year: now.getFullYear(), apps: suggested.map(({ id, name, path, group }) => ({ id, name, path, group })) };
  await saveJson(join(folders, 'inventory.json'), { since, until, earliestObservedDay: starts[0] ?? null,
    datedApps: starts.length, method: 'spotlight-observed-active-days', roots, apps });
  await saveJson(join(folders, 'selection.json'), selection);
  console.log(JSON.stringify({ installed: apps.length, recommended: suggested.length, since, until,
    earliestObservedDay: starts[0] ?? null, datedApps: starts.length, directory: folders }));
}

async function readSelection(filename) {
  const input = JSON.parse(await readFile(filename, 'utf8'));
  if (!Array.isArray(input.apps) || input.apps.length < 1 || input.apps.length > 48) throw new Error('请选择 1–48 个应用。');
  const title = str(input.title, '标题', 34);
  const year = input.year === null || input.year === false ? 0 : Number(input.year ?? new Date().getFullYear());
  if (year !== 0 && (!Number.isInteger(year) || year < 1900 || year > 2200)) throw new Error('年份无效。');
  const ids = new Set();
  const groups = new Set();
  const apps = input.apps.map(({ id, path, name, group, note }) => {
    id = str(id, '应用 ID', 128);
    group = str(group, '分类', 14);
    if (!isAbsolute(path ?? '') || !path.toLowerCase().endsWith('.app')) throw new Error('应用路径必须指向本机 .app。');
    if (ids.has(id)) throw new Error('应用重复：' + id);
    ids.add(id);
    groups.add(group);
    const app = { id, path, name: str(name, '应用名称', 60), group };
    if (note !== undefined && note !== null && String(note).trim()) app.note = str(note, '推荐理由', 60);
    return app;
  });
  if (groups.size > 7) throw new Error('最多使用七个分类。');
  const author = input.author ? str(input.author, '署名', 40) : '';
  const role = input.role ? str(input.role, '身份标签', 16) : '';
  return { title, year, author, role, apps };
}

// Writes each selected app's 128px icon next to the poster, named by its SHA-256 so the site can deduplicate.
async function exportIcons(apps, folder) {
  await mkdir(folder, { recursive: true });
  const temporary = await mkdtemp(join(folder, '.export-'));
  try {
    const list = apps.map((app, index) => ({ path: app.path, file: index + '.png' }));
    await exec('/usr/bin/osascript', ['-l', 'JavaScript', join(scriptDir, 'icons.js'), JSON.stringify(list), temporary, String(iconSize)], { timeout: 45000 });
    const hashes = [];
    for (const { file } of list) {
      const bytes = await readFile(join(temporary, file)).catch(() => null);
      if (!bytes || bytes.length > maxIconBytes) { hashes.push(null); continue; }
      const hash = sha256(bytes);
      await writeFile(join(folder, hash + '.png'), bytes, { mode: 0o600 });
      hashes.push(hash);
    }
    return hashes;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

// Serves a local picker page so people can choose apps with their real icons, adjust groups and write reasons.
// Everything stays on this machine; saving only rewrites selection.json.
async function pick(values) {
  const dir = resolve(values.dir ?? '.');
  const inventory = JSON.parse(await readFile(join(dir, 'inventory.json'), 'utf8').catch(() => {
    throw new Error('没有找到 inventory.json，请先运行 scan。');
  }));
  const apps = Array.isArray(inventory.apps) ? inventory.apps : [];
  if (!apps.length) throw new Error('inventory.json 中没有应用。');
  const iconDir = join(dir, 'picker-icons');
  await mkdir(iconDir, { recursive: true });
  const list = apps.map((app, index) => ({ path: app.path, file: index + '.png' }));
  await exec('/usr/bin/osascript', ['-l', 'JavaScript', join(scriptDir, 'icons.js'), JSON.stringify(list), iconDir, '96'], { timeout: 180000 }).catch(() => {});
  let previous = {};
  try { previous = JSON.parse(await readFile(join(dir, 'selection.json'), 'utf8')); } catch {}
  const payload = {
    title: typeof previous.title === 'string' ? previous.title : '我推荐的 Mac 软件',
    year: previous.year === null || previous.year === false ? 0 : (Number(previous.year) || new Date().getFullYear()),
    author: typeof previous.author === 'string' ? previous.author : '',
    role: typeof previous.role === 'string' ? previous.role : '',
    roles: ROLES,
    apps: apps.map((app, index) => ({ index, id: app.id, name: app.name, group: app.group, activeDays: app.activeDays ?? 0 })),
    selected: Array.isArray(previous.apps) ? previous.apps.map(app => ({ id: app.id, group: app.group, note: app.note ?? '' })) : [],
  };
  const token = randomBytes(12).toString('hex');
  let settle;
  const done = new Promise((resolvePromise, rejectPromise) => { settle = { resolve: resolvePromise, reject: rejectPromise }; });
  const timer = setTimeout(() => settle.reject(new Error('等待保存超时（30 分钟）。')), 30 * 60 * 1000);
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.searchParams.get('token') !== token) { res.writeHead(403).end('forbidden'); return; }
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(pickerPage(payload, token));
      return;
    }
    const iconMatch = url.pathname.match(/^\/icon\/(\d{1,4})\.png$/);
    if (req.method === 'GET' && iconMatch) {
      readFile(join(iconDir, iconMatch[1] + '.png')).then(bytes => {
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'immutable' });
        res.end(bytes);
      }, () => res.writeHead(404).end());
      return;
    }
    if (req.method === 'POST' && url.pathname === '/save') {
      let body = '';
      req.on('data', chunk => { body += chunk; if (body.length > 262144) req.destroy(); });
      req.on('end', async () => {
        try {
          const input = JSON.parse(body);
          const byIndex = new Map(apps.map((app, index) => [index, app]));
          const seen = new Set();
          const chosen = [];
          for (const item of Array.isArray(input.apps) ? input.apps : []) {
            const app = byIndex.get(Number(item.index));
            if (!app || seen.has(app.id)) continue;
            seen.add(app.id);
            chosen.push({ id: app.id, name: app.name, path: app.path,
              group: String(item.group ?? '').trim() || app.group,
              ...(String(item.note ?? '').trim() ? { note: String(item.note).trim() } : {}) });
          }
          const selection = { title: String(input.title ?? '').trim() || '我推荐的 Mac 软件',
            year: Number(input.year) > 0 ? Number(input.year) : null,
            ...(String(input.author ?? '').trim() ? { author: String(input.author).trim() } : {}),
            ...(String(input.role ?? '').trim() ? { role: String(input.role).trim() } : {}),
            apps: chosen };
          const temp = join(dir, '.selection-check.json');
          await writeFile(temp, JSON.stringify(selection));
          const checked = await readSelection(temp).finally(() => rm(temp, { force: true }));
          const finalSelection = { title: checked.title, year: checked.year || null,
            ...(checked.author ? { author: checked.author } : {}),
            ...(checked.role ? { role: checked.role } : {}), apps: checked.apps };
          await writeFile(join(dir, 'selection.json'), JSON.stringify(finalSelection, null, 2) + '\n', { mode: 0o600 });
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, apps: checked.apps.length }));
          clearTimeout(timer);
          server.close();
          settle.resolve({ saved: join(dir, 'selection.json'), apps: checked.apps.length,
            notes: checked.apps.filter(app => app.note).length });
        } catch (error) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: error.message }));
        }
      });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((ok, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', ok); });
  console.log(JSON.stringify({ url: 'http://127.0.0.1:' + server.address().port + '/?token=' + token, waiting: true }));
  console.log(JSON.stringify(await done));
}

function pickerPage(payload, token) {
  const data = JSON.stringify(payload).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>挑选要推荐的软件</title>
<style>
:root{color-scheme:dark;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif}
*{box-sizing:border-box}
body{margin:0;background:#0c0e12;color:rgba(255,255,255,.88);font-size:15px;line-height:1.6}
.wrap{width:min(1080px,calc(100% - 32px));margin-inline:auto}
.bar{position:sticky;top:0;z-index:10;background:rgba(12,14,18,.85);backdrop-filter:blur(14px);border-bottom:1px solid rgba(255,255,255,.09)}
.bar-in{display:flex;align-items:center;gap:14px;min-height:60px}
h1{font-size:1.1rem;margin:0;font-weight:600;color:#fff}
.count{margin-left:auto;color:rgba(255,255,255,.66);font-variant-numeric:tabular-nums;white-space:nowrap}
.save{border:0;border-radius:999px;background:linear-gradient(180deg,#ffc463,#ffa628);color:#241503;font-weight:600;font-size:.92rem;padding:8px 18px;cursor:pointer;white-space:nowrap}
.save:disabled{opacity:.55;cursor:progress}
main{padding:20px 0 120px}
.panel{display:flex;flex-wrap:wrap;gap:14px 24px;padding:16px 18px;border:1px solid rgba(255,255,255,.09);border-radius:14px;background:#171a21;margin-bottom:14px}
.panel label{display:grid;gap:4px;font-size:.82rem;color:rgba(255,255,255,.62)}
input[type=text],input[type=number],input[type=search]{background:#20242e;border:1px solid rgba(255,255,255,.14);border-radius:9px;color:#fff;padding:7px 11px;font:inherit;font-size:.92rem;min-height:36px}
input:focus-visible{outline:2px solid #ffb547;outline-offset:0}
#title{width:260px}
#author{width:180px}
.yr span{display:flex;align-items:center;gap:8px}
.yr input[type=checkbox]{width:16px;height:16px;accent-color:#ffb547}
#year{width:88px}
.tools{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin-bottom:16px}
#q{width:220px}
.chips{display:inline-flex;flex-wrap:wrap;gap:6px}
.chip{border:1px solid rgba(255,255,255,.14);background:#171a21;color:rgba(255,255,255,.66);border-radius:999px;padding:4px 12px;font-size:.85rem;cursor:pointer}
.chip.on{background:rgba(255,181,71,.14);color:#ffb547;border-color:transparent}
.ghost{border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.06);color:#fff;border-radius:9px;padding:6px 12px;font-size:.85rem;cursor:pointer}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,240px),1fr));gap:10px}
.card{display:grid;grid-template-columns:auto auto minmax(0,1fr);gap:2px 10px;align-items:center;padding:12px;border-radius:12px;border:1px solid rgba(255,255,255,.09);background:#171a21;cursor:pointer;transition:border-color .15s,background-color .15s}
.card .check{width:18px;height:18px;border-radius:50%;border:1.5px solid rgba(255,255,255,.3);display:grid;place-items:center;font-size:11px;color:transparent}
.card img{width:36px;height:36px;border-radius:8px}
.card .nm{font-weight:600;color:#fff;font-size:.95rem;overflow-wrap:anywhere}
.card .days{grid-column:2/4;color:rgba(255,255,255,.5);font-size:.78rem}
.card .grp,.card .note{display:none;grid-column:1/4;width:100%;margin-top:8px;font-size:.85rem}
.card.on{border-color:rgba(255,181,71,.6);background:rgba(255,181,71,.07)}
.card.on .check{background:#ffb547;border-color:#ffb547;color:#241503}
.card.on .grp,.card.on .note{display:block}
.hint{color:rgba(255,255,255,.5);font-size:.85rem;margin-top:18px}
.toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%) translateY(20px);background:#20242e;border:1px solid rgba(255,255,255,.16);color:#fff;padding:10px 18px;border-radius:10px;opacity:0;pointer-events:none;transition:opacity .2s,transform .2s;max-width:calc(100% - 48px)}
.toast.show{opacity:1;transform:translateX(-50%)}
.done{position:fixed;inset:0;display:none;place-items:center;background:rgba(12,14,18,.94);z-index:20;text-align:center}
.done.show{display:grid}
.done h2{color:#fff;margin:0 0 8px}
.done p{color:rgba(255,255,255,.66)}
</style>
</head>
<body>
<header class="bar"><div class="wrap bar-in">
<h1>挑选要推荐的软件</h1>
<span class="count" id="count"></span>
<button class="save" id="save">保存并继续</button>
</div></header>
<main class="wrap">
<section class="panel">
<label>海报标题<input id="title" type="text" maxlength="34"></label>
<label class="yr">含年份<span><input type="checkbox" id="useYear"><input id="year" type="number" min="1900" max="2200"></span></label>
<label>署名（可选）<input id="author" type="text" maxlength="40" placeholder="印在海报左下角"></label>
<label>身份标签（可选）<input id="role" type="text" maxlength="16" list="roles" placeholder="如：独立开发者、设计师"></label>
</section>
<datalist id="roles"></datalist>
<section class="tools">
<input id="q" type="search" placeholder="搜索软件名">
<span class="chips" id="chips"></span>
<button class="ghost" id="top">选中前 24 个活跃候选</button>
<button class="ghost" id="clear">清空</button>
</section>
<section class="grid" id="grid"></section>
<p class="hint">勾选、分组和理由只写入本机 selection.json，保存前不会发送任何网络请求。保存后请回到助手，让它继续生成海报。</p>
</main>
<datalist id="groups"></datalist>
<div class="toast" id="toast"></div>
<div class="done" id="done"><div><h2>已保存选择</h2><p>可以关闭此页面，回到助手继续生成海报。</p></div></div>
<script>
var DATA = ${data};
var TOKEN = ${JSON.stringify(token)};
var state = new Map();
var byId = {};
DATA.apps.forEach(function(a){ byId[a.id] = a; });
DATA.selected.forEach(function(s){
  var a = byId[s.id];
  if (a) state.set(a.index, { group: s.group || a.group, note: s.note || '' });
});
function esc(s){ return String(s).replace(/[&<>"]/g, function(c){ return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
var toastTimer;
function toast(msg){
  var el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function(){ el.classList.remove('show'); }, 2600);
}
function updateCount(){
  var notes = 0;
  state.forEach(function(s){ if (s.note && s.note.trim()) notes++; });
  document.getElementById('count').textContent = '已选 ' + state.size + ' / 48' + (notes ? ' · 已写 ' + notes + ' 条理由' : '');
}
var grid = document.getElementById('grid');
var cards = [];
DATA.apps.forEach(function(app){
  var sel = state.get(app.index);
  var card = document.createElement('div');
  card.className = 'card' + (sel ? ' on' : '');
  var img = document.createElement('img');
  img.src = '/icon/' + app.index + '.png?token=' + TOKEN;
  img.alt = '';
  img.loading = 'lazy';
  img.addEventListener('error', function(){ img.style.visibility = 'hidden'; });
  card.innerHTML = '<span class="check">✓</span>'
    + '<span class="nm">' + esc(app.name) + '</span>'
    + '<span class="days">' + (app.activeDays > 0 ? '近半年活跃 ' + app.activeDays + ' 天' : '无活跃记录') + '</span>'
    + '<input class="grp" type="text" list="groups" maxlength="14" placeholder="分类" value="' + esc(sel ? sel.group : app.group) + '">'
    + '<input class="note" type="text" maxlength="60" placeholder="推荐理由（可选，60 字内）" value="' + esc(sel ? sel.note : '') + '">';
  card.insertBefore(img, card.children[1]);
  card.addEventListener('click', function(ev){
    if (ev.target.tagName === 'INPUT') return;
    toggle(app.index);
  });
  card.querySelector('.grp').addEventListener('input', function(ev){
    var s = state.get(app.index);
    if (s) s.group = ev.target.value;
  });
  card.querySelector('.note').addEventListener('input', function(ev){
    var s = state.get(app.index);
    if (s) { s.note = ev.target.value; updateCount(); }
  });
  grid.appendChild(card);
  cards.push({ app: app, el: card });
});
function toggle(i){
  var c = cards[i];
  if (state.has(i)) {
    state.delete(i);
    c.el.classList.remove('on');
  } else {
    if (state.size >= 48) { toast('最多选择 48 款软件。'); return; }
    state.set(i, { group: c.el.querySelector('.grp').value.trim() || c.app.group, note: c.el.querySelector('.note').value.trim() });
    c.el.classList.add('on');
  }
  updateCount();
}
var filterGroup = '';
function applyFilter(){
  var q = document.getElementById('q').value.trim().toLowerCase();
  cards.forEach(function(c){
    var show = (!q || c.app.name.toLowerCase().indexOf(q) >= 0) && (!filterGroup || c.app.group === filterGroup);
    c.el.style.display = show ? '' : 'none';
  });
}
document.getElementById('q').addEventListener('input', applyFilter);
var chipsEl = document.getElementById('chips');
var groupsOrder = [];
var counts = {};
DATA.apps.forEach(function(a){
  if (!(a.group in counts)) { counts[a.group] = 0; groupsOrder.push(a.group); }
  counts[a.group]++;
});
function markChips(active){
  Array.prototype.forEach.call(chipsEl.children, function(c){ c.classList.toggle('on', c === active); });
}
var allChip = document.createElement('button');
allChip.className = 'chip on';
allChip.textContent = '全部';
allChip.addEventListener('click', function(){ filterGroup = ''; markChips(allChip); applyFilter(); });
chipsEl.appendChild(allChip);
groupsOrder.forEach(function(g){
  var b = document.createElement('button');
  b.className = 'chip';
  b.textContent = g + ' ' + counts[g];
  b.addEventListener('click', function(){ filterGroup = g; markChips(b); applyFilter(); });
  chipsEl.appendChild(b);
});
var dl = document.getElementById('groups');
groupsOrder.forEach(function(g){
  var o = document.createElement('option');
  o.value = g;
  dl.appendChild(o);
});
document.getElementById('top').addEventListener('click', function(){
  var n = 0;
  DATA.apps.forEach(function(app){
    if (n < 24 && app.activeDays > 0 && !state.has(app.index)) {
      state.set(app.index, { group: app.group, note: '' });
      cards[app.index].el.classList.add('on');
      n++;
    }
  });
  updateCount();
});
document.getElementById('clear').addEventListener('click', function(){
  state.clear();
  cards.forEach(function(c){ c.el.classList.remove('on'); });
  updateCount();
});
document.getElementById('title').value = DATA.title;
document.getElementById('year').value = DATA.year || new Date().getFullYear();
document.getElementById('useYear').checked = DATA.year > 0;
document.getElementById('author').value = DATA.author;
document.getElementById('role').value = DATA.role || '';
var roleDl = document.getElementById('roles');
(DATA.roles || []).forEach(function(r){ var o = document.createElement('option'); o.value = r; roleDl.appendChild(o); });
document.getElementById('save').addEventListener('click', function(){
  var title = document.getElementById('title').value.trim();
  if (!title) { toast('请填写海报标题。'); return; }
  if (state.size < 1) { toast('请至少选择 1 款软件。'); return; }
  var groups = {};
  var chosen = [];
  DATA.apps.forEach(function(app){
    var s = state.get(app.index);
    if (!s) return;
    var g = s.group.trim() || app.group;
    groups[g] = true;
    chosen.push({ index: app.index, group: g, note: s.note.trim() });
  });
  if (Object.keys(groups).length > 7) { toast('分类最多 7 个，请合并一些。'); return; }
  var body = {
    title: title,
    year: document.getElementById('useYear').checked ? Number(document.getElementById('year').value) : 0,
    author: document.getElementById('author').value.trim(),
    role: document.getElementById('role').value.trim(),
    apps: chosen
  };
  var btn = document.getElementById('save');
  btn.disabled = true;
  fetch('/save?token=' + TOKEN, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    .then(function(r){ return r.json(); })
    .then(function(r){
      if (r.ok) { document.getElementById('done').className = 'done show'; }
      else { btn.disabled = false; toast(r.error || '保存失败。'); }
    })
    .catch(function(){ btn.disabled = false; toast('网络错误，请重试。'); });
});
updateCount();
</script>
</body>
</html>`;
}
const shareId = (id) => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id) ? id : undefined;

async function render(values) {
  const selectionPath = resolve(values.input ?? 'selection.json');
  const selection = await readSelection(selectionPath);
  for (const app of selection.apps) {
    await access(join(app.path, 'Contents', 'Info.plist')).catch(() => { throw new Error('找不到应用：' + app.name); });
  }
  const file = resolve(values.out ?? 'mac-apps.png');
  if (!file.toLowerCase().endsWith('.png')) throw new Error('输出文件必须以 .png 结尾。');
  const style = values.style ?? 'desktop';
  if (!['desktop', 'night', 'minimal'].includes(style)) throw new Error('可用样式：desktop、night、minimal。');
  await mkdir(dirname(file), { recursive: true });
  const wallpaper = values.wallpaper ? resolve(values.wallpaper) : '';
  const manifest = file + '.json';
  if (await isFile(file) || await isFile(manifest)) throw new Error('输出已存在，请另取文件名。');
  const temporary = await mkdtemp(join(dirname(file), '.render-'));
  try {
    const candidate = join(temporary, 'poster.png');
    const { stdout } = await exec('/usr/bin/osascript', ['-l', 'JavaScript', join(scriptDir, 'render.js'),
      JSON.stringify(selection), candidate, style, wallpaper], { timeout: 45000 });
    const digest = sha256(await readFile(candidate));
    const iconFolder = file + '.icons';
    const icons = await exportIcons(selection.apps, iconFolder).catch(() => selection.apps.map(() => null));
    await copyFile(candidate, file, constants.COPYFILE_EXCL);
    try {
      const apps = selection.apps.map(({ name, group, id, note }, index) => ({ name, group,
        ...(shareId(id) ? { id } : {}), ...(note ? { note } : {}), ...(icons[index] ? { icon: icons[index] } : {}) }));
      await saveJson(manifest, {
        title: selection.title,
        ...(selection.author ? { author: selection.author } : {}),
        ...(selection.role ? { role: selection.role } : {}),
        apps,
        sha256: digest,
        publishKey: randomBytes(32).toString('hex'),
      });
    } catch (error) {
      await rm(file);
      throw error;
    }
    console.log(JSON.stringify({ ...JSON.parse(stdout), image: file, icons: icons.filter(Boolean).length,
      notes: selection.apps.filter(app => app.note).length }));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function publish(values) {
  if (!values.image || !['link', 'public'].includes(values.visibility)) {
    throw new Error('发布需要 --image、--name 和 --visibility link|public。请先预览并确认。');
  }
  const image = resolve(values.image);
  const manifest = JSON.parse(await readFile(image + '.json', 'utf8'));
  if (!values.name && !manifest.author) throw new Error('发布需要 --name 分享名。');
  const name = str(values.name ?? manifest.author, '分享名', 40);
  const role = values.role ? str(values.role, '身份标签', 16) : (manifest.role ? str(manifest.role, '身份标签', 16) : '');
  const receipt = image + '.share.json';
  if (await isFile(receipt)) throw new Error('已有分享凭证：' + receipt + '。要原地更新，请改用 update --receipt；要发布为新链接，请另存成图。');
  if ((await stat(image)).size > 8 * 1024 * 1024) throw new Error('图片超过 8 MiB。');
  const png = await readFile(image);
  if (manifest.sha256 !== createHash('sha256').update(png).digest('hex')) throw new Error('成图与预览清单不一致，请重新生成。');
  if (!/^[a-f0-9]{64}$/.test(manifest.publishKey ?? '')) throw new Error('预览清单缺少上传编号，请重新生成。');
  const icons = await missingIcons(image + '.icons', manifest.apps);
  const response = await fetch(shareEndpoint(), { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(60000),
    headers: { 'content-type': 'application/json', 'idempotency-key': manifest.publishKey },
    body: JSON.stringify({ name, title: manifest.title, ...(role ? { role } : {}), visibility: values.visibility, apps: manifest.apps,
      ...(Object.keys(icons).length ? { icons } : {}), image: png.toString('base64') }) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? '发布失败。');
  await saveJson(receipt, result);
  console.log(JSON.stringify({ url: result.url, visibility: result.visibility, receipt, iconsUploaded: Object.keys(icons).length }));
}

async function update(values) {
  if (!values.receipt || !values.image) {
    throw new Error('原地更新需要 --receipt 指向既有分享凭证，以及 --image 指向新成图。');
  }
  const receiptPath = resolve(values.receipt);
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
  if (!/^[a-f0-9]{24}$/.test(receipt.id ?? '') || !/^[a-f0-9]{64}$/.test(receipt.removeToken ?? '')) {
    throw new Error('分享凭证无效。');
  }
  const image = resolve(values.image);
  const manifest = JSON.parse(await readFile(image + '.json', 'utf8'));
  const visibility = values.visibility ?? receipt.visibility ?? 'public';
  if (!['link', 'public'].includes(visibility)) throw new Error('可见范围需为 link 或 public。');
  const name = str(values.name ?? manifest.author, '分享名', 40);
  const role = values.role !== undefined ? (values.role ? str(values.role, '身份标签', 16) : '') : (manifest.role ? str(manifest.role, '身份标签', 16) : '');
  if ((await stat(image)).size > 8 * 1024 * 1024) throw new Error('图片超过 8 MiB。');
  const png = await readFile(image);
  if (manifest.sha256 !== createHash('sha256').update(png).digest('hex')) throw new Error('成图与预览清单不一致，请重新生成。');
  const icons = await missingIcons(image + '.icons', manifest.apps);
  const response = await fetch(shareEndpoint() + '/' + receipt.id, {
    method: 'PUT', redirect: 'error', signal: AbortSignal.timeout(60000),
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + receipt.removeToken },
    body: JSON.stringify({ name, title: manifest.title, ...(role ? { role } : {}), visibility, apps: manifest.apps,
      ...(Object.keys(icons).length ? { icons } : {}), image: png.toString('base64') }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? '更新失败。');
  await writeFile(receiptPath, JSON.stringify({ ...receipt, visibility: result.visibility, url: result.url }, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ url: result.url, visibility: result.visibility, updated: true, receipt: receiptPath, iconsUploaded: Object.keys(icons).length }));
}

// Asks the site which icon fingerprints it lacks and returns only those files. Any failure means no icons are sent;
// the site then shows a placeholder or an icon other posters already uploaded.
async function missingIcons(folder, apps) {
  const hashes = [...new Set((apps ?? []).map(app => app.icon).filter(hash => /^[a-f0-9]{64}$/.test(hash ?? '')))];
  if (!hashes.length) return {};
  try {
    const response = await fetch(lookupEndpoint(), { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hashes }) });
    if (!response.ok) return {};
    const { missing } = await response.json();
    const icons = {};
    let total = 0;
    for (const hash of Array.isArray(missing) ? missing : []) {
      if (!hashes.includes(hash)) continue;
      const bytes = await readFile(join(folder, hash + '.png')).catch(() => null);
      if (!bytes || sha256(bytes) !== hash || total + bytes.length > maxIconTotal) continue;
      total += bytes.length;
      icons[hash] = bytes.toString('base64');
    }
    return icons;
  } catch { return {}; }
}

async function revoke(values) {
  if (!values.receipt) throw new Error('撤回需要 --receipt 指向本机分享凭证。');
  const receipt = JSON.parse(await readFile(resolve(values.receipt), 'utf8'));
  if (!/^[a-f0-9]{24}$/.test(receipt.id ?? '') || !/^[a-f0-9]{64}$/.test(receipt.removeToken ?? '')) {
    throw new Error('撤回凭证无效。');
  }
  const response = await fetch(shareEndpoint() + '/' + receipt.id, {
    method: 'DELETE', redirect: 'error', signal: AbortSignal.timeout(15000),
    headers: { authorization: 'Bearer ' + receipt.removeToken },
  });
  if (!response.ok) throw new Error((await response.json()).error ?? '撤回失败。');
  console.log(JSON.stringify({ withdrawn: true, url: receipt.url }));
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'help' || !command) {
    console.log('scan --dir 目录 [--root 附加应用目录]\npick --dir 目录    打开本机挑选页，勾选软件、分组、身份标签和推荐理由后写回 selection.json\nrender --input selection.json --out 成图.png [--style desktop|night|minimal] [--wallpaper 图片]\npublish --image 成图.png --name 署名 [--role 身份] --visibility link|public\nupdate --receipt 旧凭证.share.json --image 新成图.png [--name 署名] [--role 身份] [--visibility link|public]\nrevoke --receipt 成图.png.share.json');
    return;
  }
  if (process.platform !== 'darwin') throw new Error('制作需要从 macOS 本机运行。');
  const options = Object.fromEntries(['dir','input','out','style','wallpaper','name','role','image','visibility','receipt'].map(name => [name, {type:'string'}]));
  options.root = {type:'string', multiple:true};
  const { values } = parseArgs({ args, options });
  const handler = { scan, pick, render, publish, update, revoke }[command];
  if (!handler) throw new Error('未知命令：' + command);
  await handler(values);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
