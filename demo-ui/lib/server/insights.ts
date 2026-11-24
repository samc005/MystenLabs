// Spending insights computed from the account's on-chain activity. Pure, so it is unit-tested.
// v1 recomputes from the chain on each request; v2 reads a per-account store (the memory DB).

import type { ActivityEntry } from "./activity";

export type Period = "this_week" | "this_month" | "all_time";

export interface Insights {
  period: Period;
  /** Money that left the account to other people: vault payments and direct sends. */
  spentMist: string;
  receivedMist: string;
  payments: number;
  spentByCipherMist: string;
  spentByYouMist: string;
  topRecipients: { address: string; label: string | null; totalMist: string; count: number }[];
  /** One bucket per day (week, month) or per month (all time), oldest first. */
  series: { label: string; start: string; spentMist: string }[];
  notes: { digest: string; note: string; amountMist: string | null; timestamp: string | null }[];
}

const DAY = 24 * 60 * 60 * 1000;

function periodStart(period: Period, now: Date): Date | null {
  if (period === "all_time") return null;
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setTime(start.getTime() - (period === "this_week" ? 6 : 29) * DAY);
  return start;
}

const isSpend = (entry: ActivityEntry) =>
  entry.success && (entry.kind === "payment" || entry.kind === "sent") && entry.amountMist !== null;

export function computeInsights(entries: ActivityEntry[], period: Period, now = new Date()): Insights {
  const start = periodStart(period, now);
  const inPeriod = entries.filter((entry) => entry.timestamp && (!start || Date.parse(entry.timestamp) >= start.getTime()));
  const spends = inPeriod.filter(isSpend);
  const sum = (list: ActivityEntry[]) => list.reduce((total, entry) => total + BigInt(entry.amountMist ?? "0"), 0n);

  const recipients = new Map<string, { address: string; label: string | null; total: bigint; count: number }>();
  for (const entry of spends) {
    if (!entry.counterparty) continue;
    const current = recipients.get(entry.counterparty.address) ?? { ...entry.counterparty, total: 0n, count: 0 };
    current.total += BigInt(entry.amountMist!);
    current.count += 1;
    recipients.set(entry.counterparty.address, current);
  }

  let series: Insights["series"];
  if (start) {
    const days = period === "this_week" ? 7 : 30;
    series = Array.from({ length: days }, (_, i) => {
      const day = new Date(start.getTime() + i * DAY);
      const next = day.getTime() + DAY;
      const total = sum(spends.filter((e) => Date.parse(e.timestamp!) >= day.getTime() && Date.parse(e.timestamp!) < next));
      return {
        label: day.toLocaleDateString("en-US", period === "this_week" ? { weekday: "short" } : { month: "short", day: "numeric" }),
        start: day.toISOString(),
        spentMist: total.toString(),
      };
    });
  } else {
    // Last 12 months, oldest first.
    series = Array.from({ length: 12 }, (_, i) => {
      const month = new Date(now.getFullYear(), now.getMonth() - (11 - i), 1);
      const next = new Date(month.getFullYear(), month.getMonth() + 1, 1);
      const total = sum(spends.filter((e) => Date.parse(e.timestamp!) >= month.getTime() && Date.parse(e.timestamp!) < next.getTime()));
      return { label: month.toLocaleDateString("en-US", { month: "short" }), start: month.toISOString(), spentMist: total.toString() };
    });
  }

  return {
    period,
    spentMist: sum(spends).toString(),
    receivedMist: sum(inPeriod.filter((e) => e.success && e.kind === "received")).toString(),
    payments: spends.length,
    spentByCipherMist: sum(spends.filter((e) => e.by === "cipher")).toString(),
    spentByYouMist: sum(spends.filter((e) => e.by === "you")).toString(),
    topRecipients: [...recipients.values()]
      .sort((a, b) => (b.total > a.total ? 1 : b.total < a.total ? -1 : b.count - a.count))
      .slice(0, 5)
      .map((r) => ({ address: r.address, label: r.label, totalMist: r.total.toString(), count: r.count })),
    series,
    notes: inPeriod
      .filter((entry) => entry.note)
      .map((entry) => ({ digest: entry.digest, note: entry.note!, amountMist: entry.amountMist, timestamp: entry.timestamp })),
  };
}

const PERIOD_WORDS: Record<Period, string> = { this_week: "in the last 7 days", this_month: "in the last 30 days", all_time: "in total" };

/** A short chat answer. Numbers only from computeInsights. */
export function describeInsights(insights: Insights, formatSui: (mist: bigint) => string): string {
  const spent = BigInt(insights.spentMist);
  const when = PERIOD_WORDS[insights.period];
  if (spent === 0n && insights.payments === 0) {
    return `You haven't spent anything ${when}. Your Dashboard has the full picture.`;
  }
  const lines = [
    `You spent ${formatSui(spent)} SUI ${when}, across ${insights.payments} payment${insights.payments === 1 ? "" : "s"}.`,
    `• Cipher paid ${formatSui(BigInt(insights.spentByCipherMist))} SUI for you; you sent ${formatSui(BigInt(insights.spentByYouMist))} SUI yourself.`,
  ];
  const [top] = insights.topRecipients;
  if (top) lines.push(`• You paid ${top.label ?? top.address} the most: ${formatSui(BigInt(top.totalMist))} SUI over ${top.count} payment${top.count === 1 ? "" : "s"}.`);
  if (BigInt(insights.receivedMist) > 0n) lines.push(`• You received ${formatSui(BigInt(insights.receivedMist))} SUI.`);
  lines.push("", "Open your Dashboard (top of the page) for charts, plans and requests.");
  return lines.join("\n");
}
