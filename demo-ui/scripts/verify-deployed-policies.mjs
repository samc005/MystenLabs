// All attempted payments are simulated. No keys or signer are loaded.
import {createRequire} from 'node:module';
import {writeFileSync} from 'node:fs';
import {createSuiClient} from '../../wallet-mcp/build/blockchain/client.js';
import {getVaultStatus} from '../../wallet-mcp/build/blockchain/vault.js';
import {vaultConfig} from '../../wallet-mcp/build/config.js';
const require=createRequire(new URL('../../wallet-mcp/package.json',import.meta.url));
const {Transaction}=require('@mysten/sui/transactions');
const config=vaultConfig(),client=createSuiClient('testnet'),status=await getVaultStatus(client,config);
const blocked='0x'+'1'.padStart(64,'0');
const recipient=status.allowedRecipients[0] ?? process.env.SUI_ADDRESS;
const cases=[];
async function check(name,build,code=null) {
 const tx=new Transaction();tx.setSender(process.env.SUI_ADDRESS);build(tx);
 const result=await client.simulateTransaction({transaction:tx,include:{effects:true}});
 const reason=result.$kind==='FailedTransaction'?result.FailedTransaction.status.error?.message??'':'';
 const ok=code===null?result.$kind==='Transaction':result.$kind==='FailedTransaction'&&reason.includes('spending_vault')&&reason.includes(`abort code: ${code},`);
 cases.push({name,passed:ok,expected:code===null?'success':`Move abort ${code}`,reason});
 if(!ok)throw new Error(`${name}: unexpected result ${reason||result.$kind}`);
}
function spend(tx,amount,to=recipient,fn='spend_with_clock',packageId=config.packageId) {
 tx.moveCall({target:`${packageId}::spending_vault::${fn}`,arguments:[tx.object(config.agentCapId),tx.object(config.vaultId),tx.pure.address(to),tx.pure.u64(amount),...(fn==='spend_with_clock'?[tx.object.clock()]:[])]});
}
const weekly=process.argv.includes('--weekly');
if(weekly) {
 await check('split payments cannot exceed weekly cap',tx=>{spend(tx,50000000n);spend(tx,40000000n);},32);
} else {
 await check('current clock-aware payment inside policy',tx=>spend(tx,1000000n));
 await check('blacklist rejects clock-aware payment',tx=>spend(tx,1n,blocked),29);
 await check('current legacy payment requires the clock',tx=>spend(tx,1n,blocked,'spend'),30);
 await check('old deployed package cannot bypass migration',tx=>spend(tx,1n,recipient,'spend','0xfd1b7414378196394b9a62d3c04a89205c876a78a34cef8e2640fcc4dcb4c63c'),1);
 await check('split payments cannot exceed daily cap',tx=>{spend(tx,60000000n);spend(tx,60000000n);},31);
}
const filename=weekly?'nov12-weekly-evidence.json':'nov12-deployed-evidence.json';
writeFileSync(new URL('../../docs/'+filename,import.meta.url),JSON.stringify({checkedAt:new Date().toISOString(),network:'testnet',packageId:config.packageId,vaultId:config.vaultId,submitted:false,calendarPolicy:status.calendarPolicy,cases},null,2)+'\n');
console.log(`${cases.length} deployed-policy simulations passed; no payments submitted.`);
