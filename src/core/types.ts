export type ChangeCategory =
  | 'property-added'
  | 'property-removed'
  | 'required-added'
  | 'required-removed'
  | 'enum-narrowed'
  | 'enum-widened'
  | 'enum-replaced'
  | 'nullable-added'
  | 'nullable-removed'
  | 'type-changed'
  | 'parameter-renamed'
  | 'parameter-required-changed'
  | 'parameter-added'
  | 'parameter-removed'
  | 'response-status-removed'
  | 'response-status-added'
  | 'endpoint-added'
  | 'endpoint-removed'
  | 'description-changed'
  | 'ref-target-changed';

export interface ParseError {
  message: string;
  path: string;
  line: number;
  column: number;
}

export interface ParsedDoc {
  doc: unknown;
  contentHash: string;
  pretty: string;
  format: 'json' | 'yaml';
}

export interface DocSummary {
  openapi: string;
  title: string;
  version: string;
  pathCount: number;
  contentHash: string;
  format: 'json' | 'yaml';
}

export interface RawDiff {
  key: string;
  category: ChangeCategory;
  scope: string;
  subject: string;
  beforeValue: unknown;
  afterValue: unknown;
  beforeJson: unknown;
  afterJson: unknown;
}

export type DecisionState = 'accepted' | 'rejected' | 'exempted';

export interface RawDecision {
  state: DecisionState;
  actor: string;
  rationale: string;
  expiresAt?: string | null;
}

export interface DiffRecord extends RawDiff {
  id: string;
  revisionId: string;
  impact: string;
}

export interface DecisionRecord extends RawDecision {
  id: string;
  diffId: string;
  eventNo: number;
  baseVersion: number;
  decidedAt: string;
  beforeSummary: DocSummary;
  afterSummary: DocSummary;
}

export interface EffectiveDecision extends DecisionRecord {
  effectiveState: DecisionState;
  expired: boolean;
}

export interface RevisionSummary {
  id: string;
  revisionNo: number;
  active: boolean;
  createdAt: string;
}

export interface RevisionView {
  id: string;
  caseId: string;
  title?: string;
  revisionNo: number;
  createdAt: string;
  readOnly: boolean;
  revisions?: RevisionSummary[];
  beforeSummary: DocSummary;
  afterSummary: DocSummary;
  diffs: Array<{
    id: string;
    key: string;
    category: ChangeCategory;
    scope: string;
    subject: string;
    beforeJson: unknown;
    afterJson: unknown;
    impact: string;
    decision: EffectiveDecision | null;
    version: number;
  }>;
}

export interface NowFn {
  now(): Date;
}
