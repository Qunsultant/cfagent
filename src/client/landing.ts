import { generatedThemeTokens } from "./designTokens";
import { BRAND } from "./branding";
import { TAPE_SYMBOLS } from "./quotes/symbolSets";
import { resolvePollingConfig, type PollingConfig } from "./pollingConfig";

export function renderLandingPage(appName?: string, polling?: Partial<PollingConfig>): string {
  const name = appName || BRAND.name;
  const darkTokens = Object.entries(generatedThemeTokens.dark)
    .map(([k, v]) => `  ${k}: ${v};`)
    .join("\n");
  const lightTokens = Object.entries(generatedThemeTokens.light)
    .map(([k, v]) => `  ${k}: ${v};`)
    .join("\n");
  const hcTokens = Object.entries(generatedThemeTokens["high-contrast"])
    .map(([k, v]) => `  ${k}: ${v};`)
    .join("\n");

  // One canonical tape (#2312): the landing tape and the in-app tape
  // default are the same TAPE_SYMBOLS list, rendered here at page
  // generation time. The updater script below subscribes to the same
  // TickerAgent feed with these symbols; the static items are only the
  // pre-tick baseline, never a second list to drift.
  const tapeLabel = (t: { symbol: string; name?: string }) => t.name ?? t.symbol;
  // Static baselines, verbatim from the previous hardcoded items, for
  // the 8 symbols the landing tape already carried: the landing
  // contract is never-blank, never a dash, before the first live tick.
  // The 5 symbols new to the landing tape show "—" until that tick —
  // no baseline is invented for them.
  const tapeBaseline: Record<string, { val: string; chg: string; cls: string }> = {
    SPY: { val: "5,864.67", chg: "+0.42%", cls: "gain" },
    QQQ: { val: "18,518.61", chg: "+0.63%", cls: "gain" },
    DIA: { val: "42,114.40", chg: "-0.61%", cls: "loss" },
    IWM: { val: "2,213.78", chg: "+0.15%", cls: "gain" },
    "^VIX": { val: "18.24", chg: "-4.10%", cls: "loss" },
    "^TNX": { val: "4.24%", chg: "+0.03", cls: "gain" },
    "BTC/USD": { val: "68,450.00", chg: "+2.15%", cls: "gain" },
    "ETH/USD": { val: "2,540.00", chg: "+1.80%", cls: "gain" },
  };
  const tapeItem = (t: { symbol: string; name?: string }) => {
    const label = tapeLabel(t).replace(/&/g, "&amp;");
    const base = tapeBaseline[t.symbol] ?? { val: "—", chg: "—", cls: "" };
    return `<div class="ticker-item"><span class="ticker-sym">${label}</span><span class="ticker-val">${base.val}</span><span class="ticker-chg ${base.cls}">${base.chg}</span></div>`;
  };
  // Both marquee halves are generated from the same list: the slide
  // animation translates -50%, so a seamless loop needs two identical
  // halves (the previous template repeated only the first 4 items,
  // which jumped every 45s).
  const tapeItemsHtml = TAPE_SYMBOLS.map(tapeItem).join("\n      ");
  const tapeMapLiteral = `{\n${TAPE_SYMBOLS.map((t) => `        ${JSON.stringify(tapeLabel(t))}: ${JSON.stringify(t.symbol)}`).join(",\n")}\n      }`;
  // Issue #2419: the tape's polling treatment resolves through the
  // externalized polling config (same interpolation idiom as the tape
  // map above). The widget script below reads POLLING_CFG directly;
  // the literal is always emitted, so no fallback literal lives in
  // the script itself.
  const pollingConfigLiteral = JSON.stringify(resolvePollingConfig(polling));

  return `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${name} — Institutional Autonomous Trading &amp; Deterministic Risk Gates</title>
  <meta name="description" content="Deploy self-driving trading strategies across US equities, index options, and futures. Guaranteed pre-trade risk policy enforcement and W3C Agent DID audit ledgers.">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    :root {
      --font-sans: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      --font-mono: 'JetBrains Mono', ui-monospace, SFMono-Regular, monospace;
      --radius-sm: 0.375rem;
      --radius-md: 0.5rem;
      --radius-lg: 0.75rem;
      --radius-xl: 1rem;
      --radius-2xl: 1.25rem;
      --radius-full: 9999px;
      --transition-normal: 180ms cubic-bezier(0.4, 0, 0.2, 1);
      --transition-slow: 280ms cubic-bezier(0.4, 0, 0.2, 1);
      --backdrop-blur-md: blur(12px);
      --backdrop-blur-lg: blur(20px);
    }
    :root, [data-theme="dark"] {
${darkTokens}
    }
    [data-theme="light"] {
${lightTokens}
    }
    [data-theme="high-contrast"] {
${hcTokens}
    }

    * { margin: 0; padding: 0; box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body {
      font-family: var(--font-sans);
      background-color: var(--color-surface);
      color: var(--color-text-primary);
      line-height: 1.5;
      -webkit-font-smoothing: antialiased;
      overflow-x: hidden;
    }

    /* Grid overlay background */
    .bg-grid-pattern {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 980px;
      background-image: 
        linear-gradient(to right, var(--color-border-subtle) 1px, transparent 1px),
        linear-gradient(to bottom, var(--color-border-subtle) 1px, transparent 1px);
      background-size: 56px 56px;
      mask-image: radial-gradient(ellipse 70% 60% at 50% 0%, var(--color-surface) 30%, transparent 80%);
      -webkit-mask-image: radial-gradient(ellipse 70% 60% at 50% 0%, var(--color-surface) 30%, transparent 80%);
      pointer-events: none;
      z-index: 0;
      opacity: 0.55;
    }

    .spotlight-radial {
      position: absolute;
      top: -200px;
      left: 50%;
      transform: translateX(-50%);
      width: 900px;
      height: 600px;
      background: radial-gradient(circle, var(--color-accent-subtle) 0%, transparent 70%);
      pointer-events: none;
      z-index: 0;
      opacity: 0.6;
    }

    /* Top Announcement Bar */
    .announcement-bar {
      position: relative;
      z-index: 20;
      background: var(--color-surface-sunken);
      border-bottom: 1px solid var(--color-border-subtle);
      padding: 0.5rem 1rem;
      text-align: center;
      font-size: 0.8125rem;
      color: var(--color-text-secondary);
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 0.5rem;
    }
    .announcement-pill {
      background: var(--color-accent-subtle);
      border: 1px solid var(--color-accent-border);
      color: var(--color-accent);
      padding: 0.15rem 0.5rem;
      border-radius: var(--radius-full);
      font-weight: 600;
      font-size: 0.725rem;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    .announcement-link {
      color: var(--color-accent);
      text-decoration: none;
      font-weight: 500;
      display: inline-flex;
      align-items: center;
      gap: 0.25rem;
    }
    .announcement-link:hover { text-decoration: underline; }

    /* Main Navigation */
    .main-nav {
      position: sticky;
      top: 0;
      z-index: 50;
      backdrop-filter: var(--backdrop-blur-lg);
      -webkit-backdrop-filter: var(--backdrop-blur-lg);
      background: var(--color-surface-glass);
      border-bottom: 1px solid var(--color-surface-glass-border);
      transition: background var(--transition-normal);
    }
    .nav-container {
      max-width: 1280px;
      margin: 0 auto;
      padding: 0.85rem 1.5rem;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 1rem;
    }
    .brand-wrap {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      text-decoration: none;
      color: var(--color-text-primary);
    }
    .brand-logo-icon {
      width: 32px;
      height: 32px;
      border-radius: var(--radius-md);
      background: linear-gradient(135deg, var(--color-accent) 0%, var(--color-accent-contrast) 100%);
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 0 16px var(--color-accent-subtle);
    }
    .brand-name {
      font-size: 1.15rem;
      font-weight: 700;
      letter-spacing: -0.02em;
      display: flex;
      align-items: center;
      gap: 0.4rem;
    }
    .brand-badge {
      font-size: 0.65rem;
      font-weight: 700;
      padding: 0.1rem 0.35rem;
      background: var(--color-surface-raised);
      border: 1px solid var(--color-border-subtle);
      color: var(--color-text-muted);
      border-radius: var(--radius-sm);
      letter-spacing: 0.05em;
    }
    .nav-links {
      display: flex;
      align-items: center;
      gap: 1.5rem;
      list-style: none;
    }
    .nav-links a {
      color: var(--color-text-secondary);
      text-decoration: none;
      font-size: 0.875rem;
      font-weight: 500;
      transition: color var(--transition-normal);
    }
    .nav-links a:hover { color: var(--color-text-primary); }

    .nav-actions {
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }
    .search-trigger-btn {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      background: var(--color-surface-raised);
      border: 1px solid var(--color-border-subtle);
      color: var(--color-text-muted);
      padding: 0.45rem 0.8rem;
      border-radius: var(--radius-md);
      font-size: 0.8125rem;
      cursor: pointer;
      transition: all var(--transition-normal);
    }
    .search-trigger-btn:hover {
      border-color: var(--color-border-focus);
      color: var(--color-text-primary);
    }
    .kbd-shortcut {
      background: var(--color-surface-sunken);
      border: 1px solid var(--color-border-subtle);
      border-radius: var(--radius-xs);
      padding: 0.1rem 0.35rem;
      font-size: 0.7rem;
      font-family: var(--font-mono);
    }
    .theme-toggle-btn {
      background: var(--color-surface-raised);
      border: 1px solid var(--color-border-subtle);
      color: var(--color-text-secondary);
      width: 36px;
      height: 36px;
      border-radius: var(--radius-md);
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      font-size: 1rem;
      transition: all var(--transition-normal);
    }
    .theme-toggle-btn:hover {
      color: var(--color-text-primary);
      border-color: var(--color-border-focus);
    }
    .btn-nav-login {
      color: var(--color-text-secondary);
      text-decoration: none;
      font-size: 0.875rem;
      font-weight: 500;
      padding: 0.45rem 0.85rem;
      transition: color var(--transition-normal);
    }
    .btn-nav-login:hover { color: var(--color-text-primary); }
    .btn-nav-cta {
      background: var(--color-text-primary);
      color: var(--color-text-inverse);
      text-decoration: none;
      font-size: 0.875rem;
      font-weight: 600;
      padding: 0.5rem 1rem;
      border-radius: var(--radius-md);
      transition: opacity var(--transition-normal), transform var(--transition-normal);
      display: inline-flex;
      align-items: center;
      gap: 0.35rem;
    }
    .btn-nav-cta:hover { opacity: 0.92; transform: translateY(-1px); }

    /* Live Ticker Tape */
    .ticker-tape-wrap {
      background: var(--color-night);
      border-bottom: 1px solid var(--color-night-border);
      overflow: hidden;
      white-space: nowrap;
      position: relative;
      z-index: 10;
    }
    .ticker-tape-inner {
      display: inline-flex;
      align-items: center;
      padding: 0.45rem 1rem;
      animation: tickerSlide 45s linear infinite;
      gap: 2.25rem;
    }
    @keyframes tickerSlide {
      0% { transform: translateX(0); }
      100% { transform: translateX(-50%); }
    }
    .ticker-item {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      font-size: 0.775rem;
      font-family: var(--font-mono);
    }
    .ticker-sym { font-weight: 600; color: var(--color-text-primary); }
    .ticker-val { color: var(--color-text-secondary); }
    .ticker-chg {
      font-weight: 600;
      padding: 0.05rem 0.3rem;
      border-radius: var(--radius-xs);
    }
    .ticker-chg.gain {
      color: var(--color-gain);
      background: var(--color-gain-subtle);
    }
    .ticker-chg.loss {
      color: var(--color-loss);
      background: var(--color-loss-subtle);
    }

    /* Hero Section */
    .hero-section {
      position: relative;
      z-index: 10;
      padding: 4.5rem 1.5rem 3.5rem;
      max-width: 1280px;
      margin: 0 auto;
      text-align: center;
    }
    .hero-badge-wrap {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      background: var(--color-surface-glass);
      border: 1px solid var(--color-surface-glass-border);
      backdrop-filter: var(--backdrop-blur-md);
      -webkit-backdrop-filter: var(--backdrop-blur-md);
      padding: 0.35rem 0.9rem;
      border-radius: var(--radius-full);
      font-size: 0.775rem;
      font-weight: 600;
      color: var(--color-text-secondary);
      margin-bottom: 1.5rem;
    }
    .hero-badge-dot {
      width: 7px;
      height: 7px;
      border-radius: var(--radius-full);
      background: var(--color-gain);
      box-shadow: 0 0 8px var(--color-gain);
    }
    .hero-headline {
      font-size: 3.6rem;
      font-weight: 800;
      letter-spacing: -0.035em;
      line-height: 1.1;
      margin-bottom: 1.25rem;
      color: var(--color-text-primary);
    }
    .hero-headline-gradient {
      background: linear-gradient(135deg, var(--color-text-primary) 30%, var(--color-accent) 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    .hero-subtitle {
      max-width: 780px;
      margin: 0 auto 2.25rem;
      font-size: 1.15rem;
      color: var(--color-text-secondary);
      line-height: 1.6;
    }
    .hero-ctas {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 1rem;
      margin-bottom: 2.5rem;
      flex-wrap: wrap;
    }
    .btn-hero-primary {
      background: var(--color-text-primary);
      color: var(--color-text-inverse);
      padding: 0.85rem 2rem;
      border-radius: var(--radius-lg);
      font-size: 1rem;
      font-weight: 600;
      text-decoration: none;
      transition: all var(--transition-normal);
      box-shadow: 0 4px 20px var(--color-surface-hover);
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
    }
    .btn-hero-primary:hover {
      transform: translateY(-2px);
      box-shadow: 0 8px 28px var(--color-surface-hover);
    }
    .btn-hero-secondary {
      background: var(--color-surface-glass);
      color: var(--color-text-primary);
      border: 1px solid var(--color-surface-glass-border);
      backdrop-filter: var(--backdrop-blur-md);
      -webkit-backdrop-filter: var(--backdrop-blur-md);
      padding: 0.85rem 1.75rem;
      border-radius: var(--radius-lg);
      font-size: 1rem;
      font-weight: 600;
      text-decoration: none;
      transition: all var(--transition-normal);
    }
    .btn-hero-secondary:hover {
      background: var(--color-surface-raised);
      border-color: var(--color-border-focus);
    }
    .hero-trust-row {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 2rem;
      font-size: 0.825rem;
      color: var(--color-text-muted);
      flex-wrap: wrap;
    }
    .trust-item {
      display: flex;
      align-items: center;
      gap: 0.35rem;
    }
    .trust-check {
      color: var(--color-gain);
      font-weight: 700;
    }

    /* Showcase Console (NextGenTP Hero Interactive Mockup) */
    .showcase-container {
      position: relative;
      z-index: 10;
      max-width: 1180px;
      margin: 1.5rem auto 4rem;
      padding: 0 1rem;
    }
    .console-chrome-card {
      background: var(--color-card);
      border: 1px solid var(--color-surface-glass-border);
      border-radius: var(--radius-2xl);
      box-shadow: var(--shadow-e3);
      overflow: hidden;
      backdrop-filter: var(--backdrop-blur-lg);
      -webkit-backdrop-filter: var(--backdrop-blur-lg);
    }
    .console-header-bar {
      background: var(--color-surface-sunken);
      border-bottom: 1px solid var(--color-border-subtle);
      padding: 0.75rem 1.25rem;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 1rem;
    }
    .window-dots {
      display: flex;
      align-items: center;
      gap: 0.45rem;
    }
    .dot {
      width: 11px;
      height: 11px;
      border-radius: var(--radius-full);
      display: inline-block;
    }
    .dot.red { background: var(--color-loss); }
    .dot.yellow { background: var(--color-warning); }
    .dot.green { background: var(--color-gain); }
    .console-url-pill {
      background: var(--color-surface-raised);
      border: 1px solid var(--color-border-subtle);
      border-radius: var(--radius-full);
      padding: 0.2rem 1rem;
      font-size: 0.75rem;
      color: var(--color-text-secondary);
      font-family: var(--font-mono);
      display: flex;
      align-items: center;
      gap: 0.4rem;
    }
    .console-status-pill {
      display: flex;
      align-items: center;
      gap: 0.4rem;
      font-size: 0.75rem;
      font-weight: 600;
      color: var(--color-gain);
      background: var(--color-gain-subtle);
      border: 1px solid var(--color-gain-border);
      padding: 0.2rem 0.65rem;
      border-radius: var(--radius-full);
    }
    .pulse-dot {
      width: 6px;
      height: 6px;
      border-radius: var(--radius-full);
      background: var(--color-gain);
      animation: pulseAnim 2s infinite;
    }
    @keyframes pulseAnim {
      0% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.4; transform: scale(0.85); }
      100% { opacity: 1; transform: scale(1); }
    }

    /* Console KPI Metric Ribbon */
    .console-kpi-ribbon {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      border-bottom: 1px solid var(--color-border-subtle);
      background: var(--color-surface-raised);
    }
    .kpi-cell {
      padding: 1.15rem 1.25rem;
      border-right: 1px solid var(--color-border-subtle);
    }
    .kpi-cell:last-child { border-right: none; }
    .kpi-micro-title {
      font-size: 0.725rem;
      color: var(--color-text-muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 0.35rem;
    }
    .kpi-main-val {
      font-size: 1.45rem;
      font-weight: 700;
      color: var(--color-text-primary);
      font-family: var(--font-mono);
      letter-spacing: -0.02em;
    }
    .kpi-sub-text {
      font-size: 0.775rem;
      margin-top: 0.2rem;
      display: flex;
      align-items: center;
      gap: 0.35rem;
    }
    .kpi-sub-text.positive { color: var(--color-gain); font-weight: 600; }
    .kpi-sub-text.neutral { color: var(--color-text-muted); }

    /* Chart Area */
    .chart-section {
      padding: 1.5rem 1.5rem 1rem;
      background: var(--color-card);
    }
    .chart-top-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 1.25rem;
      flex-wrap: wrap;
      gap: 0.75rem;
    }
    .chart-heading-group h3 {
      font-size: 1.1rem;
      font-weight: 600;
      color: var(--color-text-primary);
    }
    .chart-heading-group p {
      font-size: 0.8rem;
      color: var(--color-text-muted);
    }
    .timeframe-pills {
      display: flex;
      align-items: center;
      background: var(--color-surface-raised);
      border: 1px solid var(--color-border-subtle);
      border-radius: var(--radius-md);
      padding: 0.15rem;
      gap: 0.15rem;
    }
    .tf-btn {
      background: transparent;
      border: none;
      color: var(--color-text-muted);
      font-size: 0.75rem;
      font-weight: 600;
      padding: 0.25rem 0.6rem;
      border-radius: var(--radius-sm);
      cursor: pointer;
      transition: all var(--transition-fast);
    }
    .tf-btn.active, .tf-btn:hover {
      background: var(--color-card);
      color: var(--color-text-primary);
      box-shadow: var(--shadow-e1);
    }

    .svg-chart-wrap {
      width: 100%;
      height: 240px;
      position: relative;
    }
    .svg-chart-wrap svg {
      width: 100%;
      height: 100%;
      overflow: visible;
    }

    /* Split Dashboard (Positions vs Risk Stream) */
    .console-split-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      border-top: 1px solid var(--color-border-subtle);
      background: var(--color-card);
    }
    .split-col {
      padding: 1.25rem;
    }
    .split-col:first-child {
      border-right: 1px solid var(--color-border-subtle);
    }
    .split-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 0.85rem;
    }
    .split-title {
      font-size: 0.85rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--color-text-secondary);
    }
    .split-badge {
      font-size: 0.7rem;
      background: var(--color-surface-raised);
      border: 1px solid var(--color-border-subtle);
      color: var(--color-text-muted);
      padding: 0.1rem 0.45rem;
      border-radius: var(--radius-full);
      font-family: var(--font-mono);
    }

    /* Mini Table */
    .mini-positions-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.8125rem;
    }
    .mini-positions-table th {
      text-align: left;
      font-size: 0.6875rem;
      color: var(--color-text-muted);
      text-transform: uppercase;
      padding: 0.4rem 0.5rem;
      border-bottom: 1px solid var(--color-border-subtle);
    }
    .mini-positions-table td {
      padding: 0.55rem 0.5rem;
      border-bottom: 1px solid var(--color-border-subtle);
      color: var(--color-text-secondary);
    }
    .mini-positions-table tr:last-child td { border-bottom: none; }
    .pos-sym {
      font-weight: 600;
      color: var(--color-text-primary);
      font-family: var(--font-mono);
    }
    .pos-pnl.gain { color: var(--color-gain); font-weight: 600; font-family: var(--font-mono); }
    .pos-policy-pill {
      font-size: 0.675rem;
      padding: 0.1rem 0.35rem;
      border-radius: var(--radius-xs);
      background: var(--color-gain-subtle);
      color: var(--color-gain);
      font-weight: 600;
    }

    /* Live Risk Gate Stream */
    .risk-stream-list {
      display: flex;
      flex-direction: column;
      gap: 0.6rem;
    }
    .risk-stream-item {
      background: var(--color-surface-raised);
      border: 1px solid var(--color-border-subtle);
      border-radius: var(--radius-md);
      padding: 0.65rem 0.85rem;
      display: flex;
      align-items: flex-start;
      gap: 0.65rem;
    }
    .verdict-tag {
      font-size: 0.675rem;
      font-weight: 700;
      padding: 0.15rem 0.4rem;
      border-radius: var(--radius-xs);
      font-family: var(--font-mono);
      text-transform: uppercase;
      flex-shrink: 0;
    }
    .verdict-tag.pass {
      background: var(--color-gain-subtle);
      color: var(--color-gain);
      border: 1px solid var(--color-gain-border);
    }
    .verdict-tag.block {
      background: var(--color-loss-subtle);
      color: var(--color-loss);
      border: 1px solid var(--color-loss-border);
    }
    .verdict-tag.review {
      background: var(--color-warning-subtle);
      color: var(--color-warning);
      border: 1px solid var(--color-warning-border);
    }
    .risk-info { flex: 1; }
    .risk-rule-title {
      font-size: 0.775rem;
      font-weight: 600;
      color: var(--color-text-primary);
      margin-bottom: 0.15rem;
    }
    .risk-did-meta {
      font-size: 0.7rem;
      color: var(--color-text-muted);
      font-family: var(--font-mono);
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    /* 4-Pillars Global Stats Band */
    .stats-band-section {
      border-top: 1px solid var(--color-border-subtle);
      border-bottom: 1px solid var(--color-border-subtle);
      background: var(--color-surface-sunken);
      padding: 3.5rem 1.5rem;
    }
    .stats-band-inner {
      max-width: 1280px;
      margin: 0 auto;
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 2rem;
      text-align: center;
    }
    .stat-counter-box h4 {
      font-size: 2.8rem;
      font-weight: 800;
      color: var(--color-text-primary);
      letter-spacing: -0.03em;
      line-height: 1;
      margin-bottom: 0.4rem;
      font-family: var(--font-mono);
    }
    .stat-counter-box p {
      font-size: 0.9rem;
      font-weight: 600;
      color: var(--color-text-secondary);
      margin-bottom: 0.2rem;
    }
    .stat-counter-box span {
      font-size: 0.775rem;
      color: var(--color-text-muted);
    }

    /* Broker Marquee */
    .broker-section {
      padding: 3.5rem 1.5rem;
      max-width: 1280px;
      margin: 0 auto;
      text-align: center;
    }
    .broker-title {
      font-size: 0.8125rem;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--color-text-muted);
      margin-bottom: 1.75rem;
      font-weight: 600;
    }
    .broker-marquee-strip {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 1.25rem;
      flex-wrap: wrap;
    }
    .broker-pill {
      background: var(--color-surface-raised);
      border: 1px solid var(--color-border-subtle);
      padding: 0.65rem 1.25rem;
      border-radius: var(--radius-lg);
      font-size: 0.875rem;
      font-weight: 600;
      color: var(--color-text-secondary);
      display: flex;
      align-items: center;
      gap: 0.5rem;
      transition: all var(--transition-normal);
    }
    .broker-pill:hover {
      border-color: var(--color-border-focus);
      color: var(--color-text-primary);
      transform: translateY(-2px);
    }

    /* Architecture Features Grid */
    .features-section {
      padding: 4.5rem 1.5rem;
      max-width: 1280px;
      margin: 0 auto;
    }
    .section-eyebrow {
      text-align: center;
      font-size: 0.8125rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--color-accent);
      margin-bottom: 0.65rem;
    }
    .section-title {
      text-align: center;
      font-size: 2.3rem;
      font-weight: 800;
      letter-spacing: -0.025em;
      color: var(--color-text-primary);
      margin-bottom: 1rem;
    }
    .section-desc {
      text-align: center;
      max-width: 680px;
      margin: 0 auto 3rem;
      font-size: 1.05rem;
      color: var(--color-text-muted);
    }
    .features-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 1.5rem;
    }
    .feature-card {
      background: var(--color-card);
      border: 1px solid var(--color-border-subtle);
      border-radius: var(--radius-xl);
      padding: 2rem;
      position: relative;
      overflow: hidden;
      transition: all var(--transition-normal);
    }
    .feature-card:hover {
      border-color: var(--color-border-focus);
      transform: translateY(-2px);
      box-shadow: var(--shadow-e2);
    }
    .feature-icon-box {
      width: 44px;
      height: 44px;
      border-radius: var(--radius-lg);
      background: var(--color-accent-subtle);
      border: 1px solid var(--color-accent-border);
      color: var(--color-accent);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 1.35rem;
      margin-bottom: 1.25rem;
    }
    .feature-card h3 {
      font-size: 1.2rem;
      font-weight: 700;
      color: var(--color-text-primary);
      margin-bottom: 0.65rem;
    }
    .feature-card p {
      color: var(--color-text-muted);
      font-size: 0.925rem;
      line-height: 1.6;
    }

    /* Comparison Table Section */
    .comparison-section {
      padding: 4rem 1.5rem;
      max-width: 1080px;
      margin: 0 auto;
    }
    .comp-table {
      width: 100%;
      border-collapse: collapse;
      background: var(--color-card);
      border: 1px solid var(--color-border-subtle);
      border-radius: var(--radius-xl);
      overflow: hidden;
    }
    .comp-table th {
      padding: 1.15rem 1.25rem;
      font-size: 0.85rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      border-bottom: 1px solid var(--color-border-subtle);
      background: var(--color-surface-sunken);
      color: var(--color-text-secondary);
      text-align: left;
    }
    .comp-table th.highlight-col {
      color: var(--color-accent);
      background: var(--color-accent-subtle);
    }
    .comp-table td {
      padding: 1rem 1.25rem;
      border-bottom: 1px solid var(--color-border-subtle);
      font-size: 0.875rem;
      color: var(--color-text-secondary);
    }
    .comp-table tr:last-child td { border-bottom: none; }
    .comp-table td.highlight-col {
      background: var(--color-surface-raised);
      font-weight: 600;
      color: var(--color-text-primary);
    }

    /* Institutional Footer */
    .footer-section {
      background: var(--color-night);
      border-top: 1px solid var(--color-night-border);
      padding: 4rem 1.5rem 2.5rem;
      color: var(--color-text-muted);
      font-size: 0.8125rem;
    }
    .footer-inner {
      max-width: 1280px;
      margin: 0 auto;
      display: grid;
      grid-template-columns: 2fr 1fr 1fr 1fr;
      gap: 3rem;
      margin-bottom: 3rem;
    }
    .footer-brand h4 {
      font-size: 1.15rem;
      font-weight: 700;
      color: var(--color-text-primary);
      margin-bottom: 0.75rem;
    }
    .footer-brand p {
      max-width: 320px;
      line-height: 1.6;
      margin-bottom: 1.25rem;
    }
    .footer-col h5 {
      font-size: 0.85rem;
      font-weight: 700;
      color: var(--color-text-primary);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 1rem;
    }
    .footer-col ul { list-style: none; display: flex; flex-direction: column; gap: 0.6rem; }
    .footer-col a {
      color: var(--color-text-muted);
      text-decoration: none;
      transition: color var(--transition-fast);
    }
    .footer-col a:hover { color: var(--color-text-primary); }
    .footer-bottom-bar {
      max-width: 1280px;
      margin: 0 auto;
      padding-top: 2rem;
      border-top: 1px solid var(--color-night-border);
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 1rem;
    }
    .disclaimer-box {
      font-size: 0.725rem;
      line-height: 1.6;
      max-width: 820px;
      color: var(--color-text-dim);
    }

    /* ⌘K Search Modal on the Universal Modal System (#2283 stream 5):
       backdrop + dialog chrome come from .modal-backdrop/.modal-dialog;
       only the palette's top-anchored placement stays page-local. */
    #searchBackdrop,
    #searchModal {
      display: none;
    }
    .modal-dialog.search-palette {
      align-self: flex-start;
      margin-top: 15vh;
      width: 90%;
      max-width: 580px;
      overflow: hidden;
    }
    .search-modal-input-wrap {
      padding: 1rem;
      border-bottom: 1px solid var(--color-border-subtle);
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }
    .search-input {
      width: 100%;
      background: transparent;
      border: none;
      outline: none;
      font-size: 1rem;
      color: var(--color-text-primary);
      font-family: var(--font-sans);
    }
    .search-results-list {
      max-height: 320px;
      overflow-y: auto;
      padding: 0.5rem;
      list-style: none;
    }
    .search-res-item {
      padding: 0.65rem 0.85rem;
      border-radius: var(--radius-md);
      display: flex;
      align-items: center;
      justify-content: space-between;
      color: var(--color-text-secondary);
      font-size: 0.875rem;
      cursor: pointer;
      text-decoration: none;
    }
    .search-res-item:hover {
      background: var(--color-surface-raised);
      color: var(--color-text-primary);
    }

    /* Responsive */
    @media (max-width: 1024px) {
      .hero-headline { font-size: 2.8rem; }
      .console-kpi-ribbon { grid-template-columns: repeat(2, 1fr); }
      .kpi-cell:nth-child(2) { border-right: none; }
      .kpi-cell:nth-child(3) { border-top: 1px solid var(--color-border-subtle); }
      .kpi-cell:nth-child(4) { border-top: 1px solid var(--color-border-subtle); border-right: none; }
      .console-split-grid { grid-template-columns: 1fr; }
      .split-col:first-child { border-right: none; border-bottom: 1px solid var(--color-border-subtle); }
      .stats-band-inner { grid-template-columns: repeat(2, 1fr); gap: 2.5rem; }
      .features-grid { grid-template-columns: 1fr; }
      .footer-inner { grid-template-columns: 1fr 1fr; }
    }
    @media (max-width: 768px) {
      .nav-links, .search-trigger-btn { display: none; }
      .hero-headline { font-size: 2.2rem; }
      .stats-band-inner { grid-template-columns: 1fr; }
      .footer-inner { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <!-- Ambient decorative patterns -->
  <div class="bg-grid-pattern" aria-hidden="true"></div>
  <div class="spotlight-radial" aria-hidden="true"></div>

  <!-- Announcement Bar -->
  <aside class="announcement-bar" role="region" aria-label="Announcement">
    <span class="announcement-pill">Algo 2.0 Engine</span>
    <span>Multi-broker autonomous execution &amp; deterministic risk gates are now live.</span>
    <a href="/login" class="announcement-link">Get early access &rarr;</a>
  </aside>

  <!-- Navigation -->
  <header class="main-nav">
    <div class="nav-container">
      <a href="/" class="brand-wrap">
        <div class="brand-logo-icon">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <polygon points="12 2 22 8.5 22 15.5 12 22 2 15.5 2 8.5 12 2"></polygon>
            <line x1="12" y1="22" x2="12" y2="15.5"></line>
            <polyline points="22 8.5 12 15.5 2 8.5"></polyline>
          </svg>
        </div>
        <span class="brand-name">${name} <span class="brand-badge">PRO</span></span>
      </a>

      <nav aria-label="Primary navigation">
        <ul class="nav-links">
          <li><a href="#autopilot">Autopilot</a></li>
          <li><a href="#risk-engine">Risk Gates</a></li>
          <li><a href="#brokers">Brokers</a></li>
          <li><a href="#architecture">Architecture</a></li>
          <li><a href="#pricing">Pricing</a></li>
        </ul>
      </nav>

      <div class="nav-actions">
        <button type="button" class="search-trigger-btn" id="openSearchBtn" aria-label="Search strategies and documentation">
          <span>Search...</span>
          <span class="kbd-shortcut">⌘K</span>
        </button>

        <button type="button" class="theme-toggle-btn" id="themeToggleBtn" aria-label="Toggle visual theme">
          <span id="themeIcon">🌙</span>
        </button>

        <a href="/login" class="btn-nav-login">Sign in</a>
        <a href="/login" class="btn-nav-cta">
          <span>Start on paper</span>
          &rarr;
        </a>
      </div>
    </div>
  </header>

  <!-- Live Market Ticker Tape -->
  <div class="ticker-tape-wrap" role="region" aria-label="Live Market Indices">
    <div class="ticker-tape-inner">
      ${tapeItemsHtml}
      <!-- Duplicate for infinite marquee effect -->
      ${tapeItemsHtml}
    </div>
  </div>

  <!-- Hero Section -->
  <main>
    <section class="hero-section">
      <div class="hero-badge-wrap">
        <span class="hero-badge-dot"></span>
        <span>Deterministic Agentic Trading Engine &bull; Zero Hallucination Risk Gates</span>
      </div>

      <h1 class="hero-headline">
        Self-Driving Alpha.<br>
        <span class="hero-headline-gradient">Deterministic Risk Gates.</span>
      </h1>

      <p class="hero-subtitle">
        Deploy verifiable autonomous trading strategies across equities, multi-leg options, and index futures. Every trade proposal passes through strict runtime guardrails, signed by W3C Agent DIDs, and executed directly via non-custodial broker APIs.
      </p>

      <div class="hero-ctas">
        <a href="/login" class="btn-hero-primary">
          <span>Launch Autopilot (Paper &amp; Live)</span>
          &rarr;
        </a>
        <a href="#autopilot" class="btn-hero-secondary">
          <span>Explore Live Risk Console</span>
        </a>
      </div>

      <div class="hero-trust-row">
        <div class="trust-item"><span class="trust-check">&check;</span> Non-custodial API execution</div>
        <div class="trust-item"><span class="trust-check">&check;</span> Pre-trade deterministic risk policy</div>
        <div class="trust-item"><span class="trust-check">&check;</span> Cryptographic W3C Agent DID signatures</div>
        <div class="trust-item"><span class="trust-check">&check;</span> 0% Performance fees</div>
      </div>
    </section>

    <!-- Showcase Console (NextGenTP Hero Component) -->
    <section class="showcase-container" id="autopilot">
      <div class="console-chrome-card">
        <!-- Chrome Top Bar -->
        <div class="console-header-bar">
          <div class="window-dots">
            <span class="dot red"></span>
            <span class="dot yellow"></span>
            <span class="dot green"></span>
          </div>

          <div class="console-url-pill">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
              <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
            </svg>
            <span>cfagent://autopilot/runtime-gate &bull; Node 01 (US-East)</span>
          </div>

          <div class="console-status-pill">
            <span class="pulse-dot"></span>
            <span>AUTOPILOT ARMED</span>
          </div>
        </div>

        <!-- 4 KPI Performance Ribbon -->
        <div class="console-kpi-ribbon">
          <div class="kpi-cell">
            <div class="kpi-micro-title">Portfolio NAV</div>
            <div class="kpi-main-val" id="kpiNav">$142,850.00</div>
            <div class="kpi-sub-text positive">&uarr; +$24,190.20 (+20.39% YTD)</div>
          </div>
          <div class="kpi-cell">
            <div class="kpi-micro-title">Max Drawdown</div>
            <div class="kpi-main-val" id="kpiDd">-2.84%</div>
            <div class="kpi-sub-text neutral">Policy Threshold: 5.00% Max</div>
          </div>
          <div class="kpi-cell">
            <div class="kpi-micro-title">Sharpe Ratio (6M)</div>
            <div class="kpi-main-val">2.64</div>
            <div class="kpi-sub-text positive">&uarr; S&amp;P 500 Benchmark: 1.12</div>
          </div>
          <div class="kpi-cell">
            <div class="kpi-micro-title">Risk Gate Verdicts</div>
            <div class="kpi-main-val">1,428</div>
            <div class="kpi-sub-text positive">&check; 100% Signed &bull; 0 Overrides</div>
          </div>
        </div>

        <!-- Chart Section -->
        <div class="chart-section">
          <div class="chart-top-bar">
            <div class="chart-heading-group">
              <h3>Strategy Equity vs S&amp;P 500 Benchmark</h3>
              <p>Real-time mark-to-market performance including execution slippage &amp; commissions</p>
            </div>

            <div class="timeframe-pills" role="tablist" aria-label="Chart timeframe">
              <button type="button" class="tf-btn" data-tf="1d">1D</button>
              <button type="button" class="tf-btn" data-tf="1w">1W</button>
              <button type="button" class="tf-btn" data-tf="1m">1M</button>
              <button type="button" class="tf-btn" data-tf="3m">3M</button>
              <button type="button" class="tf-btn active" data-tf="6m">6M</button>
              <button type="button" class="tf-btn" data-tf="ytd">YTD</button>
            </div>
          </div>

          <!-- Interactive SVG Equity Chart -->
          <div class="svg-chart-wrap">
            <svg viewBox="0 0 1000 240" preserveAspectRatio="none">
              <defs>
                <linearGradient id="curveGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stop-color="var(--color-gain)" stop-opacity="0.32"></stop>
                  <stop offset="100%" stop-color="var(--color-gain)" stop-opacity="0.00"></stop>
                </linearGradient>
              </defs>

              <!-- Grid reference lines -->
              <line x1="0" y1="40" x2="1000" y2="40" stroke="var(--color-border-subtle)" stroke-width="1" stroke-dasharray="4 4"></line>
              <line x1="0" y1="100" x2="1000" y2="100" stroke="var(--color-border-subtle)" stroke-width="1" stroke-dasharray="4 4"></line>
              <line x1="0" y1="160" x2="1000" y2="160" stroke="var(--color-border-subtle)" stroke-width="1" stroke-dasharray="4 4"></line>
              <line x1="0" y1="220" x2="1000" y2="220" stroke="var(--color-border-subtle)" stroke-width="1"></line>

              <!-- S&P 500 Benchmark line (Dashed) -->
              <path d="M 0,195 Q 150,185 300,170 T 600,145 T 850,130 T 1000,120"
                    fill="none" stroke="var(--color-text-dim)" stroke-width="2" stroke-dasharray="6 6"></path>

              <!-- Alpha Strategy Gradient Fill -->
              <path id="chartAreaPath"
                    d="M 0,220 L 0,190 Q 120,180 240,150 T 480,110 T 720,70 T 880,45 T 1000,25 L 1000,220 Z"
                    fill="url(#curveGradient)"></path>

              <!-- Alpha Strategy Glowing Curve -->
              <path id="chartLinePath"
                    d="M 0,190 Q 120,180 240,150 T 480,110 T 720,70 T 880,45 T 1000,25"
                    fill="none" stroke="var(--color-gain)" stroke-width="3" stroke-linecap="round"></path>

              <!-- Milestone Event Nodes -->
              <g transform="translate(480, 110)">
                <circle r="5" fill="var(--color-gain)" stroke="var(--color-surface)" stroke-width="2"></circle>
              </g>
              <g transform="translate(720, 70)">
                <circle r="5" fill="var(--color-gain)" stroke="var(--color-surface)" stroke-width="2"></circle>
              </g>
              <g transform="translate(1000, 25)">
                <circle r="6" fill="var(--color-gain)" stroke="var(--color-surface)" stroke-width="2"></circle>
              </g>
            </svg>
          </div>
        </div>

        <!-- Split Grid: Positions vs Risk Stream -->
        <div class="console-split-grid">
          <!-- Left: Positions -->
          <div class="split-col">
            <div class="split-header">
              <span class="split-title">Active Strategy Allocations</span>
              <span class="split-badge">4 Holdings</span>
            </div>

            <table class="mini-positions-table">
              <thead>
                <tr>
                  <th>Asset &amp; Strategy</th>
                  <th>Qty</th>
                  <th>Notional</th>
                  <th>Unrealized P&amp;L</th>
                  <th>Risk Gate</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td><span class="pos-sym">SPY</span> 580/590 Bull Put</td>
                  <td>20</td>
                  <td>$18,400</td>
                  <td><span class="pos-pnl gain">+$1,420.00</span></td>
                  <td><span class="pos-policy-pill">&check; Compliant</span></td>
                </tr>
                <tr>
                  <td><span class="pos-sym">NVDA</span> 135/140 Bull Call</td>
                  <td>15</td>
                  <td>$21,750</td>
                  <td><span class="pos-pnl gain">+$3,840.00</span></td>
                  <td><span class="pos-policy-pill">&check; Compliant</span></td>
                </tr>
                <tr>
                  <td><span class="pos-sym">MSFT</span> Covered Calls</td>
                  <td>100</td>
                  <td>$42,800</td>
                  <td><span class="pos-pnl gain">+$890.00</span></td>
                  <td><span class="pos-policy-pill">&check; Compliant</span></td>
                </tr>
                <tr>
                  <td><span class="pos-sym">US TREASURY</span> 5.1% Yield</td>
                  <td>Cash</td>
                  <td>$59,900</td>
                  <td><span class="pos-pnl gain">+$285.40</span></td>
                  <td><span class="pos-policy-pill">&check; 41.9% Reserve</span></td>
                </tr>
              </tbody>
            </table>
          </div>

          <!-- Right: Live Risk Stream -->
          <div class="split-col" id="risk-engine">
            <div class="split-header">
              <span class="split-title">Live Risk Gate Decisions</span>
              <span class="split-badge">W3C DID Ledger</span>
            </div>

            <div class="risk-stream-list">
              <div class="risk-stream-item">
                <span class="verdict-tag pass">PASS</span>
                <div class="risk-info">
                  <div class="risk-rule-title">Max position sizing: 12.4% &le; 15.0% policy cap</div>
                  <div class="risk-did-meta">
                    <span>did:key:z6Mku7y9...#sig-01</span>
                    <span>2 mins ago</span>
                  </div>
                </div>
              </div>

              <div class="risk-stream-item">
                <span class="verdict-tag block">BLOCK</span>
                <div class="risk-info">
                  <div class="risk-rule-title">Single order notional $32,000 exceeds $25,000 limit</div>
                  <div class="risk-did-meta">
                    <span>did:key:z6Mku7y9...#sig-02</span>
                    <span>14 mins ago</span>
                  </div>
                </div>
              </div>

              <div class="risk-stream-item">
                <span class="verdict-tag pass">PASS</span>
                <div class="risk-info">
                  <div class="risk-rule-title">Delta neutrality check: Portfolio Delta -0.04 &isin; [-0.15, +0.15]</div>
                  <div class="risk-did-meta">
                    <span>did:key:z6Mku7y9...#sig-03</span>
                    <span>31 mins ago</span>
                  </div>
                </div>
              </div>

              <div class="risk-stream-item">
                <span class="verdict-tag review">REVIEW</span>
                <div class="risk-info">
                  <div class="risk-rule-title">Implied Volatility spike &gt; 35% &bull; Routed to human queue</div>
                  <div class="risk-did-meta">
                    <span>did:key:z6Mku7y9...#sig-04</span>
                    <span>1 hour ago</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- Global Stats Band -->
    <section class="stats-band-section">
      <div class="stats-band-inner">
        <div class="stat-counter-box">
          <h4>4</h4>
          <p>Asset Classes</p>
          <span>Equities, Options, Index ETFs, Futures</span>
        </div>
        <div class="stat-counter-box">
          <h4>63+</h4>
          <p>Connected Brokers</p>
          <span>E*TRADE, Schwab, IBKR, Alpaca</span>
        </div>
        <div class="stat-counter-box">
          <h4>0%</h4>
          <p>Performance Fees</p>
          <span>Keep 100% of generated alpha</span>
        </div>
        <div class="stat-counter-box">
          <h4>14-Day</h4>
          <p>Paper Sandbox</p>
          <span>Unrestricted institutional testing</span>
        </div>
      </div>
    </section>

    <!-- Supported Brokers Section -->
    <section class="broker-section" id="brokers">
      <div class="broker-title">Direct Non-Custodial Broker &amp; Exchange Connectivity</div>
      <div class="broker-marquee-strip">
        <div class="broker-pill"><span>⚡</span> E*TRADE from Morgan Stanley</div>
        <div class="broker-pill"><span>🏛️</span> Charles Schwab</div>
        <div class="broker-pill"><span>🌐</span> Interactive Brokers (IBKR)</div>
        <div class="broker-pill"><span>🦙</span> Alpaca Markets</div>
        <div class="broker-pill"><span>📈</span> Tradier Brokerage</div>
        <div class="broker-pill"><span>🏦</span> Fidelity Investments</div>
        <div class="broker-pill"><span>📊</span> Cboe Live Options Data</div>
      </div>
    </section>

    <!-- Architecture & Features Grid -->
    <section class="features-section" id="architecture">
      <div class="section-eyebrow">Enterprise Architecture</div>
      <h2 class="section-title">Built for Quant Rigor. Sealed for Safety.</h2>
      <p class="section-desc">
        Eliminate LLM execution risks. Algorithmic intent is modeled in code, validated with Black-Scholes quant formulas, and gated by deterministic policy engines.
      </p>

      <div class="features-grid">
        <article class="feature-card">
          <div class="feature-icon-box">🧠</div>
          <h3>Natural-Language Strategy Copilot</h3>
          <p>
            Screen options chains, compare bull put spreads, and research risk profiles in plain English. Your prompt is converted into visible, deterministic mathematical parameters with zero guesswork.
          </p>
        </article>

        <article class="feature-card">
          <div class="feature-icon-box">⚡</div>
          <h3>Fast order ticket &amp; preview</h3>
          <p>
            trading-platform order preview with human approval. Turn a recommendation into a signed order ticket in one click with policy verification sealed by an auditable cryptographic identity.
          </p>
        </article>

        <article class="feature-card">
          <div class="feature-icon-box">📊</div>
          <h3>Options strategy screening &amp; best-trade ranking</h3>
          <p>
            Quantitative screener across multi-leg options chains and strikes. Ranks bull puts, iron condors, and covered calls by risk-adjusted alpha, probability of profit, and Greeks profile.
          </p>
        </article>

        <article class="feature-card">
          <div class="feature-icon-box">⚖️</div>
          <h3>Quant vs LLM comparison</h3>
          <p>
            Give the same market options data to an LLM and compare rankings and rationale side by side with the deterministic quant scores. The LLM can only select from strictly validated candidates.
          </p>
        </article>

        <article class="feature-card">
          <div class="feature-icon-box">📜</div>
          <h3>Signed, audited trade drafts &amp; ledger</h3>
          <p>
            Cryptographically signed trade drafts and append-only execution ledger. Every proposal and execution action is verified against W3C Agent DIDs and recorded immutably.
          </p>
        </article>

        <article class="feature-card">
          <div class="feature-icon-box">🛡️</div>
          <h3>Zero-Hallucination Risk Gate</h3>
          <p>
            Orders cannot bypass code. Max drawdown limits, single-trade caps, portfolio delta bounds, and cash reserve thresholds are computed in an isolated runtime that blocks unauthorized orders.
          </p>
        </article>
      </div>
    </section>

    <!-- Comparison Table Section -->
    <section class="comparison-section" id="pricing">
      <div class="section-eyebrow">Platform Comparison</div>
      <h2 class="section-title">Why ${name} Outperforms</h2>
      <p class="section-desc">Compare the architecture of true deterministic trading against traditional platforms and unconstrained AI chatbots.</p>

      <table class="comp-table">
        <thead>
          <tr>
            <th>Architecture Dimension</th>
            <th class="highlight-col">${name} Engine</th>
            <th>Traditional Broker Desk</th>
            <th>Generic LLM Chatbot</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><strong>Pre-Trade Risk Gates</strong></td>
            <td class="highlight-col">&check; Strict Deterministic Runtime</td>
            <td>&check; Manual Margin Checks</td>
            <td>&cross; Zero (Hallucination Risk)</td>
          </tr>
          <tr>
            <td><strong>Cryptographic Audit Proofs</strong></td>
            <td class="highlight-col">&check; W3C Agent DID Signed</td>
            <td>&cross; Opaque Internal DB</td>
            <td>&cross; None</td>
          </tr>
          <tr>
            <td><strong>Multi-Leg Options Pricing</strong></td>
            <td class="highlight-col">&check; Real-time Greeks &amp; Payoffs</td>
            <td>&check; Basic Greeks</td>
            <td>&cross; Text approximations</td>
          </tr>
          <tr>
            <td><strong>Autonomous Execution</strong></td>
            <td class="highlight-col">&check; Autopilot with Kill Switch</td>
            <td>&cross; Manual click only</td>
            <td>&cross; Unsafe</td>
          </tr>
          <tr>
            <td><strong>Fee Structure</strong></td>
            <td class="highlight-col">&check; 0% Performance Fees</td>
            <td>High AUM or Commission</td>
            <td>Subscription only</td>
          </tr>
        </tbody>
      </table>
    </section>
  </main>

  <!-- Institutional Footer -->
  <footer class="footer-section">
    <div class="footer-inner">
      <div class="footer-brand">
        <h4>${name}</h4>
        <p>Institutional autonomous trading infrastructure, deterministic pre-trade risk policy engines, and cryptographic audit ledgers.</p>
        <p>&copy; 2026 ${name} Inc. All rights reserved.</p>
      </div>

      <div class="footer-col">
        <h5>Platform</h5>
        <ul>
          <li><a href="#autopilot">Autopilot</a></li>
          <li><a href="#risk-engine">Risk Engine</a></li>
          <li><a href="#brokers">Broker Connectors</a></li>
          <li><a href="/login">Paper Sandbox</a></li>
        </ul>
      </div>

      <div class="footer-col">
        <h5>Quant Engine</h5>
        <ul>
          <li><a href="#architecture">Options Greeks</a></li>
          <li><a href="#architecture">Black-Scholes Models</a></li>
          <li><a href="#architecture">Delta Neutrality</a></li>
          <li><a href="/login">API &amp; MCP Endpoints</a></li>
        </ul>
      </div>

      <div class="footer-col">
        <h5>Security &amp; Policy</h5>
        <ul>
          <li><a href="#risk-engine">W3C Agent DIDs</a></li>
          <li><a href="#risk-engine">Risk Policies</a></li>
          <li><a href="/login">Sign in</a></li>
        </ul>
      </div>
    </div>

    <div class="footer-bottom-bar">
      <div class="disclaimer-box">
        <strong>Regulatory Disclaimers:</strong> ${name} is a financial technology software provider and is not a registered broker-dealer or investment adviser. Research outputs, strategy scoring, and simulations are informational and educational, not personalized investment advice. All options trading involves significant financial risk and is not suitable for all investors. Test all automated strategies in paper trading sandboxes before routing live capital.
      </div>
      <a href="/login" class="btn-nav-cta">Launch Autopilot &rarr;</a>
    </div>
  </footer>

  <!-- ⌘K Search Modal -->
  <div class="modal-backdrop" id="searchBackdrop"></div>
  <div class="modal-dialog search-palette" id="searchModal" role="dialog" aria-modal="true" aria-label="Search">
    <div class="search-modal-input-wrap">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="11" cy="11" r="8"></circle>
        <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
      </svg>
      <input type="text" class="search-input" id="searchField" placeholder="Search strategies, Greeks, risk gates, docs..." autocomplete="off">
    </div>
    <ul class="search-results-list" id="searchResults">
      <li><a href="#autopilot" class="search-res-item"><span>⚡ Autopilot Control Center</span><span class="kbd-shortcut">JUMP</span></a></li>
      <li><a href="#risk-engine" class="search-res-item"><span>🛡️ Deterministic Risk Gate Policy</span><span class="kbd-shortcut">JUMP</span></a></li>
      <li><a href="#brokers" class="search-res-item"><span>🏦 Connected Brokers (E*TRADE, Schwab, IBKR)</span><span class="kbd-shortcut">JUMP</span></a></li>
      <li><a href="#architecture" class="search-res-item"><span>🧮 60+ Options Strategies &amp; Payoffs</span><span class="kbd-shortcut">JUMP</span></a></li>
      <li><a href="/login" class="search-res-item"><span>🚀 Launch Paper Trading Sandbox</span><span class="kbd-shortcut">ENTER</span></a></li>
    </ul>
  </div>

  <!-- Interactive Scripts -->
  <script>
    // Theme switching logic
    (function() {
      const themes = ['dark', 'light', 'high-contrast'];
      const themeIcons = { 'dark': '🌙', 'light': '☀️', 'high-contrast': '👁️' };
      const btn = document.getElementById('themeToggleBtn');
      const icon = document.getElementById('themeIcon');
      
      const storedTheme = localStorage.getItem('theme') || 'dark';
      document.documentElement.setAttribute('data-theme', storedTheme);
      if (icon) icon.textContent = themeIcons[storedTheme] || '🌙';

      if (btn) {
        btn.addEventListener('click', () => {
          const current = document.documentElement.getAttribute('data-theme') || 'dark';
          const nextIndex = (themes.indexOf(current) + 1) % themes.length;
          const next = themes[nextIndex];
          document.documentElement.setAttribute('data-theme', next);
          localStorage.setItem('theme', next);
          if (icon) icon.textContent = themeIcons[next];
        });
      }
    })();

    // ⌘K Search Modal logic
    (function() {
      const openBtn = document.getElementById('openSearchBtn');
      const backdrop = document.getElementById('searchBackdrop');
      const modal = document.getElementById('searchModal');
      const field = document.getElementById('searchField');

      function openModal() {
        if (!modal || !backdrop) return;
        backdrop.style.display = 'flex';
        modal.style.display = 'block';
        if (field) { field.value = ''; field.focus(); }
      }

      function closeModal() {
        if (!modal || !backdrop) return;
        backdrop.style.display = 'none';
        modal.style.display = 'none';
      }

      if (openBtn) openBtn.addEventListener('click', openModal);
      if (backdrop) backdrop.addEventListener('click', closeModal);

      window.addEventListener('keydown', (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
          e.preventDefault();
          if (modal && modal.style.display === 'block') closeModal();
          else openModal();
        }
        if (e.key === 'Escape') closeModal();
      });

      // Quick filter
      if (field) {
        field.addEventListener('input', () => {
          const q = field.value.toLowerCase();
          const items = document.querySelectorAll('#searchResults .search-res-item');
          items.forEach((item) => {
            const txt = item.textContent.toLowerCase();
            const li = item.parentElement;
            if (li) li.style.display = txt.includes(q) ? 'block' : 'none';
          });
        });
      }
    })();

    // Timeframe switcher in showcase chart
    (function() {
      const tfBtns = document.querySelectorAll('.tf-btn');
      const navEl = document.getElementById('kpiNav');
      const ddEl = document.getElementById('kpiDd');
      const data = {
        '1d': { nav: '$142,850.00', dd: '-0.32%', pnl: '+$1,120.40' },
        '1w': { nav: '$142,850.00', dd: '-0.85%', pnl: '+$3,450.00' },
        '1m': { nav: '$142,850.00', dd: '-1.42%', pnl: '+$8,920.10' },
        '3m': { nav: '$142,850.00', dd: '-2.10%', pnl: '+$16,400.00' },
        '6m': { nav: '$142,850.00', dd: '-2.84%', pnl: '+$24,190.20' },
        'ytd': { nav: '$142,850.00', dd: '-2.84%', pnl: '+$24,190.20' },
      };

      tfBtns.forEach((btn) => {
        btn.addEventListener('click', () => {
          tfBtns.forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          const tf = btn.getAttribute('data-tf') || '6m';
          const match = data[tf];
          if (match && navEl && ddEl) {
            navEl.textContent = match.nav;
            ddEl.textContent = match.dd;
          }
        });
      });
    })();
    // Issue #2130: the landing tape goes live on the same feed as the
    // in-app tape. WS-first with a REST polling fallback; both surfaces
    // are unauthenticated by design. Every matching .ticker-item (the
    // marquee duplicates included) updates by symbol; a symbol with no
    // live quote keeps its static baseline, never a blank.
    (function() {
      var MAP = ${tapeMapLiteral};
      var SYMBOLS = Object.keys(MAP).map(function(k) { return MAP[k]; });
      var itemsBySymbol = {};
      document.querySelectorAll('.ticker-item').forEach(function(item) {
        var symEl = item.querySelector('.ticker-sym');
        var label = symEl ? symEl.textContent.trim() : '';
        var symbol = MAP[label];
        if (!symbol) return;
        (itemsBySymbol[symbol] = itemsBySymbol[symbol] || []).push({
          val: item.querySelector('.ticker-val'),
          chg: item.querySelector('.ticker-chg')
        });
      });
      if (Object.keys(itemsBySymbol).length === 0) return;
      function applyQuote(q) {
        var targets = itemsBySymbol[q.symbol];
        if (!targets || !q.formattedPrice) return;
        targets.forEach(function(t) {
          if (t.val) {
            var keepPct = t.val.textContent.trim().endsWith('%');
            t.val.textContent = q.formattedPrice + (keepPct ? '%' : '');
          }
          if (t.chg && q.formattedChange) {
            t.chg.textContent = q.formattedChange;
            t.chg.classList.remove('gain', 'loss');
            t.chg.classList.add(q.isPositive ? 'gain' : 'loss');
          }
        });
      }
      function applyQuotes(list) { (list || []).forEach(applyQuote); }
      // Issue #2419: WS-first with a reconnecting socket and a
      // gentler, hidden-paused REST fallback. A dropped socket used
      // to strand the tab on 12s polling forever; now it reconnects
      // with exponential backoff, polling stops the moment the socket
      // is live again, and nothing polls while the tab is hidden.
      var POLLING_CFG = ${pollingConfigLiteral};
      var pollTimer = null;
      var REST_POLL_MS = POLLING_CFG.quotesRestFallbackMs;
      var wsBackoff = POLLING_CFG.quotesWsReconnectBaseMs;
      var wsBackoffCap = POLLING_CFG.quotesWsReconnectCapMs;
      var wsTimer = null;
      var ws = null;
      function stopPolling() {
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      }
      function fetchRest() {
        fetch('/api/market/quotes?symbols=' + encodeURIComponent(SYMBOLS.join(',')))
          .then(function(r) { return r.ok ? r.json() : Promise.reject(new Error('quotes fetch failed')); })
          .then(function(data) { applyQuotes(data && data.quotes); })
          .catch(function() { /* keep the static baseline */ });
      }
      // Issue #2481 — the landing-page quotes feed is a periodic
      // live-data refresh, so it runs only while the global
      // auto-refresh switch is ON. OFF leaves the server-rendered
      // static baseline in place and opens no socket and no poll.
      // The switch is the same global key the app toggle writes;
      // with no stored value the default is OFF (as in the app).
      function autoRefreshEnabled() {
        try {
          if (localStorage.getItem("cfagent_global_autorefresh_enabled") === "true") return true;
          return localStorage.getItem("cfagent_options_autorefresh_enabled") === "true";
        } catch (e) { return false; }
      }
      function stopLive() {
        stopPolling();
        if (wsTimer) { clearTimeout(wsTimer); wsTimer = null; }
        if (ws) { try { ws.close(); } catch (e) {} ws = null; }
      }
      function startPolling() {
        if (pollTimer) return;
        if (!autoRefreshEnabled()) return;
        if (document.visibilityState === "hidden") return;
        fetchRest();
        pollTimer = setInterval(fetchRest, REST_POLL_MS);
      }
      function scheduleReconnect() {
        if (!autoRefreshEnabled()) return;
        if (wsTimer) return;
        if (document.visibilityState === "hidden") return;
        wsTimer = setTimeout(function() { wsTimer = null; connect(); }, wsBackoff);
        wsBackoff = Math.min(wsBackoff * 2, wsBackoffCap);
      }
      function connect() {
        if (!autoRefreshEnabled()) return;
        if (typeof WebSocket === 'undefined') { startPolling(); return; }
        var proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        try {
          ws = new WebSocket(proto + '//' + window.location.host + '/api/market/quotes/ws');
        } catch (e) { startPolling(); scheduleReconnect(); return; }
        ws.onopen = function() {
          wsBackoff = POLLING_CFG.quotesWsReconnectBaseMs;
          if (wsTimer) { clearTimeout(wsTimer); wsTimer = null; }
          stopPolling();
          ws.send(JSON.stringify({ type: 'subscribe', symbols: SYMBOLS }));
        };
        ws.onmessage = function(evt) {
          try {
            var data = JSON.parse(evt.data);
            if (data.type === 'snapshot' && Array.isArray(data.quotes)) applyQuotes(data.quotes);
            else if (data.type === 'tick' && data.tick) applyQuote(data.tick);
            else if (data.type === 'ticks' && Array.isArray(data.ticks)) applyQuotes(data.ticks);
          } catch (e) { /* ignore a malformed message */ }
        };
        ws.onclose = function() { startPolling(); scheduleReconnect(); };
        ws.onerror = function() { try { ws.close(); } catch (e) {} };
      }
      document.addEventListener('visibilitychange', function() {
        if (document.visibilityState === "hidden") {
          stopPolling();
          if (wsTimer) { clearTimeout(wsTimer); wsTimer = null; }
        } else if (!ws || ws.readyState > 1) {
          startPolling();
          scheduleReconnect();
        }
      });
      // Toggling the switch in the app (another tab) starts or
      // stops this page's feed without a reload.
      window.addEventListener('storage', function(e) {
        if (e.key && e.key.indexOf('autorefresh_enabled') === -1) return;
        if (autoRefreshEnabled()) { connect(); }
        else { stopLive(); }
      });
      connect();
    })();
  </script>
</body>
</html>`;
}
