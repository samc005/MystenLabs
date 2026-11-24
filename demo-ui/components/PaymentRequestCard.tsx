"use client";

import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { paymentUri, type PaymentRequestView } from "@/lib/payment-request";
import { explorerTxUrl, formatSui } from "@/lib/sui";
import { shortAddress } from "@/lib/display";

/** A shareable request: scan the QR with any Sui wallet (e.g. Slush) to pay. */
export function PaymentRequestCard({ request, compact = false }: { request: PaymentRequestView; compact?: boolean }) {
  const [qr, setQr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const uri = paymentUri(request);

  useEffect(() => {
    if (request.status !== "open") return;
    // Inline SVG data URL: no network, crisp at any size, follows the card's colors.
    void QRCode.toString(uri, { type: "svg", margin: 1, errorCorrectionLevel: "M" }).then((svg) =>
      setQr(`data:image/svg+xml;utf8,${encodeURIComponent(svg)}`),
    );
  }, [uri, request.status]);

  return (
    <div className={`confirm-card request-card ${request.status}`}>
      <div className="request-head">
        <div>
          <strong>Request: {formatSui(BigInt(request.amountMist))} SUI</strong>
          {request.note && <span className="muted"> for {request.note}</span>}
          {request.from && <div className="muted small">From {request.from.startsWith("0x") ? shortAddress(request.from) : request.from}</div>}
          <div className="muted small">Pays your wallet {shortAddress(request.receiver)}</div>
        </div>
        <span className={`status-pill ${request.status === "paid" ? "approved" : request.status}`}>{request.status}</span>
      </div>
      {request.status === "open" && !compact && qr && (
        // eslint-disable-next-line @next/next/no-img-element
        <img className="request-qr" src={qr} alt={`QR code to pay ${formatSui(BigInt(request.amountMist))} SUI`} width={180} height={180} />
      )}
      {request.status === "open" && (
        <div className="actions">
          <button
            className="secondary small-btn"
            onClick={() =>
              void navigator.clipboard.writeText(uri).then(() => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1500);
              })
            }
          >
            {copied ? "Copied" : "Copy payment link"}
          </button>
        </div>
      )}
      {request.status === "paid" && request.paidDigest && (
        <a className="receipt-link small" href={explorerTxUrl(request.paidDigest)} target="_blank" rel="noreferrer">
          Paid. View receipt ↗
        </a>
      )}
    </div>
  );
}
