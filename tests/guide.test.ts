import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSnapshot } from '../src/server/git.js';
import { buildPrompt, validateGuide } from '../src/server/guide.js';
import { ReviewStore } from '../src/server/store.js';
import type { Guide, Snapshot } from '../src/shared/types.js';
import { makeFixture } from './fixture.js';

export function fixtureGuide(snapshot: Snapshot): Guide {
  const changes = snapshot.files
    .filter((file) => !file.issue)
    .flatMap((file) => file.changes.map((change) => change.id));
  const beforeRef = snapshot.refs.find(
    (ref) => ref.path === 'src/submit.ts' && ref.side === 'before',
  )!;
  const afterRef = snapshot.refs.find(
    (ref) => ref.path === 'src/submit.ts' && ref.side === 'after',
  )!;
  return {
    overview: '调整异步提交的等待状态恢复逻辑。',
    groups: [
      {
        title: '请求结束后恢复等待状态',
        changeIds: changes,
        before: {
          text: '请求抛错后，恢复 pending 的语句不会执行。',
          basis: 'source',
          refIds: [beforeRef.id],
        },
        after: {
          text: 'finally 在请求成功或失败后恢复 pending。',
          basis: 'source',
          refIds: [afterRef.id],
        },
        notes: [],
        questions: ['并发调用是否属于受支持场景？'],
      },
    ],
    unreviewed: snapshot.files
      .filter((file) => file.issue)
      .flatMap((file) =>
        file.changes.map((change) => ({ changeId: change.id, reason: file.issue! })),
      ),
    limitations: ['未运行测试。'],
    requirementLinks: (snapshot.requirements ?? []).map((item) => ({
      requirementId: item.id,
      statement: { text: `需核对：${item.text}`, basis: 'inference', refIds: [] },
      changeIds: [],
    })),
    flowSteps: [
      {
        groupIndex: 0,
        stage: '状态',
        statement: {
          text: 'finally 在请求结束后清除等待状态。',
          basis: 'source',
          refIds: [afterRef.id],
        },
      },
    ],
  };
}

test('导读契约拒绝伪造引用、无证据事实、遗漏与重复变更', async (t) => {
  const fixture = await makeFixture(false);
  t.after(fixture.cleanup);
  const snapshot = await createSnapshot(fixture.repo, fixture.base, fixture.target);
  const guide = fixtureGuide(snapshot);
  assert.equal(validateGuide(guide, snapshot).groups[0].title, guide.groups[0].title);
  const missing = structuredClone(guide);
  missing.groups[0].changeIds.pop();
  assert.throws(() => validateGuide(missing, snapshot), /遗漏/);
  const duplicate = structuredClone(guide);
  duplicate.groups[0].changeIds.push(duplicate.groups[0].changeIds[0]);
  assert.throws(() => validateGuide(duplicate, snapshot), /重复/);
  const fake = structuredClone(guide);
  fake.groups[0].after.refIds = ['other-snapshot-ref'];
  assert.throws(() => validateGuide(fake, snapshot), /不存在/);
  const ungrounded = structuredClone(guide);
  ungrounded.groups[0].before.refIds = [];
  assert.throws(() => validateGuide(ungrounded, snapshot), /没有源码引用/);
  const prompt = buildPrompt(snapshot);
  assert.match(prompt, /未运行|未执行/);
  assert.ok(prompt.includes(snapshot.base) && prompt.includes(snapshot.target));
  assert.match(prompt, /待分析数据/);
});

test('不支持的文件只能显式列为未分析', async (t) => {
  const fixture = await makeFixture();
  t.after(fixture.cleanup);
  const snapshot = await createSnapshot(fixture.repo, fixture.base, fixture.target);
  const guide = fixtureGuide(snapshot);
  assert.ok(validateGuide(guide, snapshot).unreviewed.length >= 3);
  const unsupported = guide.unreviewed.shift()!;
  guide.groups[0].changeIds.push(unsupported.changeId);
  assert.throws(() => validateGuide(guide, snapshot), /必须列为未分析/);
});

