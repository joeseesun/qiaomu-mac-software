import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
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

function inferredGroup(name) {
  if (/codex|chatgpt|claude|deepseek|doubao|豆包|gemini|antigravity|workbuddy|qoder|cursor|t3 code|factory|zcode|xcode|visual studio|terminal|iterm|cmux/i.test(name)) return 'AI 与开发';
  if (/chrome|firefox|safari|wechat|微信|lark|飞书|telegram|edge|会议|ego lite|flclash|slack/i.test(name)) return '浏览与沟通';
  if (/obsidian|sublime|\bword\b|powerpoint|notion|pages|excel|notes|备忘录|anki|keynote|typora/i.test(name)) return '写作与办公';
  if (/studio|capwise|photos|final cut|录|shot|subcast|figma|sketch|pixelmator/i.test(name)) return '创作';
  return '效率与工具';
}

async function readApp(path, cutoff, end) {
  try {
    const canonical = await realpath(path);
    const plist = join(canonical, 'Contents', 'Info.plist');
    const { stdout } = await exec('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', plist], { timeout: 3000 });
    const id = stdout.trim();
    if (!id) return null;
    const name = basename(path).replace(/\.app$/i, '');
    const data = await readMetadata(path, ['kMDItemUsedDates', 'kMDItemLastUsedDate']);
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
  return { title, year, author, apps };
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
      await saveJson(manifest, { title: selection.title, ...(selection.author ? { author: selection.author } : {}), apps, sha256: digest, publishKey: randomBytes(32).toString('hex') });
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
  const receipt = image + '.share.json';
  if (await isFile(receipt)) throw new Error('已有分享凭证：' + receipt + '。要重新发布，请先另存一张成图。');
  if ((await stat(image)).size > 8 * 1024 * 1024) throw new Error('图片超过 8 MiB。');
  const png = await readFile(image);
  if (manifest.sha256 !== createHash('sha256').update(png).digest('hex')) throw new Error('成图与预览清单不一致，请重新生成。');
  if (!/^[a-f0-9]{64}$/.test(manifest.publishKey ?? '')) throw new Error('预览清单缺少上传编号，请重新生成。');
  const icons = await missingIcons(image + '.icons', manifest.apps);
  const response = await fetch(shareEndpoint(), { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(60000),
    headers: { 'content-type': 'application/json', 'idempotency-key': manifest.publishKey },
    body: JSON.stringify({ name, title: manifest.title, visibility: values.visibility, apps: manifest.apps,
      ...(Object.keys(icons).length ? { icons } : {}), image: png.toString('base64') }) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? '发布失败。');
  await saveJson(receipt, result);
  console.log(JSON.stringify({ url: result.url, visibility: result.visibility, receipt, iconsUploaded: Object.keys(icons).length }));
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
    console.log('scan --dir 目录 [--root 附加应用目录]\nrender --input selection.json --out 成图.png [--style desktop|night|minimal] [--wallpaper 图片]\npublish --image 成图.png --name 署名 --visibility link|public\nrevoke --receipt 成图.png.share.json');
    return;
  }
  if (process.platform !== 'darwin') throw new Error('制作需要从 macOS 本机运行。');
  const options = Object.fromEntries(['dir','input','out','style','wallpaper','name','image','visibility','receipt'].map(name => [name, {type:'string'}]));
  options.root = {type:'string', multiple:true};
  const { values } = parseArgs({ args, options });
  const handler = { scan, render, publish, revoke }[command];
  if (!handler) throw new Error('未知命令：' + command);
  await handler(values);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
