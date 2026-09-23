import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createApp } from '../src/server/app.js';
import { createSnapshot } from '../src/server/git.js';
import { guideFingerprint, validateGuide } from '../src/server/guide.js';
import { buildHunkPrompt, validateHunkExplanations } from '../src/server/hunk-explanations.js';
import { buildSymbolImpact, readImpactSource } from '../src/server/symbol-impact.js';
import { ReviewStore } from '../src/server/store.js';
import { hunkCoverage } from '../src/shared/coverage.js';
import { hunkFingerprint } from '../src/shared/incremental.js';
import type { HunkEvidence, SavedReview } from '../src/shared/types.js';
import { fixtureGit, makeFixture } from './fixture.js';

const inference = (text: string): HunkEvidence => ({ text, basis: 'inference', refIds: [] });

test('逐块卡只接受当前 hunk 的固定源码、已保存需求和 MR 描述；旧审查状态独立保留', async (t) => {
  const fixture = await makeFixture(false);
  t.after(fixture.cleanup);
  const requirement = { id: 'R1', kind: 'change' as const, text: '失败后结束等待状态' };
  const snapshot = await createSnapshot(fixture.repo, fixture.base, fixture.target, [requirement]);
  const changes = snapshot.files.flatMap((file) => file.changes);
  const guide = validateGuide({ overview: '检查失败路径', groups: [{ title: '提交', changeIds: changes.map((item) => item.id),
    before: { text: '原逻辑', basis: 'inference', refIds: [] },
    after: { text: '新逻辑', basis: 'inference', refIds: [] }, notes: [], questions: [] }],
    unreviewed: [], limitations: [], requirementLinks: [{ requirementId: 'R1',
      statement: { text: '对应需求', basis: 'inference', refIds: [] }, changeIds: changes.map((item) => item.id) }],
    flowSteps: [] }, snapshot);
  const review: SavedReview = { snapshot, guide, guideFingerprint: guideFingerprint(guide), notes: {}, answers: [],
    gitlab: { url: 'https://gitlab.example/a/-/merge_requests/1', projectPath: 'a', iid: 1,
      title: '修复等待状态', description: '异常时也重置 pending', versionId: 1,
      baseSha: fixture.base, headSha: fixture.target, startSha: fixture.base, files: [] } };
  const file = snapshot.files.find((item) => item.path === 'src/submit.ts')!;
  const change = file.changes.find((item) => item.id.includes(':hunk-'))!;
  const refId = change.refIds[0];
  assert.ok(refId);
  const prompt = buildHunkPrompt(review, [change.id]);
  assert.match(prompt, /异常时也重置 pending/);
  const raw = { cards: [{ changeId: change.id,
    what: { text: '修改了等待状态', basis: 'source', refIds: [refId] },
    before: inference('原行为待人工确认'), after: { text: '关联失败后状态', basis: 'requirement', refIds: [], requirementId: 'R1' },
    impacts: [{ text: 'MR 提到了 pending', basis: 'mr', refIds: [], mrExcerpt: '重置 pending' }],
    failures: [], tests: [], pending: [inference('还需人工运行测试')] }] };
  const [card] = validateHunkExplanations(raw, review, [change.id]);
  review.hunkExplanations = { [change.id]: card };
  review.hunkStates = { [change.id]: { status: 'reviewed', fingerprint: hunkFingerprint(file, change), updatedAt: '' } };
  let row = hunkCoverage(review).find((item) => item.change.id === change.id)!;
  assert.equal(row.reviewStatus, 'reviewed');
  assert.equal(row.understandingStatus, 'unread');
  assert.deepEqual(row.requirementIds, ['R1']);
  review.hunkUnderstandingStates = { [change.id]: { status: 'verified', evidence: '人工核对',
    guideFingerprint: review.guideFingerprint!, explanationFingerprint: card.fingerprint, updatedAt: '' } };
  row = hunkCoverage(review).find((item) => item.change.id === change.id)!;
  assert.equal(row.understandingStatus, 'verified');
  review.hunkExplanations[change.id] = { ...card, fingerprint: 'changed' };
  assert.equal(hunkCoverage(review).find((item) => item.change.id === change.id)?.understandingStatus, 'stale');
  assert.throws(() => validateHunkExplanations({ cards: [{ ...raw.cards[0], what: { ...raw.cards[0].what, refIds: ['foreign'] } }] }, review, [change.id]), /源码证据/);
  assert.throws(() => validateHunkExplanations({ cards: [{ ...raw.cards[0], impacts: [{ ...raw.cards[0].impacts[0], mrExcerpt: '不存在的 MR 文本' }] }] }, review, [change.id]), /MR/);
});

