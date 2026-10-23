/* eslint-disable */
/**
 * Generated `ComponentApi` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type { FunctionReference } from "convex/server";

/**
 * A utility for referencing a Convex component's exposed API.
 *
 * Useful when expecting a parameter like `components.myComponent`.
 * Usage:
 * ```ts
 * async function myFunction(ctx: QueryCtx, component: ComponentApi) {
 *   return ctx.runQuery(component.someFile.someQuery, { ...args });
 * }
 * ```
 */
export type ComponentApi<Name extends string | undefined = string | undefined> =
  {
    ingest: {
      ingest: FunctionReference<
        "mutation",
        "internal",
        {
          messages: Array<{
            at: number;
            author: string;
            authorName?: string;
            authority?: "manager" | "member";
            content: string;
            role: "user" | "assistant" | "tool" | "system" | "note";
            trust: "trusted" | "untrusted";
            tz?: string;
          }>;
          session: string;
          settings: {
            decisionModel: string | null;
            dialect: "gateway" | "openai";
            embeddingModel: string;
            embeddingQueryPrefix: string | null;
            prices: Array<{ input: number; model: string; output: number }>;
            routing: Record<string, any> | null;
            transport: string;
            writerModel: string;
            writerReasoning: string | null;
          };
          tags: Array<string>;
        },
        { skipped: number; stored: number },
        Name
      >;
    };
    purge: {
      purge: FunctionReference<
        "mutation",
        "internal",
        { tag?: string; tags?: Array<string> },
        { done: boolean },
        Name
      >;
      reopen: FunctionReference<
        "mutation",
        "internal",
        { tag?: string; tags?: Array<string> },
        { reopened: boolean },
        Name
      >;
    };
    read: {
      context: FunctionReference<
        "action",
        "internal",
        {
          budgetTokens: number;
          filter: any;
          layers?: Array<{ filter: any; name: string; weight?: number }>;
          names?: Record<string, string>;
          reader?: string;
          recent?: string;
          settings: {
            decisionModel: string | null;
            dialect: "gateway" | "openai";
            embeddingModel: string;
            embeddingQueryPrefix: string | null;
            prices: Array<{ input: number; model: string; output: number }>;
            routing: Record<string, any> | null;
            transport: string;
            writerModel: string;
            writerReasoning: string | null;
          };
          turn: string;
        },
        {
          gated: boolean;
          memories: Array<{
            at: number;
            author: string;
            confidence: number;
            content: string;
            id: string;
            kind: "fact" | "event" | "instruction" | "task";
            layer: string | null;
            scope: string;
            score: number;
            sources: Array<string>;
            tags: Array<string>;
            topic: string | null;
            trust: "trusted" | "untrusted";
            via: string | null;
          }>;
          note: string;
          usage: {
            costMicros: number;
            models: Array<{
              calls: number;
              inputTokens: number;
              model: string;
              outputTokens: number;
            }>;
          };
        },
        Name
      >;
      get: FunctionReference<
        "query",
        "internal",
        { id: string; tags: Array<string> },
        {
          author: string;
          authority: "manager" | "member" | null;
          confidence: number;
          content: string;
          forgottenAt: number | null;
          id: string;
          kind: "fact" | "event" | "instruction" | "task";
          queries: Array<string>;
          recordedAt: number;
          scope: string;
          sources: Array<string>;
          supersededAt: number | null;
          supersededBy: string | null;
          supersedes: string | null;
          tags: Array<string>;
          topic: string | null;
          trust: "trusted" | "untrusted";
          validFrom: number | null;
          validTo: number | null;
          via: string | null;
        } | null,
        Name
      >;
      history: FunctionReference<
        "query",
        "internal",
        { id?: string; tags: Array<string>; topic?: string },
        {
          versions: Array<{
            author: string;
            authority: "manager" | "member" | null;
            confidence: number;
            content: string;
            forgottenAt: number | null;
            id: string;
            kind: "fact" | "event" | "instruction" | "task";
            queries: Array<string>;
            recordedAt: number;
            scope: string;
            sources: Array<string>;
            supersededAt: number | null;
            supersededBy: string | null;
            supersedes: string | null;
            tags: Array<string>;
            topic: string | null;
            trust: "trusted" | "untrusted";
            validFrom: number | null;
            validTo: number | null;
            via: string | null;
          }>;
        },
        Name
      >;
      list: FunctionReference<
        "query",
        "internal",
        {
          filter: any;
          includeHistory?: boolean;
          kind?: "fact" | "event" | "instruction" | "task";
          paginationOpts: {
            cursor: string | null;
            endCursor?: string | null;
            id?: number;
            maximumBytesRead?: number;
            maximumRowsRead?: number;
            numItems: number;
          };
          topic?: string;
        },
        {
          continueCursor: string;
          isDone: boolean;
          page: Array<{
            author: string;
            authority: "manager" | "member" | null;
            confidence: number;
            content: string;
            forgottenAt: number | null;
            id: string;
            kind: "fact" | "event" | "instruction" | "task";
            queries: Array<string>;
            recordedAt: number;
            scope: string;
            sources: Array<string>;
            supersededAt: number | null;
            supersededBy: string | null;
            supersedes: string | null;
            tags: Array<string>;
            topic: string | null;
            trust: "trusted" | "untrusted";
            validFrom: number | null;
            validTo: number | null;
            via: string | null;
          }>;
        },
        Name
      >;
      recall: FunctionReference<
        "action",
        "internal",
        {
          filter: any;
          layers?: Array<{ filter: any; name: string; weight?: number }>;
          limit?: number;
          query: string;
          settings: {
            decisionModel: string | null;
            dialect: "gateway" | "openai";
            embeddingModel: string;
            embeddingQueryPrefix: string | null;
            prices: Array<{ input: number; model: string; output: number }>;
            routing: Record<string, any> | null;
            transport: string;
            writerModel: string;
            writerReasoning: string | null;
          };
          synthesize?: boolean;
        },
        {
          answer: string | null;
          answerUntrusted: boolean;
          memories: Array<{
            at: number;
            author: string;
            confidence: number;
            content: string;
            id: string;
            kind: "fact" | "event" | "instruction" | "task";
            layer: string | null;
            scope: string;
            score: number;
            sources: Array<string>;
            tags: Array<string>;
            topic: string | null;
            trust: "trusted" | "untrusted";
            via: string | null;
          }>;
          messages: Array<{
            at: number;
            author: string;
            content: string;
            id: string;
            layer: string | null;
            role: "user" | "assistant" | "tool" | "system" | "note";
            scope: string;
            score: number;
            session: string;
            tags: Array<string>;
            trust: "trusted" | "untrusted";
          }>;
          usage: {
            costMicros: number;
            models: Array<{
              calls: number;
              inputTokens: number;
              model: string;
              outputTokens: number;
            }>;
          };
        },
        Name
      >;
      searchHistory: FunctionReference<
        "query",
        "internal",
        {
          filter: any;
          layers?: Array<{ filter: any; name: string; weight?: number }>;
          limit?: number;
          query: string;
        },
        {
          hits: Array<
            | {
                at: number;
                author: string;
                confidence: number;
                content: string;
                id: string;
                kind: "fact" | "event" | "instruction" | "task";
                layer: string | null;
                scope: string;
                score: number;
                source: "memory";
                sources: Array<string>;
                tags: Array<string>;
                topic: string | null;
                trust: "trusted" | "untrusted";
                via: string | null;
              }
            | {
                at: number;
                author: string;
                content: string;
                id: string;
                layer: string | null;
                role: "user" | "assistant" | "tool" | "system" | "note";
                scope: string;
                score: number;
                session: string;
                source: "message";
                tags: Array<string>;
                trust: "trusted" | "untrusted";
              }
          >;
        },
        Name
      >;
    };
    sweep: {
      run: FunctionReference<
        "mutation",
        "internal",
        {
          settings?: {
            decisionModel: string | null;
            dialect: "gateway" | "openai";
            embeddingModel: string;
            embeddingQueryPrefix: string | null;
            prices: Array<{ input: number; model: string; output: number }>;
            routing: Record<string, any> | null;
            transport: string;
            writerModel: string;
            writerReasoning: string | null;
          };
        },
        null,
        Name
      >;
    };
    write: {
      forget: FunctionReference<
        "mutation",
        "internal",
        { authority?: "manager" | "member"; id: string; tags: Array<string> },
        { forgotten: Array<string> },
        Name
      >;
      remember: FunctionReference<
        "action",
        "internal",
        {
          author: string;
          authorName?: string;
          authority?: "manager" | "member";
          content: string;
          kind?: "fact" | "event" | "instruction" | "task";
          settings: {
            decisionModel: string | null;
            dialect: "gateway" | "openai";
            embeddingModel: string;
            embeddingQueryPrefix: string | null;
            prices: Array<{ input: number; model: string; output: number }>;
            routing: Record<string, any> | null;
            transport: string;
            writerModel: string;
            writerReasoning: string | null;
          };
          tags: Array<string>;
          topic?: string;
          trust: "trusted" | "untrusted";
          via?: string;
        },
        {
          memory: {
            author: string;
            authority: "manager" | "member" | null;
            confidence: number;
            content: string;
            forgottenAt: number | null;
            id: string;
            kind: "fact" | "event" | "instruction" | "task";
            queries: Array<string>;
            recordedAt: number;
            scope: string;
            sources: Array<string>;
            supersededAt: number | null;
            supersededBy: string | null;
            supersedes: string | null;
            tags: Array<string>;
            topic: string | null;
            trust: "trusted" | "untrusted";
            validFrom: number | null;
            validTo: number | null;
            via: string | null;
          };
          superseded: Array<string>;
          usage: {
            costMicros: number;
            models: Array<{
              calls: number;
              inputTokens: number;
              model: string;
              outputTokens: number;
            }>;
          };
        },
        Name
      >;
      restore: FunctionReference<
        "action",
        "internal",
        {
          authority?: "manager" | "member";
          settings: {
            decisionModel: string | null;
            dialect: "gateway" | "openai";
            embeddingModel: string;
            embeddingQueryPrefix: string | null;
            prices: Array<{ input: number; model: string; output: number }>;
            routing: Record<string, any> | null;
            transport: string;
            writerModel: string;
            writerReasoning: string | null;
          };
          tags: Array<string>;
          versionId: string;
        },
        {
          memory: {
            author: string;
            authority: "manager" | "member" | null;
            confidence: number;
            content: string;
            forgottenAt: number | null;
            id: string;
            kind: "fact" | "event" | "instruction" | "task";
            queries: Array<string>;
            recordedAt: number;
            scope: string;
            sources: Array<string>;
            supersededAt: number | null;
            supersededBy: string | null;
            supersedes: string | null;
            tags: Array<string>;
            topic: string | null;
            trust: "trusted" | "untrusted";
            validFrom: number | null;
            validTo: number | null;
            via: string | null;
          };
          superseded: Array<string>;
          usage: {
            costMicros: number;
            models: Array<{
              calls: number;
              inputTokens: number;
              model: string;
              outputTokens: number;
            }>;
          };
        },
        Name
      >;
    };
  };
