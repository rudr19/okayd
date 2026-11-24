// Detectors watch the whole page, so on their own they blame a criterion for
// things it did not cause: an analytics script that 404s, or a console error that
// was already there when the page loaded. This decides which findings may refute
// a criterion. It only lowers severity; the finding is still recorded.
import type { Finding } from './detectors.js';

export interface AttributionOptions {
  baseUrl: string;
  /** Restore the old behaviour: every detector finding counts, wherever it came from. */
  strict?: boolean;
}

/** The request URL a network or console finding is about, when its detail names one. */
function requestUrl(f: Finding): string | undefined {
  if (f.kind === 'http-error') return /^\d{3} (\S+)/.exec(f.detail)?.[1];
  if (f.kind === 'request-failed') return /^(\S+) /.exec(f.detail)?.[1];
  if (f.kind === 'console-error') return /\((https?:\/\/[^\s()]+)\)\s*$/.exec(f.detail)?.[1];
  return undefined;
}

function sameOrigin(url: string, baseUrl: string): boolean {
  try {
    return new URL(url, baseUrl).origin === new URL(baseUrl).origin;
  } catch {
    return false;
  }
}

/**
 * A detector finding refutes a criterion only if
 *  (a) it appeared after an action the agent took (step 1 or later); what was
 *      already wrong when the page first loaded is not this criterion's doing, and
 *  (b) for failed requests, the URL is on the app's own origin; third-party
 *      failures are warnings (severity 1).
 * Violations the agent reported and replay confirmed are never touched.
 */
export function attributeFinding(f: Finding, o: AttributionOptions): Finding {
  if (o.strict || f.kind === 'violation') return f;
  const url = requestUrl(f);
  if (url !== undefined && !sameOrigin(url, o.baseUrl)) {
    return { ...f, severity: 1, downgraded: 'third-party', detail: `third-party request, not attributed to this criterion: ${f.detail}` };
  }
  if (f.step === 0 && f.severity > 2) {
    return { ...f, severity: 2, downgraded: 'baseline', detail: `present when the page loaded, before the agent acted: ${f.detail}` };
  }
  return f;
}
