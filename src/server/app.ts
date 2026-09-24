import express from 'express';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z, ZodError } from 'zod';
import type { CommitContext, HunkExplanation, Requirement, ReviewFile, SavedReview, TaskStatus } from '../shared/types.js';
import { listClaims } from '../shared/claims.js';
import { fileFingerprint, sourceLineCount } from '../shared/review-core.js';
import { compareMrVersions, hunkFingerprint, inheritMrReview } from '../shared/incremental.js';
import {
  claimStateInputSchema,
  commentDraftEditSchema,
  commentDraftInputSchema,
  fileStateInputSchema,
  hunkStateInputSchema,
  hunkUnderstandingInputSchema,
  guideGenerationInputSchema,
  hunkGenerationInputSchema,
  hunkExplanationBatchSchema,
  gitlabImportInputSchema,
  guideSchema,
  localCommentInputSchema,
  localCommentEditSchema,
  readingPositionInputSchema,
  snapshotInputSchema,
  symbolImpactInputSchema,
  symbolSourceInputSchema,
} from '../shared/schemas.js';
import { AppError, errorMessage } from './errors.js';
import { createLiveSnapshot, createSnapshot, git, listRepositoryVersions, listUntracked, readCommitContext } from './git.js';
import { pickRepository } from './folder-picker.js';
import { guideFingerprint, mergeGuideBatches, planGuideBatches, validateGuide } from './guide.js';
import { buildHunkPrompt, planHunkBatches, validateHunkExplanations } from './hunk-explanations.js';
import { buildSymbolImpact, readImpactSource } from './symbol-impact.js';
import { CodexProvider, getCodexStatus, type GuideProvider } from './codex.js';
import { ReviewStore } from './store.js';
import { formatCommentDrafts, formatReviewReport } from './report.js';
import {
  assertCommentAnchor,
  assertDiffMatchesSnapshot,
  GitLabClient,
  type GitLabReader,
} from './gitlab.js';
interface Task extends TaskStatus {
  controller: AbortController;
  persisting: boolean;
  active: boolean;
}

