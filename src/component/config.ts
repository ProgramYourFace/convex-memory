// Every size, threshold and budget the engine uses, in one place (README "Limits"). Each decision logs the threshold it
// was held against, so the thresholds can be checked against the decision model's answers. Which models it calls is
// the app's choice (shapes.ts settingsValidator); the client's defaults are below.

/**
 * The default models, by role, as the Convex AI Gateway names them (the client's defaults; README "Models").
 */
export const DEFAULT_MODELS = {
  /**
   * The decision model ("system one"): the ingest gate, relate, the context gate and prune. Liquid's d1-ultra on the
   * gateway's Decisions endpoint (`/alpha/decisions`): typed questions over one state, a 32,768-token context, billed
   * for input only.
   */
  decision: 'liquid/d1-ultra',
  /** The writer: extraction, verification, merges, query analysis, recall's answer. Small, cheap, strict JSON schemas. */
  writer: 'openai/gpt-6-luna',
  /**
   * Embeddings: Qwen3 Embedding 8B, a strong multilingual retriever. Its 4,096 values are trained so that a prefix is an
   * embedding itself: the first EMBEDDING_DIMENSIONS are kept, normalized.
   */
  embedding: 'qwen/qwen3-embedding-8b',
} as const;

/**
 * The vectors' length: `vectors.by_embedding` is made for it (Convex allows 2 to 4,096), and a vector index's
 * dimensions are fixed when it is deployed. An embedding model must answer at least this many values; the first
 * EMBEDDING_DIMENSIONS are kept and normalized (right for Matryoshka-trained models such as Qwen3 Embedding and
 * OpenAI's text-embedding-3, which the `openai` dialect asks for exactly this many).
 */
export const EMBEDDING_DIMENSIONS = 1024;
/** What a search embeds for (an instruction-tuned embedder's queries carry the task; what they search is embedded as it is). */
export const EMBEDDING_QUERY_TASK = "Given a person's message, retrieve stored memories (facts, preferences, instructions, events, tasks) relevant to it";
/** The default query prefix (Qwen3 Embedding's prompt format). */
export const DEFAULT_EMBEDDING_QUERY_PREFIX = `Instruct: ${EMBEDDING_QUERY_TASK}\nQuery:`;

/**
 * $ per million tokens [input, output] of the default models on the gateway (their dearest zero-data-retention
 * endpoints, read 2026-10-22). A call is priced at the settings' prices only when its answer gives no `usage.cost`.
 */
export const DEFAULT_PRICES: readonly { model: string; input: number; output: number }[] = [
  { model: DEFAULT_MODELS.decision, input: 0.042, output: 0 },
  { model: DEFAULT_MODELS.writer, input: 0.11, output: 0.55 },
  { model: DEFAULT_MODELS.embedding, input: 0.01, output: 0 },
];

/** The paths of the three endpoints (relative to the transport's base URL). */
export const ENDPOINTS = { decisions: '/alpha/decisions', chat: '/v1/chat/completions', embeddings: '/v1/embeddings' } as const;

/** What every gateway request asks of its routing by default: zero-data-retention endpoints, no data collection. */
export const DEFAULT_ROUTING = { zdr: true, data_collection: 'deny' } as const;

/**
 * The writer's reasoning: its effort, and the tokens every call's output budget gets on top of its answer's (reasoning
 * counts against `max_completion_tokens` and bills as output; an answer cut off in its reasoning is no answer).
 */
export const WRITER_REASONING = { effort: 'low', tokens: 2_000 } as const;
/** Texts per embeddings request (each answer crosses from the app's transport action as text). */
export const EMBED_BATCH = 16;
/** The writer's answers' budgets in output tokens, before WRITER_REASONING's. */
export const WRITER_ANSWER_TOKENS = { extract: 3_000, verify: 1_500, classify: 300, merge: 400, relate: 50, analyze: 400, synthesis: 1_024 } as const;

/** The decision model's context in tokens: its state is built in code to fit it. */
export const DECISION_WINDOW = 32_768;
/** Tokens of the context kept free of the state (the questions are counted apart) for the model's framing and answers. */
export const DECISION_RESERVE_TOKENS = 3_000;
/** A conservative characters-per-token for budgeting (English is ~4; code, ids and other scripts are denser). */
export const CHARS_PER_TOKEN = 3.2;

export const THRESHOLDS = {
  /** Ingest gate: p(worth remembering) at or above this extracts. Leans toward yes (a miss costs more than a call). */
  gateRemember: 0.25,
  /** p(reads like instructions aimed at an AI) at or above this keeps untrusted messages out of extraction. */
  gateInjection: 0.7,
  /** Relate: a decision model's choice at or above this confidence is applied by code; below it the writer decides. */
  relateConfidence: 0.6,
  /** Context gate: p(needs memory beyond the window) at or above this searches. Leans toward yes. */
  contextGate: 0.3,
  /** Context prune: p(relevant to this turn) at or above this keeps a candidate. */
  contextKeep: 0.4,
} as const;

