import Link from "next/link";

export default function Home() {
  return (
    <main className="page">
      <header className="masthead">
        <p className="eyebrow">
          <span className="pill">testnet</span> Coins here have no value
        </p>
        <h1>AI wallet on Sui</h1>
        <p className="lede">
          Two demos of the same wallet code. One runs entirely in your browser. The other lets you ask Claude to move
          SUI, and Claude does it by calling the wallet-mcp tools.
        </p>
      </header>

      <div className="demo-grid">
        <Link href="/browser-wallet" className="card demo-card">
          <span className="demo-tag">Runs anywhere</span>
          <h2>Browser wallet</h2>
          <p className="muted">
            Create a wallet in the page, fund it from the faucet, and send SUI. Each action shows the MCP tool call an AI
            would make.
          </p>
          <span className="demo-cta">Open demo →</span>
        </Link>

        <Link href="/chat" className="card demo-card">
          <span className="demo-tag local">Local only</span>
          <h2>Chat with Claude</h2>
          <p className="muted">
            Type a request. Claude calls get_balance and transfer_sui on the real wallet-mcp server, using the wallets your
            npm scripts created, and the balances update live.
          </p>
          <span className="demo-cta">Open demo →</span>
        </Link>
      </div>
    </main>
  );
}
