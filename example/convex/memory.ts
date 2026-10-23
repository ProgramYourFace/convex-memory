import { Memory, defineModelTransport } from "convex-memory";
import { v } from "convex/values";
import { components, internal } from "./_generated/api";
import { action, internalMutation, mutation, query } from "./_generated/server";
import type { Auth } from "convex/server";

// Model access: the component holds no key and reads no env, so its requests go through this action, which adds the
// deployment's AI Gateway token. For another OpenAI-compatible provider:
//   defineModelTransport({ baseUrl: "https://api.openai.com", apiKey: () => process.env.OPENAI_API_KEY! })
// with `dialect: "openai"` and `models` below.
export const transport = defineModelTransport();

const memory: Memory = new Memory(components.memory, { transport: internal.memory.transport });

// Tags this app writes: `user:<id>` for a person's own memory, `company` for what everyone shares. A read layers them:
// the person's own memory first, then the company's.
const COMPANY = "company";
const userTag = (userId: string) => `user:${userId}`;
const layersFor = (userId: string) => [
  { name: "yours", filter: userTag(userId) },
  { name: "company", filter: COMPANY },
];

/** The signed-in user, or a refusal. The app, never a model or a tool, decides which tags a call writes and reads. */
async function me(ctx: { auth: Auth }): Promise<string> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error("Not signed in");
  return identity.subject;
}

/** One exchange of the signed-in user's conversation into their private memory (memories follow in the background). */
export const ingestExchange = mutation({
  args: { session: v.string(), user: v.string(), assistant: v.string() },
  handler: async (ctx, a) => {
    const userId = await me(ctx);
    const at = Date.now();
    return await memory.ingest(ctx, {
      tags: [userTag(userId)],
      session: a.session,
      messages: [
        // The user's own words are trusted; the assistant's are trusted but never vouch for a memory.
        { role: "user", author: userId, trust: "trusted", content: a.user, at },
        { role: "assistant", author: "assistant", trust: "trusted", content: a.assistant, at: at + 1 },
      ],
    });
  },
});

/** Before a model turn: the user's and the company's instructions and relevant memories, layered, within a budget. */
export const contextForTurn = action({
  args: { turn: v.string() },
  handler: async (ctx, a) => {
    const userId = await me(ctx);
    return await memory.context(ctx, {
      filter: { any: [userTag(userId), COMPANY] },
      layers: layersFor(userId),
      turn: a.turn,
      budgetTokens: 1_500,
      reader: userId,
    });
  },
});

/** The user asks the assistant to remember something in their own words. */
export const rememberThis = action({
  args: { content: v.string() },
  handler: async (ctx, a) => {
    const userId = await me(ctx);
    return await memory.remember(ctx, { tags: [userTag(userId)], content: a.content, author: userId, trust: "trusted" });
  },
});

/** The user's memories, newest first. */
export const myMemories = query({
  args: { cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, a) => {
    const userId = await me(ctx);
    return await memory.list(ctx, { filter: userTag(userId), paginationOpts: { numItems: 20, cursor: a.cursor } });
  },
});

/** The user forgets one of their memories. */
export const forgetMine = mutation({
  args: { id: v.string() },
  handler: async (ctx, a) => {
    const userId = await me(ctx);
    return await memory.forget(ctx, { tags: [userTag(userId)], id: a.id });
  },
});

/** When a user is deleted: every memory written under their tag, alone or with others, is erased. */
export const deleteUserMemory = internalMutation({
  args: { userId: v.string() },
  handler: async (ctx, a) => {
    await memory.purge(ctx, { tag: userTag(a.userId) });
  },
});

/** The maintenance pass the cron runs. */
export const sweep = internalMutation({
  args: {},
  handler: async (ctx) => {
    await memory.sweep(ctx);
  },
});
