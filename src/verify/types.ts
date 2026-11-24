import type { Action } from './actions.js';
import type { Finding } from './detectors.js';

export type CriterionVerdict = 'refuted' | 'held' | 'inconclusive';

/** A finding after replay: confirmed means it reproduced with no model involved. */
export interface ResultFinding extends Finding {
  confirmed: boolean;
}

export interface VerifyResult {
  criterionId: string;
  criterion: string;
  verdict: CriterionVerdict;
  /** How the agent run ended: concluded, max-steps, budget, refusal, ... */
  outcome: string;
  summary?: string;
  error?: string;
  findings: ResultFinding[];
  actions: Action[];
  /** Screenshots of confirmed failures, relative to the working directory. */
  screenshots: string[];
  /** Path of the saved repro script, written when something was confirmed. */
  repro?: string;
  steps: number;
  usage: { input: number; output: number };
}

export interface VerifyFile {
  issue: string;
  title: string;
  baseUrl: string;
  results: VerifyResult[];
}

/** `.okayd/repro/<criterionId>.json`: a model-free regression script. */
export interface ReproFile {
  version: 1;
  criterionId: string;
  baseUrl: string;
  checkLinks?: boolean;
  actions: Action[];
  /** Assertions (by action index) that fail when the bug is present. */
  violations: { title: string; expected: string; actual: string; assertIndex: number }[];
  /** Detector findings that reappear when the bug is present. */
  detectors: { kind: string; title: string }[];
}
