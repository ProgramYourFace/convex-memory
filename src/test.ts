/// <reference types="vite/client" />
import type { TestConvex } from 'convex-test';
import { componentsGeneric, type GenericSchema, type SchemaDefinition } from 'convex/server';
import type { ComponentApi } from './component/_generated/component.js';
import schema from './component/schema.js';
const modules = import.meta.glob('./component/**/*.ts');

/**
 * Registers the memory component with a convex-test instance, for an app's own tests:
 *
 * ```ts
 * import memoryTest from "convex-memory/test";
 * const t = convexTest(schema, modules);
 * memoryTest.register(t);
 * ```
 *
 * @param t - The test convex instance, e.g. from calling `convexTest`.
 * @param name - The name of the component, as registered in convex.config.ts (default `memory`).
 */
export function register<Schema extends SchemaDefinition<GenericSchema, boolean>>(t: TestConvex<Schema>, name: string = 'memory') {
  t.registerComponent(name, schema, modules);
  return componentsGeneric()[name] as unknown as ComponentApi;
}
export default { register, schema, modules };
