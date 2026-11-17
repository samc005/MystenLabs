// Direct contract calls model an attacker controlling AgentCap/signing key.
// They bypass every off-chain policy; all attempts are simulations.
import {createRequire} from 'node:module';
import {writeFileSync} from 'node:fs';
import {createSuiClient} from '../../wallet-mcp/build/blockchain/client.js';
import {getVaultStatus} from '../../wallet-mcp/build/blockchain/vault.js';
import {getDex} from '../../wallet-mcp/build/blockchain/dex.js';
import {vaultConfig,tradingConfig} from '../../wallet-mcp/build/config.js';
const require=createRequire(new URL('../../wallet-mcp/package.json',import.meta.url));
const {Transaction}=require('@mysten/sui/transactions');
const client=createSuiClient('testnet'),config=vaultConfig(),status=await getVaultStatus(client,config);
if(!status.agentSecurityPolicy || ['payments','staking','trading'].some(k=>status.agentSecurityPolicy[k]!==false)) throw new Error('Expected owner-installed deny-all agent policy');
const cases=[];
async function rejected(name,build,code=33) {
 const tx=new Transaction();tx.setSender(process.env.SUI_ADDRESS);build(tx);
 const result=await client.simulateTransaction({transaction:tx,include:{effects:true}});
 const reason=result.$kind==='FailedTransaction'?result.FailedTransaction.status.error?.message??'':'';
 if(!reason.includes('spending_vault')||!reason.includes(`abort code: ${code},`)) throw new Error(`${name}: wrong failure ${reason||result.$kind}`);
 cases.push({name,passed:true,expectedAbort:code,reason});
}
const to=process.env.SUI_ADDRESS;
function spend(tx,packageId=config.packageId,clock=true) {tx.moveCall({target:`${packageId}::spending_vault::${clock?'spend_with_clock':'spend'}`,arguments:[tx.object(config.agentCapId),tx.object(config.vaultId),tx.pure.address(to),tx.pure.u64(1n),...(clock?[tx.object.clock()]:[])]});}
await rejected('rogue agent direct payment',tx=>spend(tx));
await rejected('rogue agent owner-approved payment path',tx=>tx.moveCall({target:`${config.packageId}::spending_vault::spend_approved`,arguments:[tx.object(config.agentCapId),tx.object(config.vaultId),tx.pure.id(config.vaultId),tx.object.clock()]}));
await rejected('rogue agent staking',tx=>tx.moveCall({target:`${config.packageId}::spending_vault::stake`,arguments:[tx.object(config.agentCapId),tx.object(config.vaultId),tx.object('0x5'),tx.pure.address(status.allowedValidators[0]??to),tx.pure.u64(1000000000n)]}));
const types=['0x2::sui::SUI',tradingConfig().usdcType];
if(!types[1]) throw new Error('Missing configured test token for trading checks');
function swap(tx,automatic) {
 const [coin,ticket]=tx.moveCall({target:`${config.packageId}::spending_vault::${automatic?'begin_swap_auto':'begin_swap'}`,typeArguments:types,arguments:[tx.object(config.agentCapId),tx.object(config.vaultId),...(automatic?[tx.pure.u64(1n),tx.pure.u64(1n)]:[tx.pure.id(config.vaultId)]),tx.object.clock()]});
 const output=getDex().addSwap(tx,coin,types[0],types[1]);
 tx.moveCall({target:`${config.packageId}::spending_vault::finish_swap`,typeArguments:types,arguments:[ticket,tx.object(config.vaultId),output]});
}
await rejected('rogue agent standing-rule swap',tx=>swap(tx,true));
await rejected('rogue agent owner-intent swap path',tx=>swap(tx,false));
await rejected('original package bypass',tx=>spend(tx,'0xfd1b7414378196394b9a62d3c04a89205c876a78a34cef8e2640fcc4dcb4c63c',false),1);
await rejected('version-two package bypass',tx=>spend(tx,'0x52119e23e7bbf9e6c3e584686f9f682b9cc46c18cb722a22c33ddb2049d02c8f'),1);
writeFileSync(new URL('../../docs/agent-security-evidence.json',import.meta.url),JSON.stringify({checkedAt:new Date().toISOString(),network:'testnet',packageId:config.packageId,vaultId:config.vaultId,policy:status.agentSecurityPolicy,submitted:false,cases},null,2)+'\n');
console.log(`${cases.length} direct rogue-agent simulations rejected by Move. No transactions submitted.`);
