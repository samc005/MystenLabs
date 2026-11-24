// Starts the payment-plan scheduler once per Next.js server (Node.js runtime only).
// Set CIPHER_SCHEDULER=off to disable it, e.g. when another process runs plans.

const EVERY_MS = 60_000;

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.CIPHER_SCHEDULER === "off") return;
  const flag = globalThis as typeof globalThis & { __cipherScheduler?: boolean };
  if (flag.__cipherScheduler) return; // Dev reloads call register again; keep one timer.
  flag.__cipherScheduler = true;
  const { runDuePlanPayments } = await import("./lib/server/plans");
  const tick = () =>
    void runDuePlanPayments()
      .then(({ paid, failed }) => {
        if (paid || failed) console.log(`[plans] paid ${paid}, failed ${failed}`);
      })
      .catch((error) => console.error("[plans]", error instanceof Error ? error.message : error));
  setTimeout(tick, 5_000);
  setInterval(tick, EVERY_MS);
}
