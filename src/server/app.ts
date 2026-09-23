import express from 'express';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z, ZodError } from 'zod';
import type { Requirement, TaskStatus, VerificationTaskStatus } from '../shared/types.js';
import { listClaims } from '../shared/claims.js';
import {
  answerSchema,
  claimStateInputSchema,
  commentDraftEditSchema,
  commentDraftInputSchema,
  gitlabImportInputSchema,
  guideSchema,
  noteInputSchema,
  questionInputSchema,
  reviewStateInputSchema,
  snapshotInputSchema,
  verificationInputSchema,
} from '../shared/schemas.js';
import { AppError, errorMessage } from './errors.js';
import { createLiveSnapshot, createSnapshot, git, listRepositoryVersions, listUntracked } from './git.js';
import { pickRepository } from './folder-picker.js';
import { buildPrompt, mergeGuideBatches, planGuideBatches, validateAnswer, validateGuide } from './guide.js';
import { CodexProvider, getCodexStatus, type GuideProvider } from './codex.js';
import { ReviewStore } from './store.js';
import { formatCommentDrafts, formatReviewReport } from './report.js';
import {
  assertCommentLine,
  assertDiffMatchesSnapshot,
  GitLabClient,
  type GitLabReader,
} from './gitlab.js';
import {
  DockerVerifier,
  verificationCases,
  verificationScripts,
  type VerificationRunner,
} from './verification.js';

interface Task extends TaskStatus {
  controller: AbortController;
  persisting: boolean;
  active: boolean;
}