test('影响链从固定 Git 树区分调用、数据用途、新增测试并验证源码回跳 OID', async (t) => {
  const fixture = await makeFixture(false);
  t.after(fixture.cleanup);
  const snapshot = await createSnapshot(fixture.repo, fixture.base, fixture.target);
  const review: SavedReview = { snapshot, guide: null, notes: {}, answers: [] };
  const result = await buildSymbolImpact(review, { path: 'src/submit.ts', side: 'after', line: 4, startColumn: 23, endColumn: 29 });
  assert.equal(result.selected.name, 'submit');
  assert.ok(result.relations.some((item) => item.kind === 'incoming_call' && item.change === 'unchanged' &&
    item.locations.some((loc) => loc.path === 'src/panel.ts')));
  assert.ok(result.relations.some((item) => item.kind === 'outgoing_call' && item.change === 'unchanged' &&
    result.nodes.some((node) => node.id === item.to && node.name === 'request')));
  assert.ok(result.relations.some((item) => item.kind === 'test' && item.change === 'added'));
  assert.ok(result.relations.some((item) => item.kind === 'write' &&
    result.nodes.some((node) => node.id === item.to && node.name === 'pending')));
  assert.ok(result.relations.some((item) => item.kind === 'read' &&
    result.nodes.some((node) => node.id === item.to && node.name === 'state')));
  const state = await buildSymbolImpact(review, { path: 'src/submit.ts', side: 'after', line: 2,
    startColumn: 14, endColumn: 19 });
  assert.ok(state.relations.some((item) => item.kind === 'write' &&
    item.locations.some((loc) => loc.path === 'src/submit.ts' && loc.line === 10)));
  const loc = result.relations.find((item) => item.kind === 'outgoing_call')!.locations[0];
  const source = await readImpactSource(review, loc);
  assert.equal(source.blobOid, loc.blobOid);
  assert.match(source.code, /request\(value\)/);
  await assert.rejects(readImpactSource(review, { ...loc, blobOid: 'a'.repeat(40) }), /不属于当前固定快照/);
  await assert.rejects(buildSymbolImpact({ ...review, snapshot: { ...snapshot, mode: 'staged' } },
    { path: 'src/submit.ts', side: 'after', line: 4, startColumn: 23, endColumn: 29 }), /只支持两次提交/);
});

