/** Closed command grammar: the model cannot extend application capabilities. */
export type WalletAction = {
  tool: string;
  args: Record<string, unknown>;
  /** A short note the user wrote ("for pizza"). Stored with the payment; never sent to a tool. */
  note?: string;
};
const address = '0x[0-9a-fA-F]{64}';
const amount = '(?:0|[1-9][0-9]*)(?:\\.[0-9]{1,9})?';
/** Contact names: a letter, then letters, digits, spaces and . _ ' - (30 characters at most). */
const contactName = "[A-Za-z][A-Za-z0-9 ._'-]{0,29}";
/** Notes: a short plain phrase. No newlines, quotes or angle brackets. */
const note = "[A-Za-z0-9][A-Za-z0-9 ,.'!?&()$#@:/+-]{0,79}";

/**
 * Actions handled by the app itself rather than a wallet-mcp tool. Owner actions are only prepared
 * here: the owner's own wallet signs them in the browser. The rest never move money.
 */
export const LOCAL_TOOLS = new Set([
  'save_contact', 'owner_deposit', 'owner_withdraw', 'payment_request', 'payment_plan', 'spending_insights',
]);

export function parseWalletCommand(value: string): WalletAction {
  const text = value.trim();
  if (text.length > 300) throw new Error('Wallet command is too long.');
  if (/^(balance|what\x27s my balance\??)$/i.test(text)) return { tool: 'get_balance', args: {} };
  if (/^(vault|vault status)$/i.test(text)) return { tool: 'vault_status', args: {} };
  if (/^validators$/i.test(text)) return { tool: 'list_validators', args: {} };
  let match = text.match(new RegExp('^send (' + amount + ') SUI to (' + address + ')(?: for (' + note + '))?$', 'i'));
  if (match) {
    return { tool: 'vault_spend', args: { amount: match[1], to: match[2] }, ...(match[3] ? { note: match[3] } : {}) };
  }
  match = text.match(new RegExp('^request payment (' + amount + ') SUI to (' + address + ')$', 'i'));
  if (match) return { tool: 'propose_spend', args: { amount: match[1], recipient: match[2] } };
  match = text.match(new RegExp('^stake (' + amount + ') SUI with (' + address + ')$', 'i'));
  if (match) return { tool: 'vault_stake', args: { amount: match[1], validator: match[2] } };
  match = text.match(/^(quote|swap) ((?:0|[1-9][0-9]*)(?:\.[0-9]{1,9})?) (SUI|tUSDC) to (SUI|tUSDC)$/i);
  if (match) return { tool: match[1].toLowerCase() === 'quote' ? 'swap_quote' : 'propose_trade', args: { amount: match[2], sell: match[3].toUpperCase() === 'SUI' ? 'SUI' : 'tUSDC', buy: match[4].toUpperCase() === 'SUI' ? 'SUI' : 'tUSDC' } };
  match = text.match(/^execute (swap|payment) (prop_[0-9a-f]{10})$/);
  if (match) return { tool: match[1] === 'swap' ? 'vault_swap' : 'vault_spend_approved', args: { proposalId: match[2] } };

  // ---- App actions ----
  match = text.match(new RegExp('^save (' + address + ') as (' + contactName + ')$', 'i'));
  if (match) return { tool: 'save_contact', args: { address: match[1].toLowerCase(), name: match[2].trim() } };
  match = text.match(new RegExp('^(deposit|withdraw) (' + amount + ') SUI$', 'i'));
  if (match) return { tool: match[1].toLowerCase() === 'deposit' ? 'owner_deposit' : 'owner_withdraw', args: { amount: match[2] } };
  // The name match is lazy ('?' on its last quantifier), so in "from Sam for pizza" the name is
  // "Sam" and "pizza" is the note.
  match = text.match(new RegExp('^request (' + amount + ') SUI(?: from (' + address + '|' + contactName + '?))?(?: for (' + note + '))?$', 'i'));
  if (match) {
    return { tool: 'payment_request', args: { amount: match[1], from: match[2]?.trim() ?? null }, ...(match[3] ? { note: match[3] } : {}) };
  }
  match = text.match(new RegExp('^schedule (' + amount + ') SUI to (' + address + ') every (day|week) for ([1-9][0-9]?) times(?: for (' + note + '))?$', 'i'));
  if (match) {
    return {
      tool: 'payment_plan',
      args: { amount: match[1], recipient: match[2], every: match[3].toLowerCase(), count: Number(match[4]) },
      ...(match[5] ? { note: match[5] } : {}),
    };
  }
  match = text.match(/^spending( this week| this month| all time)?$/i);
  if (match) return { tool: 'spending_insights', args: { period: (match[1]?.trim().toLowerCase() ?? 'this week').replace(' ', '_') } };
  throw new Error('Unsupported request. Use: balance; vault status; validators; send <amount> SUI to <full address>; stake <amount> SUI with <validator address>.');
}
export function assertToolAction(action: WalletAction, tool: string, args: unknown): void {
  if (tool !== action.tool || JSON.stringify(args) !== JSON.stringify(action.args)) {
    throw new Error('Policy refused a tool call outside the requested wallet action.');
  }
}

