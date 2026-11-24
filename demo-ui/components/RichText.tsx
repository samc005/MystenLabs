"use client";

import { useState } from "react";
import { addressUrl, formatToolText, receiptUrl, shortAddress, type Segment } from "@/lib/display";

function AddressChip({ address, label }: { address: string; label: string | null }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="addr" title={address}>
      <a href={addressUrl(address)} target="_blank" rel="noreferrer">
        {label ? <strong>{label}</strong> : null}
        {label ? " " : null}
        <span className="mono">{shortAddress(address)}</span>
      </a>
      <button
        type="button"
        className="copy"
        aria-label={`Copy ${address}`}
        onClick={() => {
          void navigator.clipboard.writeText(address).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1200);
          });
        }}
      >
        {copied ? "✓" : "⧉"}
      </button>
    </span>
  );
}

function SegmentView({ segment }: { segment: Segment }) {
  if (segment.kind === "text") return <>{segment.text}</>;
  if (segment.kind === "address") return <AddressChip address={segment.address} label={segment.label} />;
  if (segment.kind === "receipt") {
    return (
      <a className="receipt-link" href={receiptUrl(segment.digest)} target="_blank" rel="noreferrer" title={segment.digest}>
        View receipt ↗
      </a>
    );
  }
  return (
    <a href={segment.url} target="_blank" rel="noreferrer">
      View on explorer ↗
    </a>
  );
}

/** Tool and assistant text with short labeled addresses and receipt links. Nothing is dropped. */
export function RichText({ text, labels, className }: { text: string; labels: Record<string, string>; className?: string }) {
  const lines = formatToolText(text, labels);
  return (
    <div className={className ?? "rich"}>
      {lines.map((segments, index) => (
        <div key={index} className="rich-line">
          {segments.length === 0 ? " " : segments.map((segment, i) => <SegmentView key={i} segment={segment} />)}
        </div>
      ))}
    </div>
  );
}