export const INGEST = {
  /** One drain reads at most this many messages of one session (and this many characters), then schedules the next. */
  batchMessages: 60,
  batchChars: 60_000,
  /** The messages before a batch the models read for context. */
  previousMessages: 2,
  /** Extraction chunks (Agent Memory: ~10k characters, a two-message overlap, at most four calls at once). */
  chunkChars: 10_000,
  overlapMessages: 2,
  concurrency: 4,
  /** The detail pass runs on batches of at least this many messages, over windows of `detailWindow`. */
  detailMinMessages: 9,
  detailWindow: 6,
  /** Items per verification call, and items per batch at most (the rest are dropped, logged). */
  verifyBatch: 12,
  maxItems: 80,
  /** Relate candidates per new memory (same topic, vector and full text together). */
  relateCandidates: 6,
  /** Quotes shorter than this (after normalizing) prove nothing. */
  minQuoteChars: 4,
  /**
   * A trusted memory needs a quote from trusted text this long (characters, or words) that says its substance, and
   * that much of its content's words in its trusted sources: a short common quote ("thanks") proves nothing.
   */
  trustQuoteChars: 20,
  trustQuoteWords: 4,
  trustCoverage: 0.5,
  /** The ingest gate reads a long batch in pieces, at most this many; past them, untrusted text is kept out. */
  gatePieces: 6,
  /** Confidence of a new memory, of a remembered one, of both sides of an unresolved conflict, and what a confirming source adds. */
  newConfidence: 0.8,
  rememberedConfidence: 0.95,
  conflictConfidence: 0.5,
  confirmStep: 0.1,
  /** Sources a memory keeps at most (the newest). */
  maxSources: 200,
} as const;

/** The per-scope ingest lease and the retry of a drain that failed. */
export const QUEUE = {
  /** A drain holds its scope this long at most (a drain that died frees it then; batches take a minute or two). */
  leaseMs: 15 * 60_000,
  /** After a failure, the next try waits 1, 2, 4… minutes, at most an hour. */
  retryBaseMs: 60_000,
  retryMaxMs: 3_600_000,
  /** After this many failures in a row, the batch is marked read without memories (the record keeps it, recall finds it). */
  maxFailures: 6,
} as const;

export const RECALL = {
  /** Reciprocal rank fusion (k = 60) and each channel's weight (Agent Memory's order: topic key first, raw messages last). */
  rrfK: 60,
  weights: { topic: 3, fts: 1.5, hyde: 1.2, vector: 1, messages: 0.5 },
  /** Results each channel contributes before fusion. */
  perChannel: 20,
  /** Memories recall's answer reads. */
  synthesisTop: 12,
} as const;

export const CONTEXT = {
  /** Candidates the prune reads (one decision call: at most 64 questions). */
  pruneMax: 32,
  perChannel: 16,
  /** Standing instructions read per scope (they come first, every turn). */
  instructions: 20,
  /** Characters of the window's tail the gate and prune read. */
  recentChars: 6_000,
} as const;

/** What one op takes, and what Convex's search allows (README "Limits"). */
export const LIMITS = {
  /** Messages per ingest call, and characters per message kept in the record (longer ones are cut). */
  ingestMessages: 100,
  messageChars: 20_000,
  sessionChars: 128,
  rememberChars: 4_000,
  queryChars: 2_000,
  turnChars: 20_000,
  recentChars: 40_000,
  /** A tag's length, and the tags of one write (one scope). */
  tagChars: 128,
  scopeTags: 16,
  /** A filter's depth and nodes, and a read's layers. */
  filterDepth: 4,
  filterNodes: 32,
  layers: 8,
  /**
   * The tag sets (scopes) one read reaches at most: each is searched apart (full text per scope; vectors in `or`s of
   * `vectorOr` scopes), so reads slow as they grow. Keep tag sets coarse (README "Limits").
   */
  readScopes: 256,
  vectorOr: 64,
  /** Scopes per search query an action runs (several run at once). */
  scopesPerQuery: 32,
  /** Convex full-text search: at most 16 terms per search expression. */
  searchTerms: 16,
  /** Topics the cheap topic guess reads per read (shared among its scopes, at least `topicsPerScope` each). */
  topics: 2_000,
  topicsPerScope: 50,
  /** Decisions and usage rows are kept this long. */
  logKeepMs: 90 * 24 * 3_600_000,
  /** Rows a purge or a sweep deletes per mutation, and of the record's messages (up to ~80 KB each) at most. */
  deletePage: 500,
  deleteMessagesPage: 100,
} as const;
