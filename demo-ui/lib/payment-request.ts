// Payment request links in the Sui Payment Kit format (`sui:pay?...`), which Sui wallets such as
// Slush can scan. Written here instead of importing @mysten/payment-kit, which needs a newer
// @mysten/sui than this app uses. The fields match that package's createPaymentTransactionUri.

const SUI_COIN = "0x2::sui::SUI";

export interface PaymentRequestView {
  id: string;
  amountMist: string;
  from: string | null;
  note: string | null;
  receiver: string;
  createdAt: string;
  status: "open" | "paid" | "cancelled";
  paidDigest?: string;
}

export function paymentUri(request: Pick<PaymentRequestView, "id" | "amountMist" | "receiver" | "note">): string {
  if (!/^0x[0-9a-f]{64}$/.test(request.receiver)) throw new Error("Invalid receiver address.");
  if (!/^[1-9][0-9]*$/.test(request.amountMist)) throw new Error("Amount must be positive.");
  const params = new URLSearchParams({
    receiver: request.receiver,
    amount: request.amountMist,
    coinType: SUI_COIN,
    // Payment Kit nonces are at most 36 characters; our ids are UUIDs.
    nonce: request.id.slice(0, 36),
    label: "Cipher",
  });
  if (request.note) params.append("message", request.note);
  return `sui:pay?${params.toString()}`;
}