/** Required and optional fields for each intent. Anything else is rejected. */
const FIELDS: Record<string, { required: string[]; optional?: string[] }> = {
  balance: { required: [] },
  'vault status': { required: [] },
  validators: { required: [] },
  send: { required: ['amount', 'recipient'], optional: ['note'] },
  'payment proposal': { required: ['amount', 'recipient'] },
  stake: { required: ['amount', 'validator'] },
  quote: { required: ['amount', 'sell', 'buy'] },
  swap: { required: ['amount', 'sell', 'buy'] },
  'save contact': { required: ['address', 'name'] },
  deposit: { required: ['amount'] },
  withdraw: { required: ['amount'] },
  'payment request': { required: ['amount'], optional: ['from', 'note'] },
  'payment plan': { required: ['amount', 'recipient', 'every', 'count'], optional: ['note'] },
  spending: { required: [], optional: ['period'] },
};

function resolveContact(value: string, contacts: Record<string, string>): string {
  if (/^0x[0-9a-fA-F]{64}$/.test(value)) return value;
  const contact = Object.entries(contacts).find(([name]) => name.toLowerCase() === value.toLowerCase());
  if (!contact) throw new Error(`I don't have a contact named "${value}". Use a full address, or save them first: save 0x… as ${value}.`);
  return contact[1];
}

export function commandFromIntent(value: unknown, contacts: Record<string, string> = {}): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid wallet intent.');
  const v = value as Record<string, unknown>;
  if (typeof v.action !== 'string' || !Object.hasOwn(FIELDS, v.action)) throw new Error('Unsupported request. This assistant only performs wallet actions.');
  const spec = FIELDS[v.action]!;
  const allowed = new Set(['action', ...spec.required, ...(spec.optional ?? [])]);
  if (
    Object.keys(v).some((key) => !allowed.has(key)) ||
    spec.required.some((key) => typeof v[key] !== 'string' || v[key] === '') ||
    Object.entries(v).some(([, field]) => typeof field !== 'string')
  ) {
    throw new Error('Incomplete or unexpected wallet intent fields.');
  }
  if (typeof v.recipient === 'string') v.recipient = resolveContact(v.recipient, contacts);
  const withNote = typeof v.note === 'string' && v.note.trim() ? ` for ${v.note.trim()}` : '';
  let command = v.action;
  if (v.action === 'payment proposal') command = `request payment ${v.amount} SUI to ${v.recipient}`;
  if (v.action === 'send') command = `send ${v.amount} SUI to ${v.recipient}${withNote}`;
  if (v.action === 'stake') command = `stake ${v.amount} SUI with ${v.validator}`;
  if (v.action === 'quote' || v.action === 'swap') command = `${v.action} ${v.amount} ${v.sell} to ${v.buy}`;
  if (v.action === 'save contact') command = `save ${v.address} as ${v.name}`;
  if (v.action === 'deposit' || v.action === 'withdraw') command = `${v.action} ${v.amount} SUI`;
  if (v.action === 'payment request') {
    const from = typeof v.from === 'string' && v.from.trim() ? ` from ${v.from.trim()}` : '';
    command = `request ${v.amount} SUI${from}${withNote}`;
  }
  if (v.action === 'payment plan') command = `schedule ${v.amount} SUI to ${v.recipient} every ${v.every} for ${v.count} times${withNote}`;
  if (v.action === 'spending') command = `spending ${typeof v.period === 'string' ? v.period.replace('_', ' ') : 'this week'}`;
  parseWalletCommand(command); // Enforce exact decimals, addresses, assets and command shape.
  return command;
}

/** Reject invented literal details; semantic interpretation remains untrusted. */
export function assertIntentGrounded(text: string, value: Record<string, unknown>): void {
  const tokens = (s: string) => s.toLowerCase().match(/[a-z0-9_.]+/g)?.join(' ') ?? '';
  const source = ' ' + tokens(text) + ' ';
  for (const field of ['recipient', 'validator', 'amount', 'address', 'name', 'from', 'note', 'count']) {
    const detail = value[field];
    if (typeof detail === 'string' && (!tokens(detail) || !source.includes(' ' + tokens(detail) + ' '))) {
      throw new Error('The translated action introduced details not present in your request.');
    }
  }
}
