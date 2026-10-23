# convex-memory

Layered long-term memory for AI agents, as a [Convex component](https://docs.convex.dev/components).

Your app writes conversations into it as they happen. In the background it extracts versioned memories from them:
facts, events, standing instructions and tasks, each tied to the messages it came from. Before each model turn it
returns what is relevant within a token budget, and a recall tool can search everything. Every message and memory
carries a set of **tags** you choose (`user:alice`, `team:eng`, `agent:support`, `company`). Each read names a **tag
filter** and can rank **layers** (the user's own memory over the team's over the company's).

- **A versioned record.** Every message is kept once, as it was said (keys and tokens removed). Memories name their
  sources, supersede each other in chains you can read, forget and restore.
- **Background ingest.** `ingest` is a mutation and calls no model, so writing never slows a turn. A drain per tag set
  gates, extracts, checks and relates in the background.
- **Budgeted recall.** `context` calls no language model, only a small decision model and search, and fits a token
  budget. `recall` fuses five search channels and can write an answer.
- **Trust is earned.** Untrusted text (pages, mail, tool output) never writes an instruction, never replaces a trusted
  memory and never gets into one through a merge. A memory is trusted only when a verbatim quote from a person's own
  trusted words says it.

```ts
const note = await memory.context(ctx, {
  filter: { any: ["user:alice", "team:eng", "company"] },
  layers: [
    { name: "yours", filter: "user:alice" },
    { name: "team", filter: "team:eng" },
    { name: "company", filter: "company" },
  ],
  turn: "Can you book the usual room for standup?",
  budgetTokens: 1500,
});
// note.note: "[memory:3f2a…] (instruction, yours, 2026-10-21) Always answer briefly. …"
```

## Contents

- [Install](#install)
- [Tags, filters and layers](#tags-filters-and-layers)
- [Usage](#usage)
- [Models](#models)
- [How it works](#how-it-works)
- [Security: what your app must enforce](#security-what-your-app-must-enforce)
- [Limits](#limits)
- [Storage](#storage)
- [Testing your app](#testing-your-app)
- [Development](#development)
- [Credits](#credits)

## Install

```sh
npm install convex-memory
```

It needs `convex` 1.47 or later.

**1. Install the component** in `convex/convex.config.ts`:

```ts
import { defineApp } from "convex/server";
import memory from "convex-memory/convex.config.js";

const app = defineApp();
app.use(memory);

export default app;
```

**2. Define the model transport and the client** in `convex/memory.ts`. A component cannot read your environment or
hold your keys, so it sends every model request through an action of yours. `defineModelTransport` writes that action
for you:

```ts
import { Memory, defineModelTransport } from "convex-memory";
import { components, internal } from "./_generated/api";

// The Convex AI Gateway, with the deployment's own short-lived token: no key to manage.
export const transport = defineModelTransport();

export const memory: Memory = new Memory(components.memory, {
  transport: internal.memory.transport,
});
```

The `: Memory` annotation breaks a type cycle, because the file refers to its own `internal.memory.transport`.

**3. Run the sweep** from your crons. Component crons are not supported, so the app schedules the maintenance pass. It
restarts a drain whose schedule was lost, embeds memories whose embedding failed, and deletes old logs. Add the sweep to
`convex/memory.ts`:

```ts
import { internalMutation } from "./_generated/server";

export const sweep = internalMutation({ args: {}, handler: (ctx) => memory.sweep(ctx) });
```

Then schedule it in `convex/crons.ts`:

```ts
import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();
crons.interval("memory sweep", { minutes: 15 }, internal.memory.sweep, {});
export default crons;
```

`example/convex/` is a complete app: auth-checked wrappers for each operation, layers, a cron and user deletion.

## Tags, filters and layers

**Writes name a tag set.** `ingest` and `remember` take `tags: string[]`, for example `["user:alice"]`,
`["team:eng", "agent:review"]` or `["company"]`. Tags are opaque to the component. A tag is 1 to 128 characters: letters,
digits and `: . _ @ / # = + -`, starting with a letter or digit. A write has 1 to 16 tags, and order and repeats do not
matter. Each distinct tag set is a **scope**: the unit that is drained, related within and purged.

**Reads name a filter.** `context`, `recall`, `searchHistory` and `list` take a `TagFilter`: a tag, or
`{ all?, any?, not? }` of filters, nested.

```ts
"company"                                                  // every scope holding `company`
{ all: ["team:eng", "agent:review"] }                      // scopes holding both
{ any: ["user:alice", "team:eng"], not: ["agent:sales"] }  // either, but never with agent:sales
{ any: [{ all: ["team:eng", "agent:review"] }, "user:alice"] }
```

A filter must name tags its matches hold, so `{ not: [...] }` alone is refused: it would match every scope. It nests at
most 4 deep, with at most 32 nodes. The scopes a filter reaches are found through an index of tags, never by scanning
all scopes.

**Layers rank what a read finds.** `layers` is an ordered list of `{ name, filter, weight? }`. Each scope is read as
the first layer it matches, and a scope that matches no layer is left out. Scores are multiplied by the layer's weight
(by default 1, 0.8, 0.64, … in order). Standing instructions come in layer order. Each hit, and each line of the window
note, names its layer. Without layers, the note shows each memory's tags.

**Relate stays within one tag set.** A new memory is compared only with memories of its own scope. A statement in
`["user:alice"]` never supersedes, merges into or confirms a memory of `["team:eng"]`, and a memory of
`["user:alice", "team:eng"]` is a third scope apart from both. Standing (`trust`, `authority`) is set on each write.

**Choosing tags.** Keep tag sets coarse: one per person, team, agent or company, and a few combinations. Each read
searches every scope it reaches separately (see [Limits](#limits)). Put fine-grained context such as a project or a
document in the content and in topics, not in the tags.

## Usage

Each method takes your function's `ctx` and trusts its arguments. Call them from your own queries, mutations and
actions, after your auth check (see [Security](#security-what-your-app-must-enforce)).

| Method | From | Args → answer |
| --- | --- | --- |
| `ingest` | mutation | `{ tags, session, messages }` → `{ stored, skipped }`. Memories follow in the background. |
| `context` | action | `{ filter, layers?, turn, recent?, budgetTokens, reader?, names? }` → `{ note, memories, gated, usage }` |
| `recall` | action | `{ filter, layers?, query, limit?, synthesize? }` → `{ memories, messages, answer, answerUntrusted, usage }` |
| `remember` | action | `{ tags, content, author, authorName?, via?, kind?, topic?, trust, authority? }` → `{ memory, superseded, usage }` |
| `forget` | mutation | `{ tags, id, authority? }` → `{ forgotten }` |
| `restore` | action | `{ tags, versionId, authority? }` → `{ memory, superseded, usage }` |
| `searchHistory` | query | `{ filter, layers?, query, limit? }` → `{ hits }` (memories and messages, no model) |
| `list` | query | `{ filter, kind?, topic?, includeHistory?, paginationOpts }` → `{ page, isDone, continueCursor }` |
| `history` | query | `{ tags, id? \| topic? }` → `{ versions }` |
| `get` | query | `{ tags, id }` → a memory version, or `null` when there is none or it was forgotten |
| `purge` | mutation | `{ tag }` or `{ tags }` → `{ done }` |
| `reopen` | mutation | `{ tag }` or `{ tags }` → `{ reopened }` |
| `sweep` | mutation | → `null` (from your cron) |

A refusal is a `ConvexError` with data `{ code: "invalid" | "not_found" | "forbidden", message }`. Usage is
`{ models: [{ model, calls, inputTokens, outputTokens }], costMicros }`, and each operation's usage is also kept in the
component's `usage` table.

**Ingest an exchange** after each turn. A message is `{ role, author, authorName?, trust, content, at, tz?, authority? }`
with `role` one of `user`, `assistant`, `tool`, `system` or `note`. `at` is when it was said, in ms, and relative dates
resolve against it in the speaker's IANA time zone `tz`. The same words in one session are one message, so sending an
overlapping window again is harmless.

```ts
await memory.ingest(ctx, {
  tags: [`user:${userId}`],
  session: threadId,
  messages: [
    { role: "user", author: userId, trust: "trusted", content: userText, at: Date.now() },
    { role: "assistant", author: "assistant", trust: "trusted", content: reply, at: Date.now() + 1 },
    { role: "tool", author: "web", trust: "untrusted", content: pageText, at: Date.now() + 2 },
  ],
});
```

**Before each turn**, call `context` and put `note` in the model's system prompt. The note cites each memory as
`[memory:<id>]` and wraps untrusted ones as `<untrusted_memory>`. `reader` and `names` let it say who set a shared
memory ("set by Sam"). `gated: true` means the decision model judged the turn needs no memory beyond the window, so only
standing instructions came back.

**Give the agent tools.** Use `recall` for a deliberate search (`synthesize: true` adds an answer), `remember` for
"remember that…" (with a `topic` on a fact or instruction it is an edit of that topic), and `searchHistory` for raw
full text. A memory screen uses `list`, `history`, `forget` and `restore`.

**Kinds.** A `fact` is keyed by topic, and a newer one supersedes it. An `event` is anchored in time and never
superseded. An `instruction` is a standing rule for the assistant, keyed like a fact. A `task` is work in progress: it is
found by full text and never embedded. Topics are dotted keys such as `person.diet`, `team.standup` or
`client.acme.billing`.

**Purge** erases memory and blocks writes until you `reopen`:

- `{ tag: "user:alice" }` erases every scope holding the tag, alone or with others. Use it when a person is deleted or
  asks to be forgotten.
- `{ tags: ["team:eng"] }` erases exactly that tag set. Sets that hold more tags, such as `["team:eng", "user:bob"]`, stay.

A drain or a write in flight commits nothing. Large scopes are erased a page at a time, with the rest scheduled
(`done: false`). `reopen` is refused until the erasing is finished. Usage rows stay, because they hold no content.

## Models

Three roles, each chosen in `new Memory(..., { models })`:

| Role | Default | Endpoint | Used for |
| --- | --- | --- | --- |
| Decision model | `liquid/d1-ultra` | `/alpha/decisions` | Typed questions with probabilities: is this worth remembering, does untrusted text read like a prompt injection, how does a new memory relate to an old one, does this turn need memory, is this candidate relevant |
| Writer | `openai/gpt-6-luna` | `/v1/chat/completions` | Extraction, checks, merges, query analysis and recall's answer, with strict JSON schemas and low reasoning effort |
| Embeddings | `qwen/qwen3-embedding-8b` | `/v1/embeddings` | 1,024 dimensions: the first 1,024 of its 4,096 values, normalized. Queries carry its instruction prefix. |

**The Convex AI Gateway (default).** `defineModelTransport()` reads the gateway's address with
`getServiceUrl("ai-gateway")` and a short-lived token with `getServiceToken("ai-gateway")` inside the action. The
credential never leaves that action and is never stored. Every request asks for zero-data-retention endpoints and no
data collection (`provider: { zdr: true, data_collection: "deny" }`, set with `routing`). Each writer call adds
`require_parameters` so it only reaches endpoints that honor the schema. Costs come from each answer's `usage.cost`.
When an answer gives none, the cost is computed from `prices`.

**Any OpenAI-compatible API:**

```ts
export const transport = defineModelTransport({
  baseUrl: "https://api.openai.com",
  apiKey: () => process.env.OPENAI_API_KEY!,
});

export const memory: Memory = new Memory(components.memory, {
  transport: internal.memory.transport,
  dialect: "openai",
  models: { writer: "gpt-5-mini", embedding: "text-embedding-3-large", decision: null },
  writerReasoning: "low",
});
```

The `openai` dialect sends no routing, sends `reasoning_effort` instead of `reasoning`, asks for embeddings with
`dimensions: 1024`, and adds no query prefix (`embeddingQueryPrefix` sets one). The transport only forwards the three
model paths, adds your headers (`headers`) and key, and cuts each embedding to the values the component keeps.

**Without a decision model** (`decision: null`, the `openai` default), the engine degrades as it does when that model
fails:

- The ingest gate extracts everything trusted, and untrusted text stays out of extraction.
- Relate goes to the writer.
- The context gate always searches, and the prune keeps the best-ranked candidates.

Every decision is logged in the `decisions` table with its model, confidence and threshold, so you can tune
`THRESHOLDS` in `config.ts` against real answers.

**The vector dimension is fixed.** `vectors.by_embedding` is a 1,024-dimension index (`EMBEDDING_DIMENSIONS`), fixed
when it is deployed. An embedding model must return at least 1,024 values. The first 1,024 are kept and normalized,
which is correct for Matryoshka-trained models such as Qwen3 Embedding and OpenAI's text-embedding-3. Changing models
or dimensions makes existing vectors meaningless: fork the component with a new dimension and re-embed, because a
deployed index cannot change its dimension.

Check the defaults against your gateway's catalog when you deploy. If the decision model is not served on
`/alpha/decisions`, name one that is (or `null`). The engine keeps working, degraded as above, and logs each failure.

## How it works

**The record is the truth.** Messages are stored once, with key- and token-shaped strings removed and content cut at
20,000 characters. A `tool` message is untrusted whatever the caller says. Memories are derived from the record and
name their source messages, and the raw messages stay searchable for anything no memory holds.

**The drain**, one per scope at a time (a 15-minute lease), reads a batch of up to 60 messages of one session, plus the
two before it:

1. **Gate** (decision model): is anything worth remembering, and does any untrusted part read like instructions to an
   AI? A long batch is read in pieces. An unread piece, a failed gate or a missing answer counts as unknown, which keeps
   untrusted text out and lets trusted text in.
2. **Extract** (writer): a full pass over ~10,000-character chunks, a detail pass over windows of six messages for
   batches of nine or more (concrete values), and, when untrusted text is present, an instructions pass over the trusted
   messages alone. Each item carries verbatim quotes, its time phrases and the questions it answers.
3. **Code checks**:
   - A quote not found verbatim drops its item.
   - An item is trusted only with a substantial quote from a message that vouches for it (trusted, and written by
     neither the assistant nor a tool) and most of its words in such messages. Words that only untrusted text says make
     it untrusted.
   - Untrusted items are never instructions.
   - Time phrases ("yesterday", "next Friday") become dates computed in code.
   - A key, token or stated password drops the item.
4. **Writer checks**: each item passes, is corrected or is dropped. A correction must still be what the sources say and
   may not bring in untrusted words.
5. **Relate** (decision model, the writer when unsure): each fact and instruction is compared with up to six current
   memories of its scope as `same`, `updates`, `refines`, `conflicts` or `unrelated`. Then:
   - Something untrusted, or a member's statement against a manager's (`authority`), never replaces what stands above
     it. It is kept beside it, marked unsure.
   - A merge that loses either side keeps both.
6. **Commit**, in one mutation, while the lease is still the drain's. A version planned against a head another write
   has since replaced is kept beside it, unsure. A version resting on a forgotten memory's messages is not written.

A failed drain backs off (1, 2, 4… minutes, at most an hour). After six failures in a row the batch is marked read
without memories: the record keeps it and recall still finds it.

**`context`**:

1. Standing instructions come first, layer by layer, within the budget.
2. The decision model's gate asks whether the turn needs memory beyond the window.
3. If it does, three cheap channels (a topic guess done in code, full text, the turn's vector) are fused with weighted
   reciprocal rank fusion, weighted by layer, pruned by the decision model in one call, and cut to the budget.

**`recall`**: the writer analyzes the query (topics, terms, synonyms and a hypothetical memory to embed, known as HyDE)
while the query is embedded. Then five channels are fused, with weights:

| Channel | Weight |
| --- | --- |
| Topic | 3 |
| Full text over memories | 1.5 |
| HyDE vector | 1.2 |
| Query vector | 1 |
| Raw messages | 0.5 |

Vector hits are always re-read through the current view, so a superseded or forgotten memory never comes back.

**Forgetting withholds the sources.** `forget` removes a version and every version before it, drops their vectors and
withholds their source messages from every read. A forgotten memory cannot return through raw-message search. Saying it
again starts it anew.

## Security: what your app must enforce

The component trusts its arguments. It has no `ctx.auth` and never infers access, so every argument below must come
from your app's own checks: from the signed-in user and their roles, never from a model's or a tool's arguments. Never
expose the component's functions to clients directly. Wrap each one in your own query, mutation or action.

- **Tags and filters.** Your app decides which tags a caller may write and which filters it may read. A user's reads
  name only filters made of tags they may see, and their writes name only tag sets they may write. The same goes for
  `forget`, `restore`, `list`, `history` and `get`, which take the tag set of the memory they act on. Build filters in
  code from the user's identity and memberships. Never pass a filter, a tag or a layer that a model or tool chose.
  - A filter that reaches a tag set holding a tag the user may not see leaks it. For example, `{ any: ["team:eng"] }`
    also reaches `["team:eng", "user:bob"]`. Use `not` or `all` to keep such sets out, or never write them.
  - Purge with `{ tag }` when a person is deleted. Reads of a purged scope return nothing, and writes are refused until
    `reopen`.
- **Trust** on every message and every `remember`.
  - A person's own words are `trusted`.
  - The assistant's words are `trusted` but never vouch for a memory.
  - Anything a tool, page, mail or app produced is `untrusted`, including text the person pasted from one when you can
    tell.
  - A `remember` the assistant makes during a turn that read untrusted text is `untrusted` unless the person's own words
    in that turn say it.
  - An instruction (`kind: "instruction"`) is remembered only from the person's own words.
- **Authority** on shared tag sets (`manager` or `member`) comes from the user's role in your app, never from the
  request. A memory is a manager's only when every message it came from is. What stands below never replaces, lowers,
  forgets or restores over what stands above. Leave `authority` unset on personal tag sets.
- **Output.** `recall` returns memories and messages with their `trust`. Show untrusted ones to the model as information,
  wrapped like the window note's `<untrusted_memory>`, never as instructions. Treat an answer with `answerUntrusted`
  the same way.
- **Secrets.** Key- and token-shaped strings are removed before storage, and memories that hold a key or a stated
  password are refused or dropped. Detection cannot catch every secret, so keep secrets out of conversations where you
  can and in a secrets manager. The record keeps what was said, as the conversation does.
- **The transport** is an internal action. Keep it internal: it would send any request body to your provider with your
  credentials. It only forwards the three model paths.

## Limits

Each read searches every scope it reaches separately:

- full text: one search per scope, with the results merged by how many of the search's words each row holds;
- vectors: `or`s of up to 64 scopes per search;
- topics: the most recently used 2,000 topics, shared among the scopes, at least 50 each.

So a read gets slower and its ranking coarser as it reaches more tag sets. A read reaching more than 256 is refused.
Keep tag sets coarse: tens per read is comfortable, hundreds is the ceiling, and thousands of distinct tag sets behind
one filter do not work. Writes are not limited by the number of scopes.

| What | Limit |
| --- | --- |
| Messages per `ingest` | 100, each cut at 20,000 characters |
| `remember` content | 4,000 characters |
| Tags | 1 to 16 per write, 128 characters each |
| Filter | 4 deep, 32 nodes; 8 layers per read |
| Scopes per read | 256 |
| Drain batch | 60 messages or 60,000 characters of one session; 80 items |
| Full-text search | 16 terms of up to 32 characters (Convex's limit); no stemming, so recall asks the writer for other word forms |
| Decisions and usage logs | kept 90 days (the sweep deletes older rows) |

Every size and threshold is in `src/component/config.ts`.

## Storage

The component's own tables, isolated from your app's:

| Table | What |
| --- | --- |
| `scopes` | One row per distinct tag set: its tags, the drain's lease, queue and retry state, a purge mark |
| `scopeTags` | One row per tag of each scope, indexed by tag: how a filter finds its scopes |
| `purgedTags` | Tags purged with `{ tag }`, closed to writes until reopened |
| `messages` | The record: content-addressed per session, `processed`, `withheld`; full-text index by scope |
| `memories` | Versions: kind, topic, content, the questions it answers, validity, supersede chain, trust, authority, confidence, sources; full-text index by scope |
| `vectors` | One 1,024-value embedding per current memory that is not a task; vector index filtered by scope and kind |
| `topics` | Each scope's topics and when they were last used |
| `decisions` | Every model decision: stage, model, input digest, answer, confidence, threshold |
| `usage` | Each operation's model calls, tokens and cost in micro-dollars |
| `settings` | The model settings the app last sent (no secrets: the transport is a function handle), for background drains |

## Testing your app

```ts
import { convexTest } from "convex-test";
import memoryTest from "convex-memory/test";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const t = convexTest(schema, modules);
memoryTest.register(t); // as "memory"; pass a name if you installed it under another
```

Model calls go through your transport's `fetch`, so stub `fetch` in tests (see `src/client/index.test.ts`).

## Development

```sh
npm install
npm run build       # tsc to dist/
npm run typecheck   # the package and the example app
npm test            # vitest with convex-test: the engine, tags and scopes, the client
```

The engine's tests run against a scripted provider (`src/component/fakeGateway.testing.ts`). Regenerating the
component's `_generated/` files needs a deployment. A local anonymous one works:
`CONVEX_AGENT_MODE=anonymous npx convex dev --once`, then `npm run build:codegen`.

## Credits

The engine's design comes from the memory system in [EdenOS](https://ednos.app) ("One Eden"): the record as the truth,
a decision model that decides while a writer writes and code computes, and trust earned through quotes. Its ingest and
recall pipeline follows Cloudflare's
[Agent Memory](https://blog.cloudflare.com/introducing-agent-memory/): chunked extraction with a detail pass, verification,
typed relations between memories, and five-channel recall fused with reciprocal rank fusion and HyDE.

## License

MIT © Christopher Silvas
