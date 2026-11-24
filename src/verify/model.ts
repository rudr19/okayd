// The verifier talks to a model only through ModelClient. Core code never
// imports a vendor SDK; the Anthropic adapter loads it lazily.

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultPart {
  id: string;
  text: string;
  isError?: boolean;
  /** Base64 PNG, sent only when the agent asked for a screenshot. */
  imageBase64?: string;
}

export type Msg =
  | { role: 'user'; text: string }
  /** `raw` is the provider's own assistant content, replayed verbatim (thinking blocks need it). */
  | { role: 'assistant'; text?: string; toolCalls: ToolCall[]; raw?: unknown }
  | { role: 'tool'; results: ToolResultPart[] };

export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema, type "object", additionalProperties false. */
  inputSchema: Record<string, unknown>;
}

export interface ModelRequest {
  system: string;
  messages: Msg[];
  tools: ToolDef[];
}

export type StopReason = 'tool_use' | 'end' | 'refusal' | 'max_tokens';

export interface ModelResponse {
  toolCalls: ToolCall[];
  text?: string;
  stop: StopReason;
  usage?: { input: number; output: number };
  raw?: unknown;
}

export interface ModelClient {
  next(req: ModelRequest): Promise<ModelResponse>;
}

// ---------------------------------------------------------------- scripted

export interface ScriptedResponse {
  toolCalls?: { name: string; input: Record<string, unknown> }[];
  text?: string;
  stop?: StopReason;
  usage?: { input: number; output: number };
}

export type ScriptedStep = ScriptedResponse | ((req: ModelRequest) => ScriptedResponse);

/** Returns queued responses in order. For tests: never touches a network. */
export class ScriptedModel implements ModelClient {
  readonly requests: ModelRequest[] = [];
  private index = 0;
  private callId = 0;

  constructor(private readonly steps: ScriptedStep[]) {}

  async next(req: ModelRequest): Promise<ModelResponse> {
    this.requests.push({ system: req.system, tools: req.tools, messages: [...req.messages] });
    const step = this.steps[this.index++];
    if (!step) throw new Error('ScriptedModel ran out of responses');
    const r = typeof step === 'function' ? step(req) : step;
    const toolCalls = (r.toolCalls ?? []).map((c) => ({ id: `call_${++this.callId}`, name: c.name, input: c.input }));
    return {
      toolCalls,
      text: r.text,
      stop: r.stop ?? (toolCalls.length > 0 ? 'tool_use' : 'end'),
      usage: r.usage ?? { input: 1, output: 1 },
    };
  }
}

// --------------------------------------------------------------- anthropic

export const DEFAULT_MODEL = 'claude-opus-5-5';
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** The slice of the SDK client the adapter uses, typed structurally so no install is needed to build. */
export interface AnthropicLike {
  messages: { create(params: Record<string, unknown>): Promise<AnthropicMessage> };
}
interface AnthropicMessage {
  content: { type: string; text?: string; id?: string; name?: string; input?: unknown }[];
  stop_reason: string | null;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export interface AnthropicModelOptions {
  /** Required unless OKAYD_ANTHROPIC_API_KEY is set. ANTHROPIC_API_KEY is never read. */
  apiKey?: string;
  model?: string;
  effort?: Effort;
  maxTokens?: number;
  /** Inject a client (tests). When given, the SDK is not loaded. */
  client?: AnthropicLike;
}

export const MISSING_KEY_MESSAGE =
  'Set OKAYD_ANTHROPIC_API_KEY (or pass apiKey) to use the Anthropic model. Okayd never falls back to ANTHROPIC_API_KEY, auth tokens or CLI profiles, so you choose which account pays.';
export const MISSING_SDK_MESSAGE = 'Install @anthropic-ai/sdk to use the Anthropic model: npm i @anthropic-ai/sdk';

/**
 * Adapter for the Anthropic Messages API. UNTESTED against the live API.
 *
 * The key must be explicit (option or OKAYD_ANTHROPIC_API_KEY). It deliberately
 * does not read ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN or any CLI auth profile:
 * a QA agent can spend a lot, and the user must pick which account pays.
 */
export class AnthropicModel implements ModelClient {
  private readonly apiKey: string | undefined;
  private readonly model: string;
  private readonly effort: Effort;
  private readonly maxTokens: number;
  private client: AnthropicLike | undefined;

