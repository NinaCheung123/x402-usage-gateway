/** Seller dashboard: one self-contained page that polls /api/stats. */
export const dashboardHtml = () => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Usage Gateway</title>
<style>
:root{--bg:#f7f7f5;--surface:#fff;--ink:#1c1c1a;--muted:#6b6b66;--line:#e3e3de;--good:#17693f;--warn:#8a5a00;--bad:#a62b2b;--accent:#4b3fb5}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--surface:#1e1e1c;--ink:#efefea;--muted:#a3a39c;--line:#33332f;--good:#6fce9c;--warn:#e5b45a;--bad:#f09090;--accent:#a99ff0}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,sans-serif}
main{max-width:1120px;margin:0 auto;padding:28px 16px 64px}h1{font-size:24px;margin:0}h2{font-size:15px;margin:32px 0 10px}
header{display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between}
select{font:inherit;color:var(--ink);background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:7px 10px;min-height:38px}
.sub{color:var(--muted);margin:4px 0 0;overflow-wrap:anywhere}.note{color:var(--muted);font-size:13px;margin:8px 0 0}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-top:22px}
.tile{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
.tile .k{color:var(--muted);font-size:13px}.tile .v{font-size:24px;font-weight:600;font-variant-numeric:tabular-nums;margin-top:2px}
.wrap{overflow-x:auto;background:var(--surface);border:1px solid var(--line);border-radius:10px}
table{border-collapse:collapse;width:100%;font-size:13.5px}th,td{padding:9px 12px;text-align:left;border-bottom:1px solid var(--line);white-space:nowrap}
tr:last-child td{border-bottom:0}th{color:var(--muted);font-weight:500}td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}
.s{font-weight:600}.settled,.metered{color:var(--good)}.refunded,.pending,.refund_pending{color:var(--warn)}.rejected,.settle_failed,.needs_review{color:var(--bad)}
a{color:var(--accent)}.empty{color:var(--muted);padding:16px}
</style></head><body><main>
<header><div><h1>Usage Gateway</h1><p class="sub" id="sub"></p></div>
<label>Seller <select id="seller"></select></label></header>
<div class="tiles" id="tiles"></div>
<h2>By model</h2><div class="wrap" id="models"></div>
<h2>By payment method</h2><div class="wrap" id="schemes"></div>
<h2>Batch claims on-chain</h2><div class="wrap" id="claims"></div>
<h2>Recent calls</h2><div class="wrap" id="recent"></div>
<p class="note">Amounts are in test tokens. "Locked" is the most a call could have cost; "Charged" is what it actually cost. "Metered" calls are paid when the seller next claims its batch. Usage is what the model source reported. Updates every 3 seconds.</p>
<p class="note" id="assume"></p>
</main><script>
const t=a=>(Number(a||0)/1e6).toFixed(6);
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const short=s=>s?esc(s.slice(0,4)+"…"+s.slice(-4)):"–";
const txLink=x=>x?'<a target="_blank" rel="noopener" href="https://explorer.solana.com/tx/'+encodeURIComponent(x)+'?cluster=devnet">'+short(x)+'</a>':"–";
const LABEL={settled:"Settled",metered:"Metered",refunded:"Refunded",pending:"Pending",rejected:"Rejected",settle_failed:"Settle failed",refund_pending:"Refund pending",needs_review:"Needs review"};
const SCHEME={"upto":"Per call","batch-settlement":"Batch"};
const pick=document.getElementById("seller");let list=[];
const table=(rows,empty)=>rows.length?'<table><tr><th>Name</th><th class="n">Calls</th><th class="n">Revenue</th><th class="n">Model cost</th><th class="n">Margin after model cost</th></tr>'+rows.map(([k,v])=>'<tr><td>'+esc(SCHEME[k]||k)+'</td><td class="n">'+v.calls+'</td><td class="n">'+t(v.revenue)+'</td><td class="n">'+t(v.cost)+'</td><td class="n">'+t(v.margin)+'</td></tr>').join("")+'</table>':'<div class="empty">'+empty+'</div>';
async function sellers(){
  list=await (await fetch("/api/sellers")).json();
  const cur=pick.value;
  pick.innerHTML='<option value="">All sellers</option>'+list.map(s=>'<option value="'+esc(s.id)+'">'+esc(s.name)+'</option>').join("");
  pick.value=cur;
}
async function load(){
  await sellers();
  const d=await (await fetch("/api/stats?seller="+encodeURIComponent(pick.value))).json();
  const s=list.find(x=>x.id===pick.value);
  document.getElementById("sub").textContent=(s?"Wallet "+s.payTo+" · source: "+s.provider+" · ":"")+"Solana devnet · test token, not USDC";
  const c=d.counts||{};
  const tiles=[["Revenue",t(d.revenueAtomic)],["Model cost",t(d.modelCostAtomic)],["Margin after model cost",t(d.marginAtomic)],["Network fees (estimate)",t(d.network.feesAtomic)],["Margin after model and network (estimate)",t(d.network.marginAfterModelAndNetworkAtomic)],...(d.walletAtomic!=null?[["Wallet on-chain",t(d.walletAtomic)]]:[]),["Metered, not yet claimed",t(d.unclaimedAtomic)],["Paid calls",(c.settled||0)+(c.metered||0)],["Refunded calls",c.refunded||0],["Rejected payments",c.rejected||0],["Unbilled overrun",t(d.unbilledAtomic)]];
  document.getElementById("tiles").innerHTML=tiles.map(([k,v])=>'<div class="tile"><div class="k">'+k+'</div><div class="v">'+v+'</div></div>').join("");
  document.getElementById("models").innerHTML=table(Object.entries(d.byModel||{}),"No paid calls yet.");
  const sch=Object.entries(d.byScheme||{});
  document.getElementById("schemes").innerHTML=sch.length?'<table><tr><th>Name</th><th class="n">Calls</th><th class="n">Revenue</th><th class="n">Model cost</th><th class="n">Transactions</th><th class="n">Network fees (estimate)</th><th class="n">Fees per call (estimate)</th></tr>'+sch.map(([k,v])=>{const n=d.network[k]||{transactions:0,feesAtomic:"0"};return '<tr><td>'+esc(SCHEME[k]||k)+'</td><td class="n">'+v.calls+'</td><td class="n">'+t(v.revenue)+'</td><td class="n">'+t(v.cost)+'</td><td class="n">'+n.transactions+'</td><td class="n">'+t(n.feesAtomic)+'</td><td class="n">'+t(Number(n.feesAtomic)/Math.max(v.calls,1))+'</td></tr>'}).join("")+'</table>':'<div class="empty">No paid calls yet.</div>';
  const a=d.network.assumptions;document.getElementById("assume").textContent="Network fees are an estimate: "+a.lamportsPerTx.toLocaleString()+" lamports per transaction and 1 SOL = "+a.solPriceTokens+" payment tokens. Change these with ASSUMED_LAMPORTS_PER_TX and ASSUMED_SOL_PRICE. Refundable account rent and infrastructure aren't included.";
  const cl=d.claims||[];
  document.getElementById("claims").innerHTML=cl.length?'<table><tr><th>Time</th><th>Wallet</th><th>Step</th><th>Transaction</th></tr>'+cl.map(x=>'<tr><td>'+esc(new Date(x.at).toLocaleTimeString())+'</td><td>'+short(x.payTo)+'</td><td>'+esc(x.kind)+'</td><td>'+txLink(x.tx)+'</td></tr>').join("")+'</table>':'<div class="empty">No batch claims since the gateway started.</div>';
  const r=d.recent||[];
  document.getElementById("recent").innerHTML=r.length?'<table><tr><th>Time</th><th>Status</th><th>Seller</th><th>Method</th><th>Agent</th><th>Model</th><th>Tier</th><th>Period</th><th class="n">AI tokens</th><th class="n">Locked</th><th class="n">Charged</th><th>Transaction</th><th>Reason</th></tr>'+r.map(e=>{
    const u=e.usage||{};const n=(u.inputTokens||0)+(u.cachedInputTokens||0)+(u.outputTokens||0);
    return '<tr><td>'+esc(new Date(e.at).toLocaleTimeString())+'</td><td class="s '+esc(e.status)+'">'+esc(LABEL[e.status]||e.status)+'</td><td>'+esc(e.sellerId||"–")+'</td><td>'+esc(SCHEME[e.scheme]||"–")+'</td><td>'+short(e.payer)+'</td><td>'+esc(e.model||"–")+'</td><td>'+esc(e.tier||"–")+'</td><td>'+esc(e.period||"–")+'</td><td class="n">'+(n||"–")+'</td><td class="n">'+(e.authorizedAtomic?t(e.authorizedAtomic):"–")+'</td><td class="n">'+t(e.chargeAtomic)+'</td><td>'+txLink(e.tx)+'</td><td>'+esc((e.reason||"").slice(0,70))+'</td></tr>';
  }).join("")+'</table>':'<div class="empty">No calls yet.</div>';
}
pick.addEventListener("change",load);load();setInterval(load,3000);
</script></body></html>`;
