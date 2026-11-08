// Creates throwaway devnet wallets and a test stablecoin, and writes them to .env. Devnet only.
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction, SystemProgram, sendAndConfirmTransaction } from "@solana/web3.js";
import { createMint, getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import { base58 } from "@scure/base";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
const RPC = process.env.SVM_RPC_URL ?? "https://api.devnet.solana.com";
const conn = new Connection(RPC, "confirmed");
const env: Record<string,string> = {};
if (existsSync(".env")) for (const l of readFileSync(".env","utf8").split("\n")) { const i=l.indexOf("="); if(i>0) env[l.slice(0,i)]=l.slice(i+1); }
const key = (n:string)=>{ if(!env[n]) env[n]=base58.encode(Keypair.generate().secretKey); return Keypair.fromSecretKey(base58.decode(env[n])); };
const fac=key("FACILITATOR_KEY"), auth=key("RECEIVER_AUTHORIZER_KEY"), seller=key("SELLER_KEY"), agent=key("AGENT_KEY"); key("OPERATOR_KEY"); const seller2=key("SELLER2_KEY");
if(!env.ADMIN_TOKEN) env.ADMIN_TOKEN=base58.encode(Keypair.generate().secretKey.slice(0,24));
env.SVM_RPC_URL=RPC; const save=()=>writeFileSync(".env",Object.entries(env).map(([k,v])=>`${k}=${v}`).join("\n")+"\n"); save(); save();
console.log({facilitator:fac.publicKey.toBase58(),seller:seller.publicKey.toBase58(),agent:agent.publicKey.toBase58()});
let bal=await conn.getBalance(fac.publicKey); console.log("facilitator SOL",bal/LAMPORTS_PER_SOL);
if(bal<0.5*LAMPORTS_PER_SOL){ for(const amt of [1,0.5]){ try{ const s=await conn.requestAirdrop(fac.publicKey,amt*LAMPORTS_PER_SOL); await conn.confirmTransaction(s,"confirmed"); break;}catch(e:any){console.log("airdrop failed",amt,String(e.message).slice(0,160));} } bal=await conn.getBalance(fac.publicKey); console.log("after airdrop",bal/LAMPORTS_PER_SOL); }
if(bal<0.05*LAMPORTS_PER_SOL){ console.log("NEED_SOL",fac.publicKey.toBase58()); process.exit(2); }
if(!env.TEST_MINT){ const m=await createMint(conn,fac,fac.publicKey,null,6); env.TEST_MINT=m.toBase58(); save(); console.log("mint",env.TEST_MINT); }
const mint=new PublicKey(env.TEST_MINT);
const ata=await getOrCreateAssociatedTokenAccount(conn,fac,mint,agent.publicKey);
if(Number(ata.amount)<5_000_000){ await mintTo(conn,fac,mint,ata.address,fac,20_000_000); }
await getOrCreateAssociatedTokenAccount(conn,fac,mint,seller.publicKey);
await getOrCreateAssociatedTokenAccount(conn,fac,mint,seller2.publicKey);
console.log("agent tokens",Number((await conn.getTokenAccountBalance(ata.address)).value.amount)/1e6);
