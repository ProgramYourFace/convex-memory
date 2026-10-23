import { defineApp } from "convex/server";
import memory from "convex-memory/convex.config.js";

const app = defineApp();
app.use(memory);

export default app;
