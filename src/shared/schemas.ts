import { z } from 'zod';

export const statementSchema = z
  .object({
    text: z.string().min(1).max(5000),
    basis: z.enum(['source', 'inference']),
    refIds: z.array(z.string()).max(30),
  })
  .strict();

export const guideSchema = z
  .object({
    overview: z.string().min(1).max(5000),
    groups: z
      .array(
        z
          .object({
            title: z.string().min(1).max(200),
            changeIds: z.array(z.string()).min(1),
            before: statementSchema,
            after: statementSchema,
            notes: z.array(statementSchema).max(20),
            questions: z.array(z.string().min(1).max(2000)).max(20),
          })
          .strict(),
      )
      .max(100),
    unreviewed: z.array(
      z.object({ changeId: z.string(), reason: z.string().min(1).max(2000) }).strict(),
    ),
    limitations: z.array(z.string().min(1).max(2000)).max(30),
    requirementLinks: z
      .array(
        z
          .object({
            requirementId: z.string(),
            statement: statementSchema,
            changeIds: z.array(z.string()).max(300),
          })
          .strict(),
      )
      .max(100),
    flowSteps: z
      .array(
        z
          .object({
            groupIndex: z.number().int().nonnegative(),
            stage: z.enum(['入口', '输入', '调用', '状态', '结果']),
            statement: statementSchema,
          })
          .strict(),
      )
      .max(500),
  })
  .strict();

export const snapshotInputSchema = z
  .object({
    repo: z.string().min(1).max(4096),
    mode: z.enum(['commits', 'staged', 'working']).optional(),
    base: z.string().min(1).max(256).optional(),
    target: z.string().min(1).max(256).optional(),
    untracked: z.array(z.string().min(1).max(4096)).max(300).optional(),
    requirements: z.string().max(10_000).optional(),
    preserve: z.string().max(10_000).optional(),
  })
  .strict();

export const gitlabImportInputSchema = z
  .object({
    repo: z.string().min(1).max(4096),
    url: z.string().min(1).max(4096),
    requirements: z.string().max(10_000).optional(),
    preserve: z.string().max(10_000).optional(),
    previousReviewId: z.string().regex(/^[a-f0-9]{32}$/).optional(),
  })
  .strict();

const commentFields = {
  scope: z.enum(['line', 'range', 'file']).optional(),
  endLine: z.number().int().positive().optional(),
  category: z.enum(['problem', 'blocking', 'suggestion', 'detail']).optional(),
  suggestion: z.string().max(5000).optional(),
  resolved: z.boolean().optional(),
};

export const commentDraftInputSchema = z
  .object({
    path: z.string().min(1).max(4096),
    side: z.enum(['before', 'after']),
    line: z.number().int().nonnegative(),
    body: z.string().min(1).max(5000),
    evidence: z.string().min(1).max(5000),
    ...commentFields,
  })
  .strict();

export const commentDraftEditSchema = z
  .object({
    body: z.string().min(1).max(5000),
    evidence: z.string().min(1).max(5000),
    ...commentFields,
    path: z.string().min(1).max(4096).optional(),
    side: z.enum(['before', 'after']).optional(),
    line: z.number().int().nonnegative().optional(),
  })
  .strict();

export const claimStateInputSchema = z
  .object({
    key: z.string().min(1).max(100),
    guideFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    status: z.enum(['unread', 'confirmed', 'question', 'rejected']),
    evidence: z.string().max(5000),
  })
  .strict();

export const fileStateInputSchema = z.object({
  fileId: z.string().min(1).max(100),
  fingerprint: z.string().min(1).max(10000),
  status: z.enum(['unread', 'in_progress', 'question', 'reviewed']),
}).strict();

export const hunkStateInputSchema = z.object({
  fileId: z.string().min(1).max(100),
  changeId: z.string().min(1).max(100),
  status: z.enum(['unread', 'in_progress', 'question', 'reviewed']),
}).strict();

export const hunkEvidenceSchema = z.object({
  text: z.string().min(1).max(3000),
  basis: z.enum(['source', 'requirement', 'mr', 'inference', 'pending']),
  refIds: z.array(z.string()).max(12),
  requirementId: z.string().optional(),
  mrExcerpt: z.string().max(1000).optional(),
}).strict();

export const hunkExplanationSchema = z.object({
  changeId: z.string(),
  what: hunkEvidenceSchema,
  before: hunkEvidenceSchema,
  after: hunkEvidenceSchema,
  impacts: z.array(hunkEvidenceSchema).max(8),
  failures: z.array(hunkEvidenceSchema).max(8),
  tests: z.array(hunkEvidenceSchema).max(8),
  pending: z.array(hunkEvidenceSchema).max(8),
}).strict();

export const hunkExplanationBatchSchema = z.object({
  cards: z.array(hunkExplanationSchema).max(20),
}).strict();

export const hunkUnderstandingInputSchema = z.object({
  changeId: z.string().min(1).max(100),
  status: z.enum(['unread', 'understood', 'question', 'verified']),
  evidence: z.string().max(5000),
  guideFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  explanationFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export const guideGenerationInputSchema = z.object({
  hunkMode: z.enum(['all', 'on_demand']).optional(),
}).strict();

export const hunkGenerationInputSchema = z.object({
  changeId: z.string().min(1).max(100),
}).strict();

export const symbolImpactInputSchema = z.object({
  path: z.string().min(1).max(4096),
  side: z.enum(['before', 'after']),
  line: z.number().int().positive(),
  startColumn: z.number().int().positive(),
  endColumn: z.number().int().positive(),
  expand: z.boolean().optional(),
}).strict().refine((value) => value.endColumn > value.startColumn, '请选择完整标识符。');

export const symbolSourceInputSchema = z.object({
  side: z.enum(['before', 'after']),
  path: z.string().min(1).max(4096),
  blobOid: z.string().regex(/^[a-f0-9]{40,64}$/),
  line: z.number().int().positive(),
}).strict();

export const readingPositionInputSchema = z.object({
  fileId: z.string().min(1).max(100),
  side: z.enum(['before', 'after']),
  line: z.number().int().positive(),
  changeId: z.string().min(1).max(100).optional(),
}).strict();

export const localCommentInputSchema = z.object({
  fileId: z.string().min(1).max(100),
  fingerprint: z.string().min(1).max(10000),
  side: z.enum(['before', 'after']),
  line: z.number().int().nonnegative(),
  body: z.string().min(1).max(5000),
  evidence: z.string().min(1).max(5000),
  ...commentFields,
}).strict();

export const localCommentEditSchema = commentDraftEditSchema.omit({ path: true }).extend({
  fileId: z.string().min(1).max(100).optional(),
  fingerprint: z.string().min(1).max(10000).optional(),
});
