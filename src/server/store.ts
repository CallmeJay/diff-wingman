import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ReviewSummary, SavedReview, Snapshot } from '../shared/types.js';
import { AppError } from './errors.js';
import { guideFingerprint } from './guide.js';

export class ReviewStore {
  constructor(readonly directory: string) {}
  private migration?: Promise<void>;

  // 首次访问时原子清除已移除功能的历史字段；快照、评论和逐条判断不变。
  private ensureMigration(): Promise<void> {
    this.migration ??= (async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const files = (await readdir(this.directory)).filter((name) => /^[a-f0-9]{32}\.json$/.test(name));
      for (const name of files) {
        const destination = path.join(this.directory, name);
        const data = JSON.parse(await readFile(destination, 'utf8')) as Record<string, unknown>;
        if ((data.snapshot as Snapshot | undefined)?.id !== name.slice(0, -5))
          throw new AppError(500, '本地快照身份不一致，请重新创建快照。');
        if (!['notes', 'verificationRecords', 'reviewStates', 'answers', 'groupHashes']
          .some((key) => Object.hasOwn(data, key))) continue;
        delete data.notes;
        delete data.verificationRecords;
        delete data.reviewStates;
        delete data.answers;
        delete data.groupHashes;
        await this.write(destination, data);
      }
    })();
    return this.migration;
  }

  private async write(destination: string, data: object): Promise<void> {
    const temporary = `${destination}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(data), { mode: 0o600 });
    await rename(temporary, destination);
  }

  private file(id: string): string {
    if (!/^[a-f0-9]{32}$/.test(id)) throw new AppError(400, '无效的快照 ID。');
    return path.join(this.directory, `${id}.json`);
  }

  async get(id: string): Promise<SavedReview> {
    const filename = this.file(id);
    await this.ensureMigration();
    let text: string;
    try {
      text = await readFile(filename, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        throw new AppError(404, '未找到此快照。');
      throw error;
    }
    const data = JSON.parse(text) as SavedReview;
    if (data.snapshot.id !== id) throw new AppError(500, '本地快照身份不一致，请重新创建快照。');
    data.guideFingerprint = data.guide ? guideFingerprint(data.guide) : undefined;
    return data;
  }

  // 原子替换避免退出时留下半份 JSON；数据只写入工具目录，不进入被审查仓库。
  async save(review: SavedReview): Promise<void> {
    await this.ensureMigration();
    const destination = this.file(review.snapshot.id);
    const data = { ...review } as SavedReview & { notes?: unknown; verificationRecords?: unknown;
      reviewStates?: unknown; answers?: unknown; groupHashes?: unknown };
    delete data.notes;
    delete data.verificationRecords;
    delete data.reviewStates;
    delete data.answers;
    delete data.groupHashes;
    await this.write(destination, data);
  }

  async create(snapshot: Snapshot): Promise<SavedReview> {
    try {
      const existing = await this.get(snapshot.id);
      const oldRefs = new Map(existing.snapshot.refs.map((ref) => [ref.id, ref]));
      const unchanged = existing.snapshot.refs.every((ref) => {
        const current = snapshot.refs.find((item) => item.id === ref.id);
        return (
          current &&
          ref.side === current.side &&
          ref.path === current.path &&
          ref.blobOid === current.blobOid &&
          ref.code === current.code
        );
      });
      const added = unchanged
        ? snapshot.refs.filter((ref) => ref.role === 'reference' && !oldRefs.has(ref.id))
        : [];
      if (added.length) {
        // 同一源码身份的旧快照只补充静态引用，不覆盖原导读或人工记录。
        await this.update(snapshot.id, (review) => {
          const known = new Set(review.snapshot.refs.map((ref) => ref.id));
          review.snapshot.refs.push(...added.filter((ref) => !known.has(ref.id)));
          review.snapshot.gaps = snapshot.gaps;
        });
        return this.get(snapshot.id);
      }
      return existing;
    } catch (error) {
      if (!(error instanceof AppError) || error.status !== 404) throw error;
    }
    const review: SavedReview = {
      snapshot,
      guide: null,
      claimStates: {},
    };
    await this.save(review);
    return review;
  }

  // 同一快照的写入串行化，人工状态和异步 AI 返回不会互相覆盖。
  private pending = new Map<string, Promise<void>>();
  async update(id: string, change: (review: SavedReview) => void): Promise<void> {
    const previous = this.pending.get(id) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        const review = await this.get(id);
        change(review);
        await this.save(review);
      });
    this.pending.set(id, next);
    try {
      await next;
    } finally {
      if (this.pending.get(id) === next) this.pending.delete(id);
    }
  }

  // 删除排在同一快照已提交的写入之后，避免异步保存把已删除的文件重新写回。
  async delete(id: string): Promise<void> {
    const destination = this.file(id);
    await this.ensureMigration();
    const previous = this.pending.get(id) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(async () => {
      try {
        await unlink(destination);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT')
          throw new AppError(404, '未找到此快照。');
        throw error;
      }
    });
    this.pending.set(id, next);
    try {
      await next;
    } finally {
      if (this.pending.get(id) === next) this.pending.delete(id);
    }
  }

  async list(): Promise<ReviewSummary[]> {
    await this.ensureMigration();
    const files = (await readdir(this.directory)).filter((name) =>
      /^[a-f0-9]{32}\.json$/.test(name),
    );
    const reviews = await Promise.all(files.map((name) => this.get(name.slice(0, -5))));
    return reviews
      .map(({ snapshot, guide, gitlab }) => ({
        id: snapshot.id,
        repo: snapshot.repo,
        base: snapshot.base,
        target: snapshot.target,
        createdAt: snapshot.createdAt,
        files: snapshot.files.length,
        hasGuide: guide !== null,
        mode: snapshot.mode ?? 'commits',
        gitlabUrl: gitlab?.url,
        gitlabVersionId: gitlab?.versionId,
      }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}
