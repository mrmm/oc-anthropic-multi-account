import * as clack from "@clack/prompts";
import { DEFAULTS, EMPTY_DATA } from "./constants.js";
import { loadData, saveData } from "./data.js";
import {
  normalizeThresholds,
  allSame,
  getAccountThresholds,
} from "./thresholds.js";
import { autoEvaluate } from "./auto-evaluate.js";
import {
  success,
  error,
  warning,
  info,
  plain,
  header,
  kv,
  availableAccounts,
} from "./ui-utils.js";

export function cmdConfig(args: string[]) {
  const data = loadData();

  const parseArg = (flag: string) => {
    const idx = args.indexOf(flag);
    return idx !== -1 ? args[idx + 1] : null;
  };

  const accountName = parseArg("--account");

  const PLAN_PRICES: Record<string, number> = {
    pro: 20,
    team: 30,
    max5x: 100,
    max20x: 200,
  };

  // Per-account config mode
  if (accountName) {
    const accounts = data.accounts || [];
    const account = accounts.find((a: any) => a.name === accountName);
    if (!account) {
      const available = accounts.map((a: any) => a.name).join(", ");
      error(`Account '${accountName}' not found`);
      availableAccounts(accounts.map((a: any) => a.name));
      console.log();
      return;
    }

    data.config = data.config || {};
    data.config.accounts = data.config.accounts || {};

    // Handle --plan, --email, --org flags (can be combined in one call)
    let accountChanged = false;

    const planArg = parseArg("--plan");
    if (planArg) {
      const validPlans = ["pro", "team", "max5x", "max20x"];
      if (!validPlans.includes(planArg)) {
        error(`Invalid plan: '${planArg}'`);
        info(`Valid plans: ${validPlans.join(", ")}`, 2);
        console.log();
        return;
      }
      account.plan = { type: planArg, price: PLAN_PRICES[planArg] };
      success(
        `Plan set for '${accountName}': ${planArg} ($$${PLAN_PRICES[planArg]}/month)`,
      );
      accountChanged = true;
    }

    const emailArg = parseArg("--email");
    if (emailArg) {
      account.email = emailArg;
      success(`Email set for '${accountName}': ${emailArg}`);
      accountChanged = true;
    }

    const orgArg = parseArg("--org");
    if (orgArg) {
      account.org = orgArg;
      success(`Organization set for '${accountName}': ${orgArg}`);
      accountChanged = true;
    }

    if (accountChanged) {
      saveData(data);
      console.log();
      return;
    }

    // Handle --extra-credit flag
    const extraCreditArg = parseArg("--extra-credit");
    if (extraCreditArg) {
      const validModes = ["on", "off", "auto"];
      if (!validModes.includes(extraCreditArg)) {
        error(`Invalid extra-credit mode: '${extraCreditArg}'`);
        info(`Valid modes: ${validModes.join(", ")}`, 2);
        console.log();
        return;
      }
      data.config.accounts[accountName] =
        data.config.accounts[accountName] || {};
      data.config.accounts[accountName].extraCredit = extraCreditArg;
      saveData(data);
      console.log();
      success(`Extra credit handling for '${accountName}': ${extraCreditArg}`);
      console.log();
      return;
    }

    // Show per-account config
    const hasThresholdArg =
      args.includes("--threshold") ||
      args.includes("--thresholds") ||
      args.includes("--threshold-session") ||
      args.includes("--threshold-weekly") ||
      args.includes("--threshold-sonnet");

    if (!hasThresholdArg && !args.includes("--reset")) {
      const t = getAccountThresholds(accountName, data.config);
      const globalT = normalizeThresholds(
        data.config.threshold,
        DEFAULTS.threshold,
      );
      const hasOverride = !!data.config.accounts[accountName]?.threshold;

      header(`Configuration for account: ${accountName}`);

      if (account.email) kv("Email:", account.email);
      if (account.org) kv("Organization:", account.org);
      if (account.plan) {
        const planType =
          typeof account.plan === "object" ? account.plan.type : account.plan;
        const planPrice =
          typeof account.plan === "object"
            ? account.plan.price
            : PLAN_PRICES[account.plan];
        kv("Plan:", `${planType} ($$${planPrice || "?"}/month)`);
      }
      const ecMode = data.config.accounts[accountName]?.extraCredit || "auto";
      kv("Extra credit:", ecMode);
      if (account.email || account.org || account.plan) console.log();

      if (hasOverride) {
        plain("    Thresholds (per-account override):");
      } else {
        plain("    Thresholds (using global defaults):");
      }
      plain(`      Session (5h):    ${Math.round(t.session5h * 100)}%`);
      plain(`      Weekly (all):    ${Math.round(t.weekly7d * 100)}%`);
      plain(`      Weekly (Sonnet): ${Math.round(t.weekly7dSonnet * 100)}%`);
      if (hasOverride) {
        const gStr = allSame(globalT)
          ? `${Math.round(globalT.session5h * 100)}%`
          : `${Math.round(globalT.session5h * 100)}/${Math.round(globalT.weekly7d * 100)}/${Math.round(globalT.weekly7dSonnet * 100)}%`;
        console.log();
        kv("Global fallback:", gStr);
      }
      console.log();
      info(
        `Run: bun src/cli.ts config --account ${accountName} --threshold 0.80`,
      );
      console.log();
      return;
    }

    // Reset per-account config
    if (args.includes("--reset")) {
      delete data.config.accounts[accountName];
      if (Object.keys(data.config.accounts).length === 0) {
        delete data.config.accounts;
      }
      saveData(data);
      console.log();
      success(
        `Per-account config for '${accountName}' removed (using global defaults)`,
      );
      console.log();
      return;
    }

    // Set per-account thresholds
    data.config.accounts[accountName] = data.config.accounts[accountName] || {};
    let changed = false;

    const t = parseArg("--threshold");
    if (t) {
      const val = parseFloat(t);
      if (isNaN(val) || val < 0 || val > 1) {
        error("Invalid threshold value. Must be between 0 and 1");
        console.log();
        return;
      }
      data.config.accounts[accountName].threshold = val;
      changed = true;
    }

    const ta = parseArg("--thresholds");
    if (ta) {
      const parts = ta.split(",").map(Number);
      if (parts.length !== 3 || parts.some(isNaN)) {
        error(
          "Invalid --thresholds format. Expected: <session>,<weekly>,<sonnet>",
        );
        console.log();
        return;
      }
      data.config.accounts[accountName].threshold = {
        session5h: parts[0] / 100,
        weekly7d: parts[1] / 100,
        weekly7dSonnet: parts[2] / 100,
      };
      changed = true;
    }

    const ts = parseArg("--threshold-session");
    if (ts) {
      const current = data.config.accounts[accountName].threshold;
      const resolved = getAccountThresholds(accountName, data.config);
      if (typeof current !== "object" || current === null) {
        data.config.accounts[accountName].threshold = { ...resolved };
      }
      data.config.accounts[accountName].threshold.session5h = parseFloat(ts);
      changed = true;
    }

    const tw = parseArg("--threshold-weekly");
    if (tw) {
      const current = data.config.accounts[accountName].threshold;
      const resolved = getAccountThresholds(accountName, data.config);
      if (typeof current !== "object" || current === null) {
        data.config.accounts[accountName].threshold = { ...resolved };
      }
      data.config.accounts[accountName].threshold.weekly7d = parseFloat(tw);
      changed = true;
    }

    const tso = parseArg("--threshold-sonnet");
    if (tso) {
      const current = data.config.accounts[accountName].threshold;
      const resolved = getAccountThresholds(accountName, data.config);
      if (typeof current !== "object" || current === null) {
        data.config.accounts[accountName].threshold = { ...resolved };
      }
      data.config.accounts[accountName].threshold.weekly7dSonnet =
        parseFloat(tso);
      changed = true;
    }

    if (changed) {
      autoEvaluate(data);
      saveData(data);
      console.log();
      success(`Per-account config for '${accountName}' saved`);
      cmdConfig(["--account", accountName]);
    }
    return;
  }

  // Global config mode (original behavior)
  if (args.includes("--show") || args.length === 0) {
    const cfg = data.config || {};
    const t = normalizeThresholds(cfg.threshold, DEFAULTS.threshold);

    header("Current Configuration");
    if (allSame(t)) {
      kv("Threshold:", `${Math.round(t.session5h * 100)}%`);
    } else {
      plain("    Thresholds:");
      plain(`      Session (5h):    ${Math.round(t.session5h * 100)}%`);
      plain(`      Weekly (all):    ${Math.round(t.weekly7d * 100)}%`);
      plain(`      Weekly (Sonnet): ${Math.round(t.weekly7dSonnet * 100)}%`);
    }
    kv(
      "Check interval:",
      `${(cfg.checkInterval ?? DEFAULTS.checkInterval) / 60000} min`,
    );
    kv("Switch mode:", cfg.switchMode || "auto");

    const accountOverrides = cfg.accounts;
    if (accountOverrides && Object.keys(accountOverrides).length > 0) {
      console.log();
      plain("    Per-account overrides:");
      for (const [name, acctCfg] of Object.entries(accountOverrides) as [
        string,
        any,
      ][]) {
        if (acctCfg?.threshold) {
          const at = getAccountThresholds(name, cfg);
          if (allSame(at)) {
            plain(`      ${name}: ${Math.round(at.session5h * 100)}%`);
          } else {
            plain(
              `      ${name}: ${Math.round(at.session5h * 100)}/${Math.round(at.weekly7d * 100)}/${Math.round(at.weekly7dSonnet * 100)}%`,
            );
          }
        }
      }
    }

    console.log();
    info("Run: bun src/cli.ts config --threshold 0.80    Change thresholds");
    console.log();
    return;
  }

  if (args.includes("--reset")) {
    data.config = structuredClone(EMPTY_DATA.config);
    saveData(data);
    console.log();
    success("Configuration reset to defaults");
    console.log(
      `     Threshold: ${Math.round(DEFAULTS.threshold * 100)}%  |  Check interval: ${DEFAULTS.checkInterval / 60000} min`,
    );
    console.log();
    return;
  }

  data.config = data.config || {};
  let changed = false;

  function ensureThresholdObject() {
    const current = data.config.threshold;
    if (typeof current === "number") {
      data.config.threshold = {
        session5h: current,
        weekly7d: current,
        weekly7dSonnet: current,
      };
    } else if (!current || typeof current !== "object") {
      data.config.threshold = {
        session5h: DEFAULTS.threshold,
        weekly7d: DEFAULTS.threshold,
        weekly7dSonnet: DEFAULTS.threshold,
      };
    }
  }

  const t = parseArg("--threshold");
  if (t) {
    const val = parseFloat(t);
    if (isNaN(val) || val < 0 || val > 1) {
      error(
        "Invalid threshold value. Must be between 0 and 1 (e.g., 0.80 for 80%)",
      );
      info("Run: bun src/cli.ts config --threshold 0.80", 2);
      console.log();
      return;
    }
    if (val < 0.5) {
      warning("Threshold below 50% may cause frequent account switching");
    }
    if (val > 0.95) {
      warning("Threshold above 95% increases risk of hitting rate limits");
    }
    data.config.threshold = val;
    changed = true;
  }

  // --thresholds 95,80,90 → session=95%, weekly=80%, sonnet=90%
  const ta = parseArg("--thresholds");
  if (ta) {
    const parts = ta.split(",").map(Number);
    if (parts.length !== 3 || parts.some(isNaN)) {
      error(
        "Invalid --thresholds format. Expected: <session>,<weekly>,<sonnet>",
      );
      info("Run: bun src/cli.ts config --thresholds 95,80,90", 2);
      console.log();
      return;
    }
    data.config.threshold = {
      session5h: parts[0] / 100,
      weekly7d: parts[1] / 100,
      weekly7dSonnet: parts[2] / 100,
    };
    changed = true;
  }

  const ts = parseArg("--threshold-session");
  if (ts) {
    ensureThresholdObject();
    data.config.threshold.session5h = parseFloat(ts);
    changed = true;
  }

  const tw = parseArg("--threshold-weekly");
  if (tw) {
    ensureThresholdObject();
    data.config.threshold.weekly7d = parseFloat(tw);
    changed = true;
  }

  const tso = parseArg("--threshold-sonnet");
  if (tso) {
    ensureThresholdObject();
    data.config.threshold.weekly7dSonnet = parseFloat(tso);
    changed = true;
  }

  const i = parseArg("--interval");
  if (i) {
    data.config.checkInterval = parseInt(i) * 60000;
    changed = true;
  }

  // Switch mode: auto or manual
  const sm = parseArg("--switch-mode");
  if (sm) {
    if (sm !== "auto" && sm !== "manual") {
      error("--switch-mode must be 'auto' or 'manual'");
      console.log();
      return;
    }
    data.config.switchMode = sm;
    changed = true;
  }

  // Clean up legacy recover config
  delete data.config.recover;

  if (changed) {
    autoEvaluate(data);
    saveData(data);
    console.log();
    success("Configuration saved");
    cmdConfig(["--show"]);
  }
}

