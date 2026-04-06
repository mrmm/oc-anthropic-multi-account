import { loadData } from "./data.js";

// ============================================================================
// Sketchybar bar output (key=value, easily parsed by Lua)
// ============================================================================

export function cmdBar() {
  const data = loadData();
  const usage = data.usage || {};
  const accounts = data.accounts || [];
  const current = data.currentAccount || "";

  // Build scored list: lower score = better candidate
  // Rejected sessions get a high penalty, then sort by max utilization
  let best: any = null;
  let bestScore = Infinity;

  for (const acct of accounts) {
    const name = acct.name;
    const u = usage[name] || {};
    const s5h = u.session5h || {};
    const w7d = u.weekly7d || {};

    const pctS = Math.round((s5h.utilization || 0) * 100);
    const pctW = Math.round((w7d.utilization || 0) * 100);
    const statusS = s5h.status || "unknown";
    const statusW = w7d.status || "unknown";
    const resetS = s5h.reset || 0;

    const rejected = statusS === "rejected" || statusW === "rejected";
    const score = (rejected ? 1000 : 0) + Math.max(pctS, pctW);

    // Among ties, prefer current account (score - 0.5)
    const tiebreak = name === current ? score - 0.5 : score;

    if (tiebreak < bestScore) {
      bestScore = tiebreak;
      best = { name, pctS, pctW, resetS, rejected };
    }
  }

  if (!best) {
    console.log("name=none\ns5h=0\nw7d=0\nreset=0\ncolor=grey");
    return;
  }

  // Compute countdown for session reset
  let countdown = "";
  if (best.pctS > 0 && best.resetS) {
    const remain = best.resetS - Math.floor(Date.now() / 1000);
    if (remain > 0) {
      const hrs = Math.floor(remain / 3600);
      const mins = Math.floor((remain % 3600) / 60);
      const secs = remain % 60;
      countdown = `${hrs}h${String(mins).padStart(2, "0")}m${String(secs).padStart(2, "0")}s`;
    }
  }

  // Color: red if weekly rejected, otherwise based on session (5h) usage
  let color: string;
  if (best.rejected) {
    color = "red";
  } else if (best.pctS >= 80) {
    color = "red";
  } else if (best.pctS >= 50) {
    color = "orange";
  } else if (best.pctS > 0) {
    color = "yellow";
  } else {
    color = "green";
  }

  console.log(`name=${best.name}`);
  console.log(`s5h=${best.pctS}`);
  console.log(`w7d=${best.pctW}`);
  console.log(`reset=${countdown}`);
  console.log(`color=${color}`);
}

// ============================================================================
// Sketchybar bar-detail output (all accounts, key=value per account)
// ============================================================================

export function cmdBarDetail() {
  const data = loadData();
  const usage = data.usage || {};
  const accounts = data.accounts || [];
  const current = data.currentAccount || "";
  const now = Math.floor(Date.now() / 1000);

  function colorFor(pctS: number, pctW: number): string {
    const hi = Math.max(pctW, pctS);
    if (hi >= 80) return "red";
    if (hi >= 50) return "orange";
    if (hi > 0) return "yellow";
    return "green";
  }

  function countdown(resetTs: number): string {
    if (!resetTs) return "";
    const remain = resetTs - now;
    if (remain <= 0) return "";
    const days = Math.floor(remain / 86400);
    const hrs = Math.floor((remain % 86400) / 3600);
    const mins = Math.floor((remain % 3600) / 60);
    const secs = remain % 60;
    if (days > 0) {
      return `${days}d ${hrs}h${String(mins).padStart(2, "0")}m`;
    }
    return `${hrs}h${String(mins).padStart(2, "0")}m${String(secs).padStart(2, "0")}s`;
  }

  const switchMode = data.config?.switchMode || "auto";
  console.log(`count=${accounts.length}`);
  console.log(`current=${current}`);
  console.log(`switchMode=${switchMode}`);

  for (let i = 0; i < accounts.length; i++) {
    const acct = accounts[i];
    const name = acct.name;
    const u = usage[name] || {};
    const s5h = u.session5h || {};
    const w7d = u.weekly7d || {};
    const snt = u.weekly7dSonnet || {};

    const pctS = Math.round((s5h.utilization || 0) * 100);
    const pctW = Math.round((w7d.utilization || 0) * 100);
    const pctSnt = Math.round((snt.utilization || 0) * 100);
    const statusS = s5h.status || "unknown";
    const statusW = w7d.status || "unknown";
    const resetS = countdown(s5h.reset || 0);
    const resetW = countdown(w7d.reset || 0);
    const active = name === current;
    const role = i === 0 ? "primary" : "fallback";
    const color = colorFor(pctS, pctW);

    console.log(`${i}.name=${name}`);
    console.log(`${i}.role=${role}`);
    console.log(`${i}.active=${active}`);
    console.log(`${i}.s5h=${pctS}`);
    console.log(`${i}.s5h_status=${statusS}`);
    console.log(`${i}.s5h_reset=${resetS}`);
    console.log(`${i}.w7d=${pctW}`);
    console.log(`${i}.w7d_status=${statusW}`);
    console.log(`${i}.w7d_reset=${resetW}`);
    console.log(`${i}.sonnet=${pctSnt}`);
    console.log(`${i}.color=${color}`);
    console.log(`${i}.email=${acct.email || ""}`);
    console.log(`${i}.org=${acct.org || ""}`);
    const planType =
      typeof acct.plan === "object" ? acct.plan?.type : acct.plan || "";
    console.log(`${i}.plan=${planType}`);
  }
}