export function createApp(options: {
  store: ReviewStore;
  provider?: GuideProvider;
  status?: typeof getCodexStatus;
  gitlab?: GitLabReader;
  repositoryPicker?: () => Promise<string | null>;
}) {
  const app = express();
  const token = randomBytes(32).toString('hex');
  const tasks = new Map<string, Task>();
  const deletingReviews = new Set<string>();
  const provider = options.provider ?? new CodexProvider();
  const status = options.status ?? getCodexStatus;
  const store = options.store;
  const gitlab = options.gitlab ?? new GitLabClient();
  const id = (value: unknown) =>
    z
      .string()
      .regex(/^[a-f0-9]{32}$/)
      .parse(value);
  const publicTask = ({
    controller: _controller,
    persisting: _persisting,
    active: _active,
    ...task
  }: Task): TaskStatus => task;
  const parseRequirements = (changes = '', preserve = ''): Requirement[] => {
    const lines = (text: string, kind: Requirement['kind']) =>
      text
        .split(/\r?\n/)
        .filter((line) => /\S/.test(line))
        .map((line) => ({ kind, text: line }));
    const rows = [...lines(changes, 'change'), ...lines(preserve, 'preserve')];
    if (rows.length > 100) throw new AppError(400, '需求与不得改变项合计最多 100 行。');
    return rows.map((row, index) => ({ ...row, id: `req-${index + 1}` }));
  };
  const isFresh = async (reviewId: string): Promise<boolean> => {
    const { snapshot, gitlab: binding } = await store.get(reviewId);
    if (binding) return gitlab.current(binding);
    if (!snapshot.mode || snapshot.mode === 'commits') return true;
    const current = await createLiveSnapshot(
      snapshot.repo,
      snapshot.mode,
      snapshot.untracked,
      snapshot.requirements,
    );
    return current.id === snapshot.id;
  };
  const sourceAt = (file: ReviewFile, side: 'before' | 'after', line: number) => {
    const source = side === 'before' ? file.before : file.after;
    if (source === null || line > sourceLineCount(source))
      throw new AppError(400, '评论或阅读位置不属于此快照的源码。');
  };
  const localAnchor = (
    file: ReviewFile, side: 'before' | 'after', line: number,
    scope: 'line' | 'range' | 'file' = 'line', endLine?: number,
  ) => {
    // 本地评论允许完整源码范围；MR 草稿另由平台 diff 的可评论行校验。
    if (scope === 'file') {
      if (line !== 0 || endLine !== undefined) throw new AppError(400, '文件级评论不接受行号。');
      return;
    }
    if (line < 1) throw new AppError(400, '评论行号必须大于零。');
    sourceAt(file, side, line);
    if (scope === 'range') {
      if (!endLine || endLine <= line) throw new AppError(400, '多行评论需要大于起始行的结束行号。');
      sourceAt(file, side, endLine);
    } else if (endLine !== undefined) throw new AppError(400, '单行评论不接受结束行号。');
  };

  app.disable('x-powered-by');
  // 本地服务具有源码读取能力：校验 Host/Origin，并为 API 使用启动期随机令牌。
  app.use((req, res, next) => {
    const host = req.headers.host;
    const allowed = [`127.0.0.1:${req.socket.localPort}`, `localhost:${req.socket.localPort}`];
    if (!host || !allowed.includes(host))
      return res.status(403).json({ error: '仅允许本机访问。' });
    if (req.headers.origin && req.headers.origin !== `http://${host}`)
      return res.status(403).json({ error: '拒绝跨来源请求。' });
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.get('/api/bootstrap', (_req, res) => res.json({ token }));
  app.use('/api', (req, res, next) => {
    if (req.headers['x-review-token'] !== token)
      return res.status(403).json({ error: '会话已失效，请刷新页面。' });
    next();
  });
  app.use(express.json({ limit: '256kb' }));

  app.get('/api/status', async (_req, res) => res.json(await status()));
  app.post('/api/repository/pick', async (_req, res) => {
    const repo = await (options.repositoryPicker ?? pickRepository)();
    res.json(repo === null ? { cancelled: true } : { repo });
  });
  app.post('/api/repository/versions', async (req, res) => {
    const { repo } = z
      .object({ repo: z.string().min(1).max(4096) })
      .strict()
      .parse(req.body);
    res.json(await listRepositoryVersions(repo));
  });
  app.get('/api/reviews', async (_req, res) => res.json(await store.list()));
  app.get('/api/reviews/:id', async (req, res) => res.json(await store.get(id(req.params.id))));
  app.delete('/api/reviews/:id', async (req, res) => {
    const reviewId = id(req.params.id);
    if (deletingReviews.has(reviewId) ||
      [...tasks.values()].some((task) => task.reviewId === reviewId && task.active))
      throw new AppError(409, '此快照仍有任务在运行，请等待任务结束后再删除。');
    // 删除期间阻止同一快照启动新任务；源码仓库和 GitLab 不受影响。
    deletingReviews.add(reviewId);
    try {
      await store.delete(reviewId);
      res.json({ deleted: reviewId });
    } finally {
      deletingReviews.delete(reviewId);
    }
  });
  app.post('/api/reviews/:id/symbol-impact', async (req, res) => {
    const review = await store.get(id(req.params.id));
    res.json(await buildSymbolImpact(review, symbolImpactInputSchema.parse(req.body)));
  });
  app.post('/api/reviews/:id/symbol-source', async (req, res) => {
    const review = await store.get(id(req.params.id));
    res.json(await readImpactSource(review, symbolSourceInputSchema.parse(req.body)));
  });
  app.post('/api/untracked', async (req, res) => {
    const { repo } = z
      .object({ repo: z.string().min(1).max(4096) })
      .strict()
      .parse(req.body);
    res.json(await listUntracked(repo));
  });
  app.post('/api/snapshots', async (req, res) => {
    const input = snapshotInputSchema.parse(req.body);
    const requirements = parseRequirements(input.requirements, input.preserve);
    const mode = input.mode ?? 'commits';
    if (mode === 'commits' && (!input.base || !input.target || input.untracked?.length))
      throw new AppError(400, '版本比较需要基线和目标版本，且不接受未跟踪文件。');
    if (mode !== 'commits' && (input.base || input.target))
      throw new AppError(400, '提交前模式从 HEAD 对比，请不要填写两个 commit 版本。');
    const snapshot =
      mode === 'commits'
        ? await createSnapshot(input.repo, input.base!, input.target!, requirements)
        : await createLiveSnapshot(input.repo, mode, input.untracked, requirements);
    res.json(await store.create(snapshot));
  });
  app.post('/api/gitlab/import', async (req, res) => {
    const input = gitlabImportInputSchema.parse(req.body);
    const requirements = parseRequirements(input.requirements, input.preserve);
    const binding = await gitlab.load(input.repo, input.url);
    // 平台仅提供版本身份；源码仍从本地 Git 对象读取，不自动 fetch 或写入被审查仓库。
    for (const sha of [binding.baseSha, binding.headSha]) {
      try {
        await git(input.repo, ['cat-file', '-e', `${sha}^{commit}`]);
      } catch {
        throw new AppError(409, `本地仓库缺少 MR 提交 ${sha.slice(0, 8)}，请先自行获取该版本。`);
      }
    }
    const snapshot = await createSnapshot(
      input.repo,
      binding.baseSha,
      binding.headSha,
      requirements,
    );
    assertDiffMatchesSnapshot(binding.files, snapshot);
    snapshot.id = createHash('sha256')
      .update(JSON.stringify(['gitlab-v5', snapshot.id, binding.url, binding.versionId]))
      .digest('hex')
      .slice(0, 32);
    snapshot.baseLabel = `MR !${binding.iid} 基线`;
    snapshot.targetLabel = `MR !${binding.iid} 目标`;
    let previous: SavedReview | undefined;
    let comparison: ReturnType<typeof compareMrVersions> | undefined;
    if (input.previousReviewId) {
      previous = await store.get(input.previousReviewId);
      if (!previous.gitlab || previous.gitlab.url !== binding.url ||
          previous.snapshot.repo !== snapshot.repo || previous.gitlab.versionId >= binding.versionId)
        throw new AppError(400, '增量基线必须是同一仓库、同一 MR 的较早版本。');
      const candidate: SavedReview = { snapshot, gitlab: binding, guide: null };
      comparison = compareMrVersions(previous, candidate);
      inheritMrReview(previous, candidate, comparison);
      if ((candidate.commentDrafts?.length ?? 0) > 100 || (candidate.localComments?.length ?? 0) > 100)
        throw new AppError(422, '继承评论超过单份快照 100 条上限。');
    }
    await store.create(snapshot);
    await store.update(snapshot.id, (review) => {
      if (
        review.gitlab &&
        (review.gitlab.url !== binding.url || review.gitlab.versionId !== binding.versionId)
      )
        throw new AppError(409, '已有快照绑定了另一份 MR 版本。');
      if (
        review.gitlab &&
        (review.gitlab.baseSha !== binding.baseSha ||
          review.gitlab.headSha !== binding.headSha ||
          review.gitlab.startSha !== binding.startSha ||
          JSON.stringify(review.gitlab.files) !== JSON.stringify(binding.files))
      )
        throw new AppError(409, 'GitLab 在同一 diff 版本返回了不同内容，旧草稿保留待重核。');
      // 同一固定 MR 版本沿用首次保存的描述，避免后续编辑使已生成卡片的引用变义。
      review.gitlab = { ...binding, description: review.gitlab?.description ?? binding.description };
      review.commentDrafts ??= [];
      if (comparison && previous) {
        if (review.incremental && review.incremental.previousReviewId !== previous.snapshot.id)
          throw new AppError(409, '此 MR 版本已经绑定另一份增量基线，请打开已有快照。');
        if (!review.incremental) {
          inheritMrReview(previous, review, comparison);
          if ((review.commentDrafts?.length ?? 0) > 100 || (review.localComments?.length ?? 0) > 100)
            throw new AppError(422, '继承评论超过单份快照 100 条上限。');
        }
      }
    });
    res.json(await store.get(snapshot.id));
  });
  app.get('/api/reviews/:id/freshness', async (req, res) => {
    const review = await store.get(id(req.params.id));
    const { snapshot } = review;
    if (review.gitlab) {
      const fresh = await gitlab.current(review.gitlab);
      return res.json({
        fresh,
        currentId: fresh ? snapshot.id : null,
        reason: fresh ? undefined : 'GitLab MR 已产生新 diff 版本；旧草稿和人工结论待重核。',
      });
    }
    if (!snapshot.mode || snapshot.mode === 'commits')
      return res.json({ fresh: true, currentId: snapshot.id });
    try {
      const current = await createLiveSnapshot(
        snapshot.repo,
        snapshot.mode,
        snapshot.untracked,
        snapshot.requirements,
      );
      res.json({ fresh: current.id === snapshot.id, currentId: current.id });
    } catch (error) {
      if (error instanceof AppError && error.status === 409)
        return res.json({ fresh: false, currentId: null, reason: error.message });
      throw error;
    }
  });
  app.get('/api/reviews/:id/report', async (req, res) => {
    const reviewId = id(req.params.id);
    const review = await store.get(reviewId);
    if (!review.guide) throw new AppError(400, '请先生成导读再导出审查报告。');
    let fresh = false;
    try {
      fresh = await isFresh(reviewId);
    } catch (error) {
      if (!(error instanceof AppError && error.status === 409)) throw error;
    }
    res.json({
      filename: `review-${reviewId.slice(0, 8)}.md`,
      markdown: formatReviewReport(review, fresh),
    });
  });
  app.get('/api/reviews/:id/drafts/export', async (req, res) => {
    const reviewId = id(req.params.id);
    const review = await store.get(reviewId);
    if (!review.gitlab) throw new AppError(400, '此快照没有关联 GitLab MR。');
    const fresh = await isFresh(reviewId);
    res.json({
      filename: `mr-drafts-${reviewId.slice(0, 8)}.md`,
      markdown: formatCommentDrafts(review, fresh),
    });
  });
  app.post('/api/reviews/:id/drafts', async (req, res) => {
    const reviewId = id(req.params.id);
    const input = commentDraftInputSchema.parse(req.body);
    if (!/\S/.test(input.body) || !/\S/.test(input.evidence))
      throw new AppError(400, '草稿问题和人工依据都不能为空。');
    const review = await store.get(reviewId);
    if (!review.gitlab) throw new AppError(400, '此快照没有关联 GitLab MR。');
    if (!(await isFresh(reviewId)))
      throw new AppError(409, 'MR 版本已变化，请重新导入后核对评论位置。');
    const file = assertCommentAnchor(review.gitlab, input.path, input.side, input.line, input.scope, input.endLine);
    await store.update(reviewId, (latest) => {
      if (!latest.gitlab || latest.gitlab.versionId !== review.gitlab!.versionId)
        throw new AppError(409, 'MR 快照已变化，请重新打开。');
      latest.commentDrafts ??= [];
      if (latest.commentDrafts.length >= 100)
        throw new AppError(422, '每份 MR 快照最多保存 100 条草稿。');
      const now = new Date().toISOString();
      latest.commentDrafts.push({
        ...input,
        id: randomUUID(),
        oldPath: file.oldPath,
        versionId: review.gitlab!.versionId,
        anchorStatus: 'current',
        createdAt: now,
        updatedAt: now,
      });
    });
    res.json(await store.get(reviewId));
  });
  app.put('/api/reviews/:id/drafts/:draftId', async (req, res) => {
    const reviewId = id(req.params.id);
    const input = commentDraftEditSchema.parse(req.body);
    if (!/\S/.test(input.body) || !/\S/.test(input.evidence))
      throw new AppError(400, '草稿问题和人工依据都不能为空。');
    const review = await store.get(reviewId);
    if (!review.gitlab) throw new AppError(400, '此快照没有关联 GitLab MR。');
    if (!(await isFresh(reviewId)))
      throw new AppError(409, 'MR 版本已变化，请重新导入后核对评论位置。');
    if (input.path === undefined && (input.side !== undefined || input.line !== undefined ||
      input.scope !== undefined || input.endLine !== undefined))
      throw new AppError(400, '重新定位草稿需要完整的文件、侧别和行号。');
    const relocated = input.path !== undefined
      ? input.side !== undefined && input.line !== undefined
        ? assertCommentAnchor(review.gitlab, input.path, input.side, input.line, input.scope, input.endLine)
        : null
      : undefined;
    if (relocated === null) throw new AppError(400, '重新定位草稿需要完整的文件、侧别和行号。');
    await store.update(reviewId, (latest) => {
      const draft = latest.commentDrafts?.find((item) => item.id === req.params.draftId);
      if (!draft) throw new AppError(404, '未找到此评论草稿。');
      draft.body = input.body;
      draft.evidence = input.evidence;
      if (input.category !== undefined) draft.category = input.category;
      if (input.suggestion !== undefined) draft.suggestion = input.suggestion;
      if (input.resolved !== undefined) draft.resolved = input.resolved;
      if (relocated && input.path && input.side !== undefined && input.line !== undefined) {
        draft.path = input.path;
        draft.oldPath = relocated.oldPath;
        draft.side = input.side;
        draft.line = input.line;
        draft.scope = input.scope ?? 'line';
        draft.endLine = input.endLine;
        draft.anchorStatus = 'current';
        draft.anchorReason = '人工重新定位';
      }
      draft.updatedAt = new Date().toISOString();
    });
    res.json(await store.get(reviewId));
  });
  app.delete('/api/reviews/:id/drafts/:draftId', async (req, res) => {
    const reviewId = id(req.params.id);
    await store.update(reviewId, (latest) => {
      if (!latest.gitlab) throw new AppError(400, '此快照没有关联 GitLab MR。');
      const drafts = latest.commentDrafts ?? [];
      if (!drafts.some((item) => item.id === req.params.draftId))
        throw new AppError(404, '未找到此评论草稿。');
      latest.commentDrafts = drafts.filter((item) => item.id !== req.params.draftId);
    });
    res.json(await store.get(reviewId));
  });
  app.put('/api/reviews/:id/claims', async (req, res) => {
    const reviewId = id(req.params.id);
    const input = claimStateInputSchema.parse(req.body);
    const current = await store.get(reviewId);
    if (
      !current.guide ||
      current.guideFingerprint !== input.guideFingerprint ||
      !listClaims(current.guide).some((claim) => claim.key === input.key)
    )
      throw new AppError(409, '导读判断已变化，请重新打开快照。');
    if (input.status !== 'unread' && !/\S/.test(input.evidence))
      throw new AppError(400, '保存逐条判断前，请填写人工依据或疑问。');
    if (input.status !== 'unread' && !(await isFresh(reviewId)))
      throw new AppError(409, '源码已变化，请创建新快照后再判断。');
    await store.update(reviewId, (latest) => {
      if (
        !latest.guide ||
        latest.guideFingerprint !== input.guideFingerprint ||
        !listClaims(latest.guide).some((claim) => claim.key === input.key)
      )
        throw new AppError(409, '导读判断已变化，请重新打开快照。');
      latest.claimStates ??= {};
      if (input.status === 'unread') delete latest.claimStates[input.key];
      else
        latest.claimStates[input.key] = {
          status: input.status,
          evidence: input.evidence,
          guideFingerprint: input.guideFingerprint,
          updatedAt: new Date().toISOString(),
        };
    });
    res.json(await store.get(reviewId));
  });
  app.put('/api/reviews/:id/file-states', async (req, res) => {
    const reviewId = id(req.params.id);
    const input = fileStateInputSchema.parse(req.body);
    if (!(await isFresh(reviewId)))
      throw new AppError(409, '源码已变化，请创建新快照后再更新文件状态。');
    await store.update(reviewId, (review) => {
      const file = review.snapshot.files.find((item) => item.id === input.fileId);
      if (!file || fileFingerprint(file) !== input.fingerprint)
        throw new AppError(409, '文件内容身份已变化，请重新打开快照。');
      review.fileStates ??= {};
      // 未阅读是旧记录的默认状态，删除显式状态避免自动完成或跨版本继承。
      if (input.status === 'unread') {
        delete review.fileStates[input.fileId];
        for (const change of file.changes) delete review.hunkStates?.[change.id];
      }
      else review.fileStates[input.fileId] = {
        status: input.status,
        fingerprint: input.fingerprint,
        updatedAt: new Date().toISOString(),
      };
      if (input.status === 'reviewed') {
        review.hunkStates ??= {};
        for (const change of file.changes.filter((item) => item.id.includes(':hunk-')))
          review.hunkStates[change.id] = { status: 'reviewed', fingerprint: hunkFingerprint(file, change), updatedAt: new Date().toISOString() };
      }
    });
    res.json(await store.get(reviewId));
  });

  app.put('/api/reviews/:id/hunk-states', async (req, res) => {
    const reviewId = id(req.params.id);
    const input = hunkStateInputSchema.parse(req.body);
    if (!(await isFresh(reviewId)))
      throw new AppError(409, '源码已变化，请创建新快照后再更新变更块状态。');
    await store.update(reviewId, (review) => {
      const file = review.snapshot.files.find((item) => item.id === input.fileId);
      const change = file?.changes.find((item) => item.id === input.changeId && item.id.includes(':hunk-'));
      if (!file || !change)
        throw new AppError(409, '变更块不属于当前快照，请重新打开。');
      const fingerprint = hunkFingerprint(file, change);
      review.hunkStates ??= {};
      if (input.status === 'unread') delete review.hunkStates[change.id];
      else review.hunkStates[change.id] = { status: input.status, fingerprint,
        updatedAt: new Date().toISOString() };
      const statuses = file.changes.filter((item) => item.id.includes(':hunk-'))
        .map((item) => review.hunkStates?.[item.id]?.status ?? 'unread');
      review.fileStates ??= {};
      if (statuses.length && statuses.every((status) => status === 'reviewed'))
        review.fileStates[file.id] = { status: 'reviewed', fingerprint: fileFingerprint(file), updatedAt: new Date().toISOString() };
      else if (review.fileStates[file.id]?.status === 'reviewed')
        delete review.fileStates[file.id];
    });
    res.json(await store.get(reviewId));
  });

  app.put('/api/reviews/:id/hunk-understanding', async (req, res) => {
    const reviewId = id(req.params.id);
    const input = hunkUnderstandingInputSchema.parse(req.body);
    if (input.status === 'verified' && !/\S/.test(input.evidence))
      throw new AppError(400, '标记已核实前，请填写人工核实依据。');
    if (!(await isFresh(reviewId)))
      throw new AppError(409, '源码版本已变化，请重新导入后核对逐块结论。');
    await store.update(reviewId, (review) => {
      const card = review.hunkExplanations?.[input.changeId];
      if (!card || card.guideFingerprint !== review.guideFingerprint ||
          card.guideFingerprint !== input.guideFingerprint || card.fingerprint !== input.explanationFingerprint)
        throw new AppError(409, '逐块解释已变化，请刷新后重新核对。');
      review.hunkUnderstandingStates ??= {};
      if (input.status === 'unread') delete review.hunkUnderstandingStates[input.changeId];
      else review.hunkUnderstandingStates[input.changeId] = {
        status: input.status, evidence: input.evidence,
        guideFingerprint: input.guideFingerprint,
        explanationFingerprint: input.explanationFingerprint,
        updatedAt: new Date().toISOString(),
      };
    });
    res.json(await store.get(reviewId));
  });

  app.put('/api/reviews/:id/reading-position', async (req, res) => {
    const reviewId = id(req.params.id);
    const input = readingPositionInputSchema.parse(req.body);
    await store.update(reviewId, (review) => {
      const file = review.snapshot.files.find((item) => item.id === input.fileId);
      if (!file) throw new AppError(400, '阅读文件不属于此快照。');
      sourceAt(file, input.side, input.line);
      if (input.changeId && !file.changes.some((item) => item.id === input.changeId))
        throw new AppError(400, '变更块不属于此文件。');
      review.readingPosition = input;
    });
    res.json({ saved: true });
  });

  app.post('/api/reviews/:id/local-comments', async (req, res) => {
    const reviewId = id(req.params.id);
    const input = localCommentInputSchema.parse(req.body);
    if (!/\S/.test(input.body) || !/\S/.test(input.evidence))
      throw new AppError(400, '评论问题和人工依据都不能为空。');
    if (!(await isFresh(reviewId)))
      throw new AppError(409, '源码已变化，请创建新快照后再评论。');
    await store.update(reviewId, (review) => {
      const file = review.snapshot.files.find((item) => item.id === input.fileId);
      if (!file || fileFingerprint(file) !== input.fingerprint)
        throw new AppError(409, '文件内容身份已变化，请重新打开快照。');
      localAnchor(file, input.side, input.line, input.scope, input.endLine);
      review.localComments ??= [];
      if (review.localComments.length >= 100)
        throw new AppError(422, '每份快照最多保存 100 条本地评论。');
      const now = new Date().toISOString();
      review.localComments.push({
        ...input,
        id: randomUUID(),
        path: file.path,
        anchorStatus: 'current',
        createdAt: now,
        updatedAt: now,
      });
    });
    res.json(await store.get(reviewId));
  });

  app.put('/api/reviews/:id/local-comments/:commentId', async (req, res) => {
    const reviewId = id(req.params.id);
    const input = localCommentEditSchema.parse(req.body);
    if (!/\S/.test(input.body) || !/\S/.test(input.evidence))
      throw new AppError(400, '评论问题和人工依据都不能为空。');
    if (!(await isFresh(reviewId)))
      throw new AppError(409, '源码已变化，请创建新快照后再编辑评论。');
    if (input.fileId === undefined && (input.fingerprint !== undefined ||
      input.side !== undefined || input.line !== undefined || input.scope !== undefined || input.endLine !== undefined))
      throw new AppError(400, '重新定位评论需要完整的文件、侧别和行号。');
    await store.update(reviewId, (review) => {
      const comment = review.localComments?.find((item) => item.id === req.params.commentId);
      if (!comment) throw new AppError(404, '未找到此本地评论。');
      const file = review.snapshot.files.find((item) => item.id === (input.fileId ?? comment.fileId));
      if (input.fileId) {
        if (!file || fileFingerprint(file) !== input.fingerprint || input.side === undefined || input.line === undefined)
          throw new AppError(409, '重新定位的文件内容身份已变化。');
        localAnchor(file, input.side, input.line, input.scope, input.endLine);
        comment.fileId = file.id;
        comment.fingerprint = input.fingerprint!;
        comment.path = file.path;
        comment.side = input.side;
        comment.line = input.line;
        comment.scope = input.scope ?? 'line';
        comment.endLine = input.endLine;
        comment.anchorStatus = 'current';
        comment.anchorReason = '人工重新定位';
      } else if (comment.anchorStatus !== 'pending' && (!file || fileFingerprint(file) !== comment.fingerprint))
        throw new AppError(409, '评论对应的文件内容身份已变化。');
      comment.body = input.body;
      comment.evidence = input.evidence;
      if (input.category !== undefined) comment.category = input.category;
      if (input.suggestion !== undefined) comment.suggestion = input.suggestion;
      if (input.resolved !== undefined) comment.resolved = input.resolved;
      comment.updatedAt = new Date().toISOString();
    });
    res.json(await store.get(reviewId));
  });

  app.delete('/api/reviews/:id/local-comments/:commentId', async (req, res) => {
    const reviewId = id(req.params.id);
    await store.update(reviewId, (review) => {
      if (!review.localComments?.some((item) => item.id === req.params.commentId))
        throw new AppError(404, '未找到此本地评论。');
      review.localComments = review.localComments.filter((item) => item.id !== req.params.commentId);
    });
    res.json(await store.get(reviewId));
  });

  async function startTask(
    reviewId: string,
    hunkId?: string,
    includeHunks = false,
  ): Promise<TaskStatus> {
    if (deletingReviews.has(reviewId)) throw new AppError(409, '此快照正在删除，请稍后重试。');
    const review = await store.get(reviewId);
    if (hunkId && !review.guideFingerprint) throw new AppError(400, '请先生成阅读路线。');
    if (!review.snapshot.files.length) throw new AppError(400, '这两个版本之间没有变更。');
    const prompt = hunkId ? buildHunkPrompt(review, [hunkId]) : undefined;
    let commitContext: CommitContext | undefined;
    let batches: ReturnType<typeof planGuideBatches> | undefined;
    if (!hunkId) {
      try {
        commitContext = await readCommitContext(review.snapshot);
      } catch {
        // 固定快照已保存，提交描述读取失败不应阻止基于 diff 的阅读路线。
        commitContext = { messages: [], note: '提交描述读取失败，本次只使用固定 diff。' };
      }
      try {
        batches = planGuideBatches(review.snapshot, commitContext);
      } catch (error) {
        if (!(error instanceof AppError) || error.status !== 422 || !commitContext.messages.length) throw error;
        // 提交描述是可选线索；超出上下文上限时保留原有纯 diff 导读能力并明确标记未使用。
        commitContext = { messages: [], note: '提交描述使导读上下文超限，本次只使用固定 diff。' };
        batches = planGuideBatches(review.snapshot, commitContext);
      }
    }
    if (deletingReviews.has(reviewId)) throw new AppError(409, '此快照正在删除，请稍后重试。');
    if ([...tasks.values()].some((task) => task.active))
      throw new AppError(409, '已有导读任务正在执行或退出，请稍后重试。');
    // 首版单任务执行，避免重复点击和多标签页重复消耗订阅额度。
    const task: Task = {
      id: randomUUID(),
      reviewId,
      kind: hunkId ? 'hunk' : 'guide',
      state: 'running',
      progress: ['正在检查 Codex 登录…'],
      error: null,
      controller: new AbortController(),
      persisting: false,
      active: true,
    };
    tasks.set(task.id, task);
    if (tasks.size > 100) {
      const oldest = [...tasks.values()].find((item) => item.state !== 'running');
      if (oldest) tasks.delete(oldest.id);
    }
    void (async () => {
      try {
        const onProgress = (message: string) => {
          task.progress = [...task.progress.slice(-19), message];
        };
        if (hunkId) {
          const raw = await provider.generate({ prompt: prompt!, schema: hunkExplanationBatchSchema,
            signal: task.controller.signal, onProgress });
          if (task.controller.signal.aborted) return;
          const [card] = validateHunkExplanations(raw, review, [hunkId]);
          task.persisting = true;
          await store.update(reviewId, (latest) => {
            if (latest.guideFingerprint !== review.guideFingerprint)
              throw new AppError(409, '导读已变化，逐块解释未保存。');
            latest.hunkExplanations ??= {};
            latest.hunkExplanations[hunkId] = card;
          });
        } else {
          const guides = [];
          for (const [index, batch] of batches!.entries()) {
            if (task.controller.signal.aborted) return;
            if (batches!.length > 1) onProgress(`正在分析第 ${index + 1}/${batches!.length} 批源码…`);
            const raw = await provider.generate({
              prompt: batch.prompt,
              schema: guideSchema,
              signal: task.controller.signal,
              onProgress,
            });
            if (task.controller.signal.aborted) return;
            guides.push(validateGuide(raw, batch.snapshot));
          }
          const guide = batches!.length === 1
            ? guides[0]
            : validateGuide(mergeGuideBatches(guides), review.snapshot);
          const cards: HunkExplanation[] = [];
          if (includeHunks) {
            const nextReview = { ...review, guide, guideFingerprint: guideFingerprint(guide) };
            const planned = planHunkBatches(nextReview);
            for (const [index, batch] of planned.entries()) {
              if (task.controller.signal.aborted) return;
              onProgress(`正在生成第 ${index + 1}/${planned.length} 批逐块解释…`);
              const raw = await provider.generate({ prompt: batch.prompt, schema: hunkExplanationBatchSchema,
                signal: task.controller.signal, onProgress });
              if (task.controller.signal.aborted) return;
              cards.push(...validateHunkExplanations(raw, nextReview, batch.changeIds));
            }
          }
          task.persisting = true;
          await store.update(reviewId, (latest) => {
            latest.guide = guide;
            latest.commitContext = commitContext;
            if (includeHunks) latest.hunkExplanations = Object.fromEntries(cards.map((card) => [card.changeId, card]));
          });
        }
        task.state = 'completed';
        task.progress.push('结果已保存。源码引用及变更覆盖已校验，业务解释仍需人工核对。');
      } catch (error) {
        if (task.controller.signal.aborted) task.state = 'cancelled';
        else {
          task.state = 'failed';
          task.error =
            error instanceof ZodError
              ? 'Codex 输出不符合导读结构，结果未保存。'
              : errorMessage(error);
        }
      } finally {
        task.active = false;
      }
    })();
    return publicTask(task);
  }

  app.post('/api/reviews/:id/guide', async (req, res) => {
    const input = guideGenerationInputSchema.parse(req.body ?? {});
    res.status(202).json(await startTask(id(req.params.id), undefined, input.hunkMode === 'all'));
  });
  app.post('/api/reviews/:id/hunk-explanations', async (req, res) => {
    const input = hunkGenerationInputSchema.parse(req.body);
    res.status(202).json(await startTask(id(req.params.id), input.changeId));
  });
  app.get('/api/tasks', (_req, res) =>
    res.json([...tasks.values()].filter((task) => task.state === 'running').map(publicTask)),
  );
  app.get('/api/tasks/:id', (req, res) => {
    const task = tasks.get(String(req.params.id));
    if (!task) throw new AppError(404, '任务不存在或服务已重启。');
    res.json(publicTask(task));
  });
  app.post('/api/tasks/:id/cancel', (req, res) => {
    const task = tasks.get(String(req.params.id));
    if (!task) throw new AppError(404, '任务不存在。');
    if (task.persisting && task.state === 'running')
      throw new AppError(409, '结果已经生成，正在保存。');
    if (task.state === 'running') {
      task.controller.abort();
      task.state = 'cancelled';
      task.progress.push('已取消，保留已有结果。');
    }
    res.json(publicTask(task));
  });
  app.use('/api', (_req, res) => res.status(404).json({ error: '接口不存在。' }));
  app.use(
    (error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      const statusCode =
        error instanceof AppError
          ? error.status
          : error instanceof ZodError
          ? 400
          : (error as { type?: string }).type === 'entity.too.large'
          ? 413
          : 500;
      const message =
        error instanceof ZodError
          ? '输入格式不正确，请检查路径、版本和字段。'
          : errorMessage(error);
      res.status(statusCode).json({ error: message });
    },
  );
  return {
    app,
    stop: () => {
      for (const task of tasks.values()) if (task.state === 'running') task.controller.abort();
    },
  };
}
