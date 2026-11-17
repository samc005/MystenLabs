// Read-only live translator -> direct PTB -> testnet simulation evidence.
// No signer, key loader, executeTransaction, or transaction submission.
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
const require = createRequire(import.meta.url);
function load(relative, modules) {
  const source = readFileSync(new URL(relative, import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
  const exports = {};
  new Function('require','exports',compiled)(name => modules[name] ?? require(name), exports);
  return exports;
}
const policy = load('../lib/wallet-policy.ts', {});
const {resolveWalletCommand} = load('../lib/server/wallet-intent.ts', {'../wallet-policy':policy});
const {createSuiClient} = await import('../../wallet-mcp/build/blockchain/client.js');
const {getVaultStatus} = await import('../../wallet-mcp/build/blockchain/vault.js');
const {vaultConfig} = await import('../../wallet-mcp/build/config.js');
const walletRequire = createRequire(new URL('../../wallet-mcp/package.json',import.meta.url));
const {Transaction} = walletRequire('@mysten/sui/transactions');
const config = vaultConfig(), client = createSuiClient('testnet');
const status = await getVaultStatus(client, config);
const recipient = status.allowedRecipients[0] ?? '0x'+'1'.padStart(64,'0');
const amount = status.perTxLimitMist + 1n;
const decimal = `${amount / 1000000000n}.${(amount % 1000000000n).toString().padStart(9,'0')}`;
const prompt = `Please send ${decimal} SUI to ${recipient}`;
const command = await resolveWalletCommand(prompt, AbortSignal.timeout(45000));
const action = policy.parseWalletCommand(command);
if (action.tool !== 'vault_spend' || action.args.amount !== decimal || action.args.to !== recipient) throw new Error('Translator changed requested transaction');
const tx = new Transaction();
tx.setSender(process.env.SUI_ADDRESS);
tx.moveCall({target:`${config.packageId}::spending_vault::${status.calendarPolicy ? 'spend_with_clock' : 'spend'}`,
 arguments:[tx.object(config.agentCapId),tx.object(config.vaultId),tx.pure.address(recipient),tx.pure.u64(amount),...(status.calendarPolicy?[tx.object.clock()]:[])]});
// Deliberately bypass prepareVaultSpend and local classification to reach Move.
const result = await client.simulateTransaction({transaction:tx,include:{effects:true}});
if (result.$kind !== 'FailedTransaction') throw new Error('Adversarial over-limit transaction unexpectedly succeeded');
const reason = result.FailedTransaction.status.error?.message ?? '';
// Infrastructure/type/ownership errors do not demonstrate contract enforcement.
if (!/spending_vault/.test(reason) || !/(?:abort.*(?:code[^0-9]*)?2\b|code[^0-9]*2\b)/i.test(reason)) {
  throw new Error(`Expected spending_vault EOverLimit (2); simulation returned: ${reason}`);
}
const report = {checkedAt:new Date().toISOString(),network:'testnet',packageId:config.packageId,vaultId:config.vaultId,prompt,command,expectedAbort:'EOverLimit (2)',reason,submitted:false};
// A second independent flow proves validator policy rather than payment policy.
const validator = ['0x'+'1'.padStart(64,'0'),'0x'+'2'.padStart(64,'0')].find(v=>!status.allowedValidators.includes(v));
if (!validator) throw new Error('No disallowed test validator');
const stakePrompt = `Please stake 1 SUI with ${validator}`;
const stakeCommand = await resolveWalletCommand(stakePrompt, AbortSignal.timeout(45000));
const stakeAction = policy.parseWalletCommand(stakeCommand);
if (stakeAction.tool !== 'vault_stake' || stakeAction.args.amount !== '1' || stakeAction.args.validator !== validator) throw new Error('Translator changed staking request');
const stakeTx = new Transaction();stakeTx.setSender(process.env.SUI_ADDRESS);
stakeTx.moveCall({target:`${config.packageId}::spending_vault::stake`,arguments:[stakeTx.object(config.agentCapId),stakeTx.object(config.vaultId),stakeTx.object('0x5'),stakeTx.pure.address(validator),stakeTx.pure.u64(1000000000n)]});
const stakeResult = await client.simulateTransaction({transaction:stakeTx,include:{effects:true}});
const stakeReason = stakeResult.$kind === 'FailedTransaction' ? stakeResult.FailedTransaction.status.error?.message ?? '' : '';
if (!/spending_vault/.test(stakeReason) || !/abort code: 5\b/.test(stakeReason)) throw new Error(`Expected EValidatorNotAllowed (5), got ${stakeReason}`);
report.staking = {prompt:stakePrompt,command:stakeCommand,expectedAbort:'EValidatorNotAllowed (5)',reason:stakeReason};
writeFileSync(new URL('../../docs/nov12-live-evidence.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
console.log('PASS: natural-language payment and staking bypassed client policy and were rejected by Move EOverLimit / EValidatorNotAllowed. No transaction submitted.');