test('旧版笔记、验证、分组状态与追问被永久清除，其他快照数据保留', async (t) => {
  const fixture = await makeFixture(false);
  t.after(fixture.cleanup);
  const directory = await mkdtemp(path.join(tmpdir(), 'review-store-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new ReviewStore(directory);
  const snapshot = await createSnapshot(fixture.repo, fixture.base, fixture.target);
  const review = await store.create(snapshot);
  review.guide = fixtureGuide(snapshot);
  review.claimStates = { preserved: { status: 'question', evidence: '仍需检查', guideFingerprint: 'hash', updatedAt: '2026-01-01' } };
  await store.save(review);
  const filename = path.join(directory, `${snapshot.id}.json`);
  const old = JSON.parse(await readFile(filename, 'utf8'));
  old.notes = { overview: '旧版笔记' };
  old.verificationRecords = [{ id: 'old-verification' }];
  old.reviewStates = { old: { status: 'verified', evidence: '旧版依据' } };
  old.answers = [{ question: '旧版追问', answer: { statements: [], openQuestions: [] } }];
  old.groupHashes = ['old-hash'];
  await writeFile(filename, JSON.stringify(old));
  const reopened = await new ReviewStore(directory).get(snapshot.id);
  assert.equal(Object.hasOwn(reopened, 'notes'), false);
  for (const key of ['verificationRecords', 'reviewStates', 'answers', 'groupHashes'])
    assert.equal(Object.hasOwn(reopened, key), false);
  assert.equal(reopened.guide?.overview, review.guide.overview);
  assert.deepEqual(reopened.claimStates, review.claimStates);
  const saved = JSON.parse(await readFile(filename, 'utf8'));
  assert.equal(Object.hasOwn(saved, 'notes'), false);
  for (const key of ['verificationRecords', 'reviewStates', 'answers', 'groupHashes'])
    assert.equal(Object.hasOwn(saved, key), false);
  assert.deepEqual(saved.snapshot, old.snapshot);
  await assert.rejects(store.get('../outside'), /无效/);
});

test('需求对照覆盖原文且流程步骤只允许当前分组与证据', async (t) => {
  const fixture = await makeFixture(false);
  t.after(fixture.cleanup);
  const requirements = [
    { id: 'req-1', kind: 'change' as const, text: '失败后清除等待状态' },
    { id: 'req-2', kind: 'preserve' as const, text: '继续抛出原始异常' },
  ];
  const snapshot = await createSnapshot(fixture.repo, fixture.base, fixture.target, requirements);
  const guide = fixtureGuide(snapshot);
  assert.equal(validateGuide(guide, snapshot).requirementLinks?.length, 2);
  const preserved = structuredClone(guide);
  preserved.requirementLinks![1].statement = {
    text: '前后源码均保留异常传播。',
    basis: 'source',
    refIds: [preserved.groups[0].before.refIds[0], preserved.groups[0].after.refIds[0]],
  };
  assert.equal(validateGuide(preserved, snapshot).requirementLinks?.[1].changeIds.length, 0);
  const falseFulfillment = structuredClone(preserved);
  falseFulfillment.requirementLinks![0].statement = preserved.requirementLinks![1].statement;
  assert.throws(() => validateGuide(falseFulfillment, snapshot), /缺少对应变更/);
  const missing = structuredClone(guide);
  missing.requirementLinks?.pop();
  assert.throws(() => validateGuide(missing, snapshot), /需求对照存在遗漏/);
  const fake = structuredClone(guide);
  fake.flowSteps![0].statement.refIds = ['unknown-ref'];
  assert.throws(() => validateGuide(fake, snapshot), /不存在/);
  const wrongGroup = structuredClone(guide);
  wrongGroup.flowSteps![0].groupIndex = 1;
  assert.throws(() => validateGuide(wrongGroup, snapshot), /未知分组/);
  const outOfOrder = structuredClone(guide);
  outOfOrder.flowSteps!.unshift({
    groupIndex: 0,
    stage: '结果',
    statement: {
      text: '返回调用结果。',
      basis: 'inference',
      refIds: [],
    },
  });
  assert.deepEqual(
    validateGuide(outOfOrder, snapshot).flowSteps?.map((step) => step.stage),
    ['状态', '结果'],
  );
  assert.match(buildPrompt(snapshot), /失败后清除等待状态/);
  const otherRequirement = await createSnapshot(fixture.repo, fixture.base, fixture.target, [
    requirements[0],
  ]);
  assert.notEqual(snapshot.id, otherRequirement.id);
});