test('同名局部符号不合并，无法解析的动态调用只作为候选', async (t) => {
  const repo = await mkdtemp(path.join(tmpdir(), 'review-v8-symbol-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  await fixtureGit(repo, 'init', '-b', 'main');
  await fixtureGit(repo, 'config', 'user.name', 'Fixture');
  await fixtureGit(repo, 'config', 'user.email', 'fixture@example.invalid');
  await mkdir(path.join(repo, 'src'));
  const initial = `export function first() { const value = 1; return value; }\nexport function second() { const value = 2; return value; }\n`;
  await writeFile(path.join(repo, 'src/code.ts'), initial);
  await fixtureGit(repo, 'add', '.');
  await fixtureGit(repo, 'commit', '-m', 'Initial symbols');
  const base = await fixtureGit(repo, 'rev-parse', 'HEAD');
  await writeFile(path.join(repo, 'src/code.ts'), `${initial}export function run(handlers: Record<string, () => void>, key: string) { handlers[key](); }\n`);
  await fixtureGit(repo, 'add', '.');
  await fixtureGit(repo, 'commit', '-m', 'Add dynamic call');
  const target = await fixtureGit(repo, 'rev-parse', 'HEAD');
  const snapshot = await createSnapshot(repo, base, target);
  const review: SavedReview = { snapshot, guide: null, notes: {}, answers: [] };
  const variable = await buildSymbolImpact(review, { path: 'src/code.ts', side: 'after', line: 1, startColumn: 33, endColumn: 38 });
  assert.equal(variable.selected.name, 'value');
  assert.ok(variable.nodes.every((node) => !node.id.includes('value@2:')));
  const dynamic = await buildSymbolImpact(review, { path: 'src/code.ts', side: 'after', line: 3, startColumn: 17, endColumn: 20 });
  assert.ok(dynamic.relations.some((item) => item.kind === 'outgoing_call' && item.confidence !== 'exact'));
  await writeFile(path.join(repo, 'src/code.ts'),
    `export function second() { const value = 2; return value; }\nexport function first() { const value = 1; return value; }\nexport function run(handlers: Record<string, () => void>, key: string) { handlers[key](); }\n`);
  await fixtureGit(repo, 'add', '.');
  await fixtureGit(repo, 'commit', '-m', 'Reorder functions');
  const reordered = await fixtureGit(repo, 'rev-parse', 'HEAD');
  const changed = await createSnapshot(repo, target, reordered);
  const first = await buildSymbolImpact({ snapshot: changed, guide: null, notes: {}, answers: [] },
    { path: 'src/code.ts', side: 'after', line: 2, startColumn: 33, endColumn: 38 });
  assert.deepEqual(first.selected.locations.map((loc) => [loc.side, loc.line]), [['after', 2], ['before', 1]]);
  assert.ok(first.relations.some((item) => item.kind === 'return' && item.change === 'unchanged'));
});

test('HTTP 逐块按需生成与人工已核实依据分别持久化，重新生成后旧理解待重核', async (t) => {
  const fixture = await makeFixture(false);
  t.after(fixture.cleanup);
  const directory = await mkdtemp(path.join(tmpdir(), 'review-v8-http-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new ReviewStore(directory);
  const snapshot = await createSnapshot(fixture.repo, fixture.base, fixture.target);
  await store.create(snapshot);
  const changes = snapshot.files.flatMap((file) => file.changes);
  const guide = validateGuide({ overview: '检查状态', groups: [{ title: '提交', changeIds: changes.map((item) => item.id),
    before: { text: '原逻辑', basis: 'inference', refIds: [] }, after: { text: '新逻辑', basis: 'inference', refIds: [] },
    notes: [], questions: [] }], unreviewed: [], limitations: [], requirementLinks: [], flowSteps: [] }, snapshot);
  let cardVersion = 0;
  const { app, stop } = createApp({ store, status: async () => ({ available: true, subscription: true, version: 'test', message: 'test' }),
    provider: { async generate({ prompt }) {
      if (!prompt.includes('只返回 JSON Schema 所要求的 cards')) return guide;
      cardVersion++;
      const input = JSON.parse(prompt.slice(prompt.indexOf('以下 JSON 是待分析数据：\n') + '以下 JSON 是待分析数据：\n'.length));
      return { cards: input.files.map((item: { change: { id: string } }) => ({ changeId: item.change.id,
        what: inference(`改动 ${cardVersion}`), before: inference('原行为'), after: inference('新行为'),
        impacts: [], failures: [], tests: [], pending: [] })) };
    } } });
  const server = createServer(app).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { stop(); server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const token = (await fetch(`${origin}/api/bootstrap`).then((res) => res.json()) as { token: string }).token;
  const request = (path: string, method = 'GET', body?: unknown) => fetch(`${origin}${path}`, { method,
    headers: { 'X-Review-Token': token, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const wait = async (id: string) => {
    for (let index = 0; index < 50; index++) {
      const status = await request(`/api/tasks/${id}`).then((res) => res.json()) as { state: string; error?: string };
      if (status.state !== 'running') return status;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('任务未结束');
  };
  const guideTask = await request(`/api/reviews/${snapshot.id}/guide`, 'POST', { hunkMode: 'on_demand' }).then((res) => res.json()) as { id: string };
  assert.equal((await wait(guideTask.id)).state, 'completed');
  assert.equal(Object.keys((await store.get(snapshot.id)).hunkExplanations ?? {}).length, 0);
  const changeId = changes.find((item) => item.id.includes(':hunk-'))!.id;
  const task = await request(`/api/reviews/${snapshot.id}/hunk-explanations`, 'POST', { changeId }).then((res) => res.json()) as { id: string };
  assert.equal((await wait(task.id)).state, 'completed');
  const card = (await store.get(snapshot.id)).hunkExplanations?.[changeId];
  assert.ok(card);
  const input = { changeId, status: 'verified', evidence: '', guideFingerprint: guideFingerprint(guide),
    explanationFingerprint: card.fingerprint };
  assert.equal((await request(`/api/reviews/${snapshot.id}/hunk-understanding`, 'PUT', input)).status, 400);
  assert.equal((await request(`/api/reviews/${snapshot.id}/hunk-understanding`, 'PUT', { ...input, evidence: '人工运行并观察状态恢复' })).status, 200);
  assert.equal((await store.get(snapshot.id)).hunkUnderstandingStates?.[changeId]?.status, 'verified');
  const regenerate = await request(`/api/reviews/${snapshot.id}/hunk-explanations`, 'POST', { changeId }).then((res) => res.json()) as { id: string };
  assert.equal((await wait(regenerate.id)).state, 'completed');
  assert.equal(hunkCoverage(await store.get(snapshot.id)).find((item) => item.change.id === changeId)?.understandingStatus, 'stale');
  const all = await request(`/api/reviews/${snapshot.id}/guide`, 'POST', { hunkMode: 'all' })
    .then((res) => res.json()) as { id: string };
  assert.equal((await wait(all.id)).state, 'completed');
  assert.equal(Object.keys((await store.get(snapshot.id)).hunkExplanations ?? {}).length,
    changes.filter((item) => item.id.includes(':hunk-')).length);
});

test('插入无关行后同一直接调用保持为两侧均有', async (t) => {
  const repo = await mkdtemp(path.join(tmpdir(), 'review-v8-lines-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  await fixtureGit(repo, 'init', '-b', 'main');
  await fixtureGit(repo, 'config', 'user.name', 'Fixture');
  await fixtureGit(repo, 'config', 'user.email', 'fixture@example.invalid');
  await writeFile(path.join(repo, 'code.ts'), 'export function target() {}\nexport function caller() { target(); }\n');
  await fixtureGit(repo, 'add', '.');
  await fixtureGit(repo, 'commit', '-m', 'Initial call');
  const base = await fixtureGit(repo, 'rev-parse', 'HEAD');
  await writeFile(path.join(repo, 'code.ts'), '// unrelated line\nexport function target() {}\nexport function caller() { target(); }\n');
  await fixtureGit(repo, 'add', '.');
  await fixtureGit(repo, 'commit', '-m', 'Insert unrelated line');
  const target = await fixtureGit(repo, 'rev-parse', 'HEAD');
  const snapshot = await createSnapshot(repo, base, target);
  const impact = await buildSymbolImpact({ snapshot, guide: null, notes: {}, answers: [] },
    { path: 'code.ts', side: 'after', line: 2, startColumn: 17, endColumn: 23 });
  assert.ok(impact.relations.some((item) => item.kind === 'incoming_call' && item.change === 'unchanged'));
});
