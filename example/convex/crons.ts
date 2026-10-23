import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// The component's maintenance pass: a drain whose schedule was lost, memories whose embedding failed, old logs.
crons.interval("memory sweep", { minutes: 15 }, internal.memory.sweep, {});

export default crons;
