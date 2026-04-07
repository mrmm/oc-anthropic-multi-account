/**
 * Text-only UI utilities for CLI output.
 * No emojis - just clean, professional formatting.
 */

export const UI = {
  // Status indicators
  SUCCESS: "[OK]",
  ERROR: "[ERR]",
  WARNING: "[WARN]",
  INFO: "[INFO]",

  // Indentation prefixes
  INDENT: "  ",
  INDENT2: "    ",

  // Divider
  DIVIDER: "─".repeat(40),
};

/**
 * Print a success message (green)
 */
export function success(message: string, indent: number = 0): void {
  const prefix = " ".repeat(indent);
  console.log(`${prefix}${Ansi.GREEN}[OK]${Ansi.RESET} ${message}`);
}

/**
 * Print an error message (red)
 */
export function error(message: string, indent: number = 0): void {
  const prefix = " ".repeat(indent);
  console.error(`${prefix}${Ansi.RED}[ERR]${Ansi.RESET} ${message}`);
}

/**
 * Print a warning message (yellow)
 */
export function warning(message: string, indent: number = 0): void {
  const prefix = " ".repeat(indent);
  console.log(`${prefix}${Ansi.YELLOW}[WARN]${Ansi.RESET} ${message}`);
}

/**
 * Print an info message (cyan)
 */
export function info(message: string, indent: number = 0): void {
  const prefix = " ".repeat(indent);
  console.log(`${prefix}${Ansi.CYAN}[INFO]${Ansi.RESET} ${message}`);
}

/**
 * Print a plain message (no prefix)
 */
export function plain(message: string, indent: number = 0): void {
  const prefix = " ".repeat(indent);
  console.log(`${prefix}${message}`);
}

/**
 * Print a section header
 */
export function header(title: string): void {
  console.log();
  console.log(`  ${title}`);
  console.log(`  ${UI.DIVIDER}`);
  console.log();
}

/**
 * Print a key-value pair
 */
export function kv(
  key: string,
  value: string | number,
  indent: number = 2,
): void {
  const prefix = " ".repeat(indent);
  const paddedKey = key.padEnd(18);
  console.log(`${prefix}${paddedKey} ${value}`);
}

/**
 * Print a list item
 */
export function item(text: string, indent: number = 2): void {
  const prefix = " ".repeat(indent);
  console.log(`${prefix}- ${text}`);
}

/**
 * Print a numbered item
 */
export function numbered(n: number, text: string, indent: number = 2): void {
  const prefix = " ".repeat(indent);
  console.log(`${prefix}${n}. ${text}`);
}

/**
 * Print a divider line
 */
export function divider(indent: number = 0): void {
  const prefix = " ".repeat(indent);
  console.log(`${prefix}${UI.DIVIDER}`);
}

/**
 * Print available accounts list
 */
export function availableAccounts(accounts: string[]): void {
  console.log(`     Available: ${accounts.join(", ") || "none"}`);
}

/**
 * ANSI color codes
 */
export const Ansi = {
  RESET: "\x1b[0m",
  RED: "\x1b[31m",
  GREEN: "\x1b[32m",
  YELLOW: "\x1b[33m",
  CYAN: "\x1b[36m",
  GRAY: "\x1b[2m",
  BOLD: "\x1b[1m",
};

/**
 * Colorize text (returns colored string, doesn't print)
 */
export function colorize(text: string, color: keyof typeof Ansi): string {
  return `${Ansi[color]}${text}${Ansi.RESET}`;
}

/**
 * Format a percentage with color based on value
 */
export function formatPercent(value: number, threshold: number = 0.8): string {
  const pct = Math.round(value * 100);
  if (pct >= threshold * 100) {
    return colorize(`${pct}%`, "RED");
  } else if (pct >= (threshold - 0.1) * 100) {
    return colorize(`${pct}%`, "YELLOW");
  }
  return `${pct}%`;
}

/**
 * Format bytes/KB/MB/GB
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}

/**
 * Format duration in ms
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3600000)
    return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
  return `${Math.floor(ms / 3600000)}h ${Math.floor((ms % 3600000) / 60000)}m`;
}