  constructor(opts: AnthropicModelOptions = {}) {
    this.apiKey = opts.apiKey ?? process.env.OKAYD_ANTHROPIC_API_KEY;
    if (!this.apiKey && !opts.client) throw new Error(MISSING_KEY_MESSAGE);
    this.model = opts.model ?? DEFAULT_MODEL;
    this.effort = opts.effort ?? 'medium';
    this.maxTokens = opts.maxTokens ?? 16000;
    this.client = opts.client;
  }

  private async load(): Promise<AnthropicLike> {
    if (this.client) return this.client;
    const specifier = '@anthropic-ai/sdk'; // a variable keeps the type checker and bundlers from resolving it
    let mod: any;
    try {
      mod = await import(specifier);
    } catch {
      throw new Error(MISSING_SDK_MESSAGE);
    }
    const Anthropic = mod.default ?? mod.Anthropic;
    // authToken: null stops the SDK from picking up ANTHROPIC_AUTH_TOKEN from the environment.
    this.client = new Anthropic({ apiKey: this.apiKey, authToken: null }) as AnthropicLike;
    return this.client;
  }

  async next(req: ModelRequest): Promise<ModelResponse> {
    const client = await this.load();
    const res = await client.messages.create(this.buildRequest(req));
    return parseAnthropicResponse(res);
  }

  /** Exposed for tests: the exact request body sent to the API. */
  buildRequest(req: ModelRequest): Record<string, unknown> {
    return {
      model: this.model,
      max_tokens: this.maxTokens,
      system: req.system,
      // Adaptive thinking is on by default: `thinking` is intentionally omitted.
      output_config: { effort: this.effort },
      // Forced tool_choice returns 400 on this model; strict schemas keep inputs valid.
      tool_choice: { type: 'auto' },
      tools: req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
        strict: true,
      })),
      cache_control: { type: 'ephemeral' },
      messages: req.messages.map(toAnthropicMessage),
    };
  }
}

function toAnthropicMessage(m: Msg): Record<string, unknown> {
  if (m.role === 'user') return { role: 'user', content: m.text };
  if (m.role === 'assistant') {
    if (m.raw) return { role: 'assistant', content: m.raw };
    const content: unknown[] = [];
    if (m.text) content.push({ type: 'text', text: m.text });
    for (const c of m.toolCalls) content.push({ type: 'tool_use', id: c.id, name: c.name, input: c.input });
    return { role: 'assistant', content };
  }
  return {
    role: 'user',
    content: m.results.map((r) => ({
      type: 'tool_result',
      tool_use_id: r.id,
      ...(r.isError ? { is_error: true } : {}),
      content: r.imageBase64
        ? [
            { type: 'text', text: r.text },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: r.imageBase64 } },
          ]
        : r.text,
    })),
  };
}

export function parseAnthropicResponse(res: AnthropicMessage): ModelResponse {
  const stop: StopReason =
    res.stop_reason === 'tool_use' ? 'tool_use'
    : res.stop_reason === 'refusal' ? 'refusal'
    : res.stop_reason === 'max_tokens' ? 'max_tokens'
    : 'end';
  const text = res.content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n') || undefined;
  // A refusal or truncation can cut a tool_use off mid-input: never run those tools.
  const toolCalls =
    stop === 'tool_use'
      ? res.content
          .filter((b) => b.type === 'tool_use')
          .map((b) => ({ id: b.id ?? '', name: b.name ?? '', input: (b.input ?? {}) as Record<string, unknown> }))
      : [];
  return {
    toolCalls,
    text,
    stop,
    usage: { input: res.usage?.input_tokens ?? 0, output: res.usage?.output_tokens ?? 0 },
    raw: res.content,
  };
}
