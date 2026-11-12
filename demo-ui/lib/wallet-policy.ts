/** Closed command grammar: the model cannot extend application capabilities. */
export type WalletAction = { tool: string; args: Record<string, unknown> };
const address = '0x[0-9a-fA-F]{64}';
const amount = '(?:0|[1-9][0-9]*)(?:\\.[0-9]{1,9})?';
export function parseWalletCommand(value: string): WalletAction {
  const text = value.trim();
  if (text.length > 300) throw new Error('Wallet command is too long.');
  if (/^(balance|what\x27s my balance\??)$/i.test(text)) return { tool: 'get_balance', args: {} };
  if (/^(vault|vault status)$/i.test(text)) return { tool: 'vault_status', args: {} };
  if (/^validators$/i.test(text)) return { tool: 'list_validators', args: {} };
  let match = text.match(new RegExp('^send (' + amount + ') SUI to (' + address + ')$', 'i'));
  if (match) return { tool: 'vault_spend', args: { amount: match[1], to: match[2] } };
  match = text.match(new RegExp('^request payment (' + amount + ') SUI to (' + address + ')$', 'i'));
  if (match) return { tool: 'propose_spend', args: { amount: match[1], recipient: match[2] } };
  match = text.match(new RegExp('^stake (' + amount + ') SUI with (' + address + ')$', 'i'));
  if (match) return { tool: 'vault_stake', args: { amount: match[1], validator: match[2] } };
  match = text.match(/^(quote|swap) ((?:0|[1-9][0-9]*)(?:\.[0-9]{1,9})?) (SUI|tUSDC) to (SUI|tUSDC)$/i);
  if (match) return { tool: match[1].toLowerCase() === 'quote' ? 'swap_quote' : 'propose_trade', args: { amount: match[2], sell: match[3].toUpperCase() === 'SUI' ? 'SUI' : 'tUSDC', buy: match[4].toUpperCase() === 'SUI' ? 'SUI' : 'tUSDC' } };
  match = text.match(/^execute (swap|payment) (prop_[0-9a-f]{10})$/);
  if (match) return { tool: match[1] === 'swap' ? 'vault_swap' : 'vault_spend_approved', args: { proposalId: match[2] } };
  throw new Error('Unsupported request. Use: balance; vault status; validators; send <amount> SUI to <full address>; stake <amount> SUI with <validator address>.');
}
export function assertToolAction(action: WalletAction, tool: string, args: unknown): void {
  if (tool !== action.tool || JSON.stringify(args) !== JSON.stringify(action.args)) {
    throw new Error('Policy refused a tool call outside the requested wallet action.');
  }
}

export function commandFromIntent(value: unknown, contacts: Record<string, string> = {}): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid wallet intent.');
  const v = value as Record<string, unknown>;
  const fields: Record<string, string[]> = {
    balance: [], 'vault status': [], validators: [], send: ['amount', 'recipient'], 'payment proposal': ['amount', 'recipient'],
    stake: ['amount', 'validator'], quote: ['amount', 'sell', 'buy'], swap: ['amount', 'sell', 'buy'],
  };
  if (typeof v.action !== 'string' || !Object.hasOwn(fields, v.action)) throw new Error('Unsupported request. This assistant only performs wallet actions.');
  const expected = ['action', ...fields[v.action]!];
  if (Object.keys(v).length !== expected.length || expected.some(k => typeof v[k] !== 'string')) throw new Error('Incomplete or unexpected wallet intent fields.');
  if (typeof v.recipient === 'string' && !/^0x[0-9a-fA-F]{64}$/.test(v.recipient)) {
    const contact = Object.entries(contacts).find(([name]) => name.toLowerCase() === (v.recipient as string).toLowerCase());
    if (!contact) throw new Error("Unknown contact. Use a full address or configure a trusted contact.");
    v.recipient = contact[1];
  }
  let command = v.action;
  if (v.action === 'payment proposal') command = `request payment ${v.amount} SUI to ${v.recipient}`;
  if (v.action === 'send') command = `send ${v.amount} SUI to ${v.recipient}`;
  if (v.action === 'stake') command = `stake ${v.amount} SUI with ${v.validator}`;
  if (v.action === 'quote' || v.action === 'swap') command = `${v.action} ${v.amount} ${v.sell} to ${v.buy}`;
  parseWalletCommand(command); // Enforce exact decimals, addresses, assets and command shape.
  return command;
}

/** Reject invented literal details; semantic interpretation remains untrusted. */
export function assertIntentGrounded(text: string, value: Record<string, unknown>): void {
  const tokens = (s: string) => s.toLowerCase().match(/[a-z0-9_.]+/g)?.join(' ') ?? '';
  const source = ' ' + tokens(text) + ' ';
  for (const field of ['recipient', 'validator', 'amount']) {
    const detail = value[field];
    if (typeof detail === 'string' && (!tokens(detail) || !source.includes(' ' + tokens(detail) + ' '))) {
      throw new Error('The translated action introduced details not present in your request.');
    }
  }
}
