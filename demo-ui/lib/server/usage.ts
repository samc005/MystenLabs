// Daily chat budget. Each chat request spends the operator's Anthropic key, so with open sign-up
// every account gets its own daily allowance, plus one global ceiling as a backstop against
// many accounts adding up. Counters are persisted so a restart cannot reset them.

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { accountsDir } from "./accounts";

export class LimitError extends Error {
  constructor(
    readonly scope: "account" | "global",
    message: string,
  ) {
    super(message);
  }
}

export interface Limits {
  account: number;
  global: number;
}

interface Usage {
  day: string;
  counts: Record<string, number>;
}

const GLOBAL_KEY = "*";
const usageFile = () => join(accountsDir(), "usage.json");

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function limitsFromEnv(env: NodeJS.ProcessEnv = process.env): Limits {
  return {
    account: positiveInt(env.CHAT_DAILY_LIMIT, 50),
    global: positiveInt(env.CHAT_GLOBAL_DAILY_LIMIT, 1000),
  };
}

let queue: Promise<unknown> = Promise.resolve();

/** Counts one chat request, or throws LimitError. Days roll over at 00:00 UTC. */
export function consumeDaily(
  accountId: string,
  limits: Limits,
  now = Date.now(),
): Promise<{ remaining: number }> {
  const run = queue.then(async () => {
    const day = new Date(now).toISOString().slice(0, 10);
    let usage: Usage = { day, counts: {} };
    try {
      const stored = JSON.parse(await readFile(usageFile(), "utf8")) as Usage;
      if (stored.day === day && stored.counts && typeof stored.counts === "object") usage = stored;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const mine = usage.counts[accountId] ?? 0;
    const total = usage.counts[GLOBAL_KEY] ?? 0;
    if (mine >= limits.account) {
      throw new LimitError("account", `Daily chat limit reached (${limits.account} requests). It resets at 00:00 UTC.`);
    }
    if (total >= limits.global) {
      throw new LimitError("global", "This app's daily chat budget is used up. Try again after 00:00 UTC.");
    }
    usage.counts[accountId] = mine + 1;
    usage.counts[GLOBAL_KEY] = total + 1;

    await mkdir(accountsDir(), { recursive: true, mode: 0o700 });
    const temporary = join(accountsDir(), `usage.${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(usage), { mode: 0o600, flag: "wx" });
    await rename(temporary, usageFile());
    return { remaining: limits.account - usage.counts[accountId] };
  });
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