// ============================================================================
// config-interactive command
// ============================================================================

export async function cmdConfigInteractive() {
  const data = loadData();
  data.config = data.config || {};

  const cur = normalizeThresholds(data.config.threshold, DEFAULTS.threshold);
  const curInterval =
    (data.config.checkInterval || DEFAULTS.checkInterval) / 60000;
  const curMode = data.config.switchMode || "auto";

  clack.intro("Configuration Wizard");

  clack.note(
    `Session (5h):    ${Math.round(cur.session5h * 100)}%\n` +
      `Weekly (all):    ${Math.round(cur.weekly7d * 100)}%\n` +
      `Weekly (Sonnet): ${Math.round(cur.weekly7dSonnet * 100)}%\n` +
      `Check interval:  ${curInterval} min\n` +
      `Switch mode:     ${curMode}`,
    "Current Settings",
  );

  const session = await clack.text({
    message: "Session (5h) threshold %",
    placeholder: String(Math.round(cur.session5h * 100)),
    defaultValue: String(Math.round(cur.session5h * 100)),
  });
  if (clack.isCancel(session)) {
    clack.cancel("Cancelled");
    return;
  }

  const weekly = await clack.text({
    message: "Weekly (all) threshold %",
    placeholder: String(Math.round(cur.weekly7d * 100)),
    defaultValue: String(Math.round(cur.weekly7d * 100)),
  });
  if (clack.isCancel(weekly)) {
    clack.cancel("Cancelled");
    return;
  }

  const sonnet = await clack.text({
    message: "Weekly (Sonnet) threshold %",
    placeholder: String(Math.round(cur.weekly7dSonnet * 100)),
    defaultValue: String(Math.round(cur.weekly7dSonnet * 100)),
  });
  if (clack.isCancel(sonnet)) {
    clack.cancel("Cancelled");
    return;
  }

  const interval = await clack.text({
    message: "Check interval (minutes)",
    placeholder: String(curInterval),
    defaultValue: String(curInterval),
  });
  if (clack.isCancel(interval)) {
    clack.cancel("Cancelled");
    return;
  }

  const mode = await clack.select({
    message: "Switch mode",
    options: [
      {
        value: "auto",
        label: "Auto",
        hint: "switch accounts based on thresholds",
      },
      { value: "manual", label: "Manual", hint: "only switch manually" },
    ],
    initialValue: curMode,
  });
  if (clack.isCancel(mode)) {
    clack.cancel("Cancelled");
    return;
  }

  const sessionVal = session
    ? parseFloat(session as string) / 100
    : cur.session5h;
  const weeklyVal = weekly ? parseFloat(weekly as string) / 100 : cur.weekly7d;
  const sonnetVal = sonnet
    ? parseFloat(sonnet as string) / 100
    : cur.weekly7dSonnet;
  const intervalVal = interval
    ? parseInt(interval as string) * 60000
    : data.config.checkInterval || DEFAULTS.checkInterval;

  clack.note(
    `Session (5h):    ${Math.round(sessionVal * 100)}%\n` +
      `Weekly (all):    ${Math.round(weeklyVal * 100)}%\n` +
      `Weekly (Sonnet): ${Math.round(sonnetVal * 100)}%\n` +
      `Check interval:  ${intervalVal / 60000} min\n` +
      `Switch mode:     ${mode}`,
    "Preview",
  );

  const ok = await clack.confirm({ message: "Apply these settings?" });
  if (clack.isCancel(ok) || !ok) {
    clack.cancel("Configuration cancelled");
    return;
  }

  data.config.threshold = {
    session5h: sessionVal,
    weekly7d: weeklyVal,
    weekly7dSonnet: sonnetVal,
  };
  data.config.checkInterval = intervalVal;
  data.config.switchMode = mode as string;
  autoEvaluate(data);
  saveData(data);

  clack.outro("Configuration saved");
}