export function createApp(options: {
  store: ReviewStore;
  provider?: GuideProvider;
  status?: typeof getCodexStatus;
  verifier?: VerificationRunner;
  gitlab?: GitLabReader;
  repositoryPicker?: () => Promise<string | null>;
}) {
  const app = express();
  const token = randomBytes(32).toString('hex');
  const tasks = new Map<string, Task>();
  const verificationTasks = new Map<
    string,
    VerificationTaskStatus & { controller: AbortController }
  >();
  const provider = options.provider ?? new CodexProvider();
  const status = options.status ?? getCodexStatus;
  const store = options.store;
  const verifier = options.verifier ?? new DockerVerifier();
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
      review.gitlab = binding;
      review.commentDrafts ??= [];
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
    const file = assertCommentLine(review.gitlab, input.path, input.side, input.line);
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
    await store.update(reviewId, (latest) => {
      const draft = latest.commentDrafts?.find((item) => item.id === req.params.draftId);
      if (!draft) throw new AppError(404, '未找到此评论草稿。');
      draft.body = input.body;
      draft.evidence = input.evidence;
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
  app.get('/api/reviews/:id/verification-options', async (req, res) => {
    const review = await store.get(id(req.params.id));
    if (!review.guide) throw new AppError(400, '请先生成导读。');
    const commits = !review.snapshot.mode || review.snapshot.mode === 'commits';
    const [scripts, runtime] = commits
      ? await Promise.all([verificationScripts(review.snapshot), verifier.availability()])
      : [[], { available: false, reason: '第四版目前只支持两个 commit 的快照。', imageId: '' }];
    res.json({
      available: runtime.available,
      reason: runtime.reason,
      image: process.env.REVIEW_HELPER_VERIFY_IMAGE ?? 'node:22-alpine',
      scripts,
      cases: verificationCases(review),
    });
  });
  app.post('/api/reviews/:id/verifications', async (req, res) => {
    const reviewId = id(req.params.id);
    const input = verificationInputSchema.parse(req.body);
    const review = await store.get(reviewId);
    if (!review.guide || review.guideFingerprint !== input.guideFingerprint)
      throw new AppError(409, '导读已变化，请刷新验证清单。');
    if (review.snapshot.mode && review.snapshot.mode !== 'commits')
      throw new AppError(400, '第四版目前只支持两个 commit 的固定快照。');
    if (!/\S/.test(input.trigger) || !/\S/.test(input.expected))
      throw new AppError(400, '请填写触发条件和预期可观察结果。');
    const check = verificationCases(review).find((item) => item.id === input.caseId);
    const script = (await verificationScripts(review.snapshot)).find(
      (item) => item.name === input.scriptName,
    );
    if (!check || !script) throw new AppError(400, '验证对象或脚本不属于当前快照。');
    const runtime = await verifier.availability();
    if (!runtime.available) throw new AppError(503, runtime.reason);
    if ([...verificationTasks.values()].some((task) => task.state === 'running'))
      throw new AppError(409, '已有隔离验证正在运行，请等待完成。');
    const task: VerificationTaskStatus & { controller: AbortController } = {
      id: randomUUID(),
      reviewId,
      state: 'running',
      error: null,
      recordId: null,
      controller: new AbortController(),
    };
    verificationTasks.set(task.id, task);
    // 只在用户提交明确检查项后执行；结果作为运行证据保存，不自动修改人工判断。
    void (async () => {
      try {
        const evidence = await verifier.run(review.snapshot, script.name, task.controller.signal);
        const recordId = randomUUID();
        await store.update(reviewId, (latest) => {
          latest.verificationRecords ??= [];
          latest.verificationRecords.push({
            id: recordId,
            caseId: check.id,
            caseTitle: check.title,
            trigger: input.trigger,
            expected: input.expected,
            scriptName: script.name,
            scriptBody: script.body,
            snapshotId: review.snapshot.id,
            target: review.snapshot.target,
            guideFingerprint: input.guideFingerprint,
            ...evidence,
          });
        });
        task.recordId = recordId;
        task.state = 'completed';
      } catch (error) {
        task.state = 'failed';
        task.error = errorMessage(error);
      }
    })();
    const { controller: _controller, ...publicTask } = task;
    res.status(202).json(publicTask);
  });
  app.get('/api/verifications/:id', (req, res) => {
    const task = verificationTasks.get(String(req.params.id));
    if (!task) throw new AppError(404, '未找到验证任务。');
    const { controller: _controller, ...publicTask } = task;
    res.json(publicTask);
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
  app.put('/api/reviews/:id/states', async (req, res) => {
    const reviewId = id(req.params.id);
    const input = reviewStateInputSchema.parse(req.body);
    if (input.status === 'verified' && !/\S/.test(input.evidence))
      throw new AppError(400, '标记已核实前，请填写人工核实依据。');
    const current = await store.get(reviewId);
    if (input.status === 'verified' && current.gitlab && !(await isFresh(reviewId)))
      throw new AppError(409, 'MR 版本已变化，请重新导入后核对人工结论。');
    if (
      input.status === 'verified' &&
      current.snapshot.mode &&
      current.snapshot.mode !== 'commits'
    ) {
      const fresh = await createLiveSnapshot(
        current.snapshot.repo,
        current.snapshot.mode,
        current.snapshot.untracked,
        current.snapshot.requirements,
      );
      if (fresh.id !== reviewId) throw new AppError(409, '源码已变化，请创建新快照后再确认。');
    }
    await store.update(reviewId, (review) => {
      if (!review.guide || review.groupHashes?.[input.groupIndex] !== input.guideHash)
        throw new AppError(409, '导读分组已变化，请重新打开快照。');
      review.reviewStates ??= {};
      if (input.status === 'unread') delete review.reviewStates[input.guideHash];
      else
        review.reviewStates[input.guideHash] = {
          status: input.status,
          evidence: input.evidence,
          guideHash: input.guideHash,
          updatedAt: new Date().toISOString(),
        };
    });
    res.json(await store.get(reviewId));
  });
  app.put('/api/reviews/:id/notes', async (req, res) => {
    const reviewId = id(req.params.id);
    const input = noteInputSchema.parse(req.body);
    await store.update(reviewId, (review) => {
      if (
        input.key !== 'overview' &&
        !review.snapshot.files.some((file) => input.key === `file:${file.id}`)
      )
        throw new AppError(400, '笔记目标不属于当前快照。');
      review.notes[input.key] = input.text;
    });
    res.json({ saved: true });
  });

  async function startTask(
    reviewId: string,
    question?: z.infer<typeof questionInputSchema>,
  ): Promise<TaskStatus> {
    const review = await store.get(reviewId);
    const group = question ? review.guide?.groups[question.groupIndex] : undefined;
    if (question && !group) throw new AppError(400, '请先选择已有的导读分组。');
    if (!review.snapshot.files.length) throw new AppError(400, '这两个版本之间没有变更。');
    const prompt = question && group
      ? buildPrompt(review.snapshot, { question: question.question, group })
      : undefined;
    const batches = question ? undefined : planGuideBatches(review.snapshot);
    if ([...tasks.values()].some((task) => task.active))
      throw new AppError(409, '已有导读任务正在执行或退出，请稍后重试。');
    // 首版单任务执行，避免重复点击和多标签页重复消耗订阅额度。
    const task: Task = {
      id: randomUUID(),
      reviewId,
      kind: question ? 'question' : 'guide',
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
        if (question && group) {
          const raw = await provider.generate({
            prompt: prompt!,
            schema: answerSchema,
            signal: task.controller.signal,
            onProgress,
          });
          if (task.controller.signal.aborted) return;
          const answer = validateAnswer(raw, review.snapshot);
          task.persisting = true;
          await store.update(reviewId, (latest) => {
            latest.answers.push({
              question: question.question,
              groupIndex: question.groupIndex,
              groupTitle: group.title,
              answer,
              createdAt: new Date().toISOString(),
            });
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
          task.persisting = true;
          await store.update(reviewId, (latest) => {
            latest.guide = guide;
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

  app.post('/api/reviews/:id/guide', async (req, res) =>
    res.status(202).json(await startTask(id(req.params.id))),
  );
  app.post('/api/reviews/:id/questions', async (req, res) =>
    res.status(202).json(await startTask(id(req.params.id), questionInputSchema.parse(req.body))),
  );
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
      for (const task of verificationTasks.values())
        if (task.state === 'running') task.controller.abort();
    },
  };
}
