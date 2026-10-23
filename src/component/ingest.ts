import { v } from 'convex/values';
import { redactSecrets } from './redact.js';
import { internal } from './_generated/api.js';
import { internalAction, mutation } from './_generated/server.js';
import { LIMITS } from './config.js';
import { Models } from './models.js';
import { commitArgsOf, planIngest } from './pipeline.js';
import { ensureScope, fail } from './scopes.js';
import { messageValidator, NAME_RE, settingsValidator, TZ_RE } from './shapes.js';
import { saveSettings, scheduleDrain } from './store.js';
import { clip, messageId } from './text.js';

// Ingest (README "How it works"): the record grows at once, in a mutation (idempotent per message: the same words in
// a session are one message), and memories are derived in the background by a drain, one per scope at a time. Writing
// never blocks a turn: ingest calls no model.

/**
 * An exchange into the record of the scope of `tags` (one distinct tag set: `["user:alice"]`, `["team:eng",
 * "agent:review"]`), under `session` (the conversation's id). Key-shaped strings are removed
 * before anything is stored; content past LIMITS.messageChars is cut; a tool's message is untrusted. Answers how many
 * messages were new; the new ones are read by the scope's next drain, which uses `settings` to reach the models.
 */
export const ingest = mutation({
  args: { tags: v.array(v.string()), session: v.string(), messages: v.array(messageValidator), settings: settingsValidator },
  returns: v.object({ stored: v.number(), skipped: v.number() }),
  handler: async (ctx, a): Promise<{ stored: number; skipped: number }> => {
    if (!a.session || a.session.length > LIMITS.sessionChars) fail('invalid', `A session is 1 to ${LIMITS.sessionChars} characters`);
    if (a.session === 'remember') fail('invalid', 'The session `remember` is what remember states');
    if (!a.messages.length || a.messages.length > LIMITS.ingestMessages) fail('invalid', `Ingest takes 1 to ${LIMITS.ingestMessages} messages`);
    const p = await ensureScope(ctx, a.tags);
    await saveSettings(ctx, a.settings);
    const seen = new Set<string>();
    let stored = 0;
    for (const m of a.messages) {
      if (!m.author || m.author.length > 128 || !Number.isFinite(m.at) || m.at < 0) fail('invalid', 'A message needs an author (at most 128 characters) and a time');
      const content = clip(redactSecrets(m.content).text, LIMITS.messageChars).trim();
      if (!content) continue;
      const id = await messageId(a.session, m.role, content);
      if (seen.has(id)) continue;
      seen.add(id);
      const known = await ctx.db
        .query('messages')
        .withIndex('by_scope_message', (q) => q.eq('scope', p._id).eq('messageId', id))
        .unique();
      if (known) continue;
      await ctx.db.insert('messages', {
        scope: p._id,
        tags: p.tags,
        messageId: id,
        session: a.session,
        role: m.role,
        author: m.author,
        ...(m.authorName && NAME_RE.test(m.authorName) ? { authorName: m.authorName } : {}),
        // Tool output is outside text, whatever the caller says of it.
        trust: m.role === 'tool' ? 'untrusted' : m.trust,
        ...(m.authority ? { authority: m.authority } : {}),
        content,
        at: m.at,
        ...(m.tz && TZ_RE.test(m.tz) ? { tz: m.tz } : {}),
        processed: false,
        withheld: false,
      });
      stored++;
    }
    if (stored) await scheduleDrain(ctx, p);
    return { stored, skipped: a.messages.length - stored };
  },
});

/**
 * Derives memories from one batch of a scope's unread messages, then lets the scope go (store.ts commit schedules
 * the next drain while unread messages are left). Holds the scope's lease meanwhile: no two drains read one scope.
 */
export const drain = internalAction({
  args: { scope: v.id('scopes') },
  handler: async (ctx, { scope }) => {
    const owner = crypto.randomUUID();
    const settings = await ctx.runQuery(internal.store.settings, {});
    const claimed = await ctx.runMutation(internal.store.claim, { scope, owner });
    if (!claimed) return;
    const batch = claimed.batch.map((m) => m.id);
    try {
      if (!settings) throw new Error('No model settings: the app has not sent any');
      const models = new Models(ctx, settings);
      const plan = await planIngest(ctx, scope, models, claimed);
      await ctx.runMutation(internal.store.commit, { scope, op: 'ingest', owner, ...(await commitArgsOf(plan)), processed: batch, usage: models.usage.toJSON() });
    } catch (e) {
      const error = e instanceof Error ? e.message : 'error';
      console.error(JSON.stringify({ memory: 'drain failed', scope, error: error.slice(0, 300) }));
      await ctx.runMutation(internal.store.release, { scope, owner, batch, error });
    }
  },
});
