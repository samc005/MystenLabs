import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Sui Wallet Demo",
  description: "Create a Sui testnet wallet, fund it, check balances, and send SUI, using the same code as the wallet MCP tools.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
