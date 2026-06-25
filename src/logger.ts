export type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let currentLogLevel = 1; // default to info

export function initLogger(level: string): void {
  const normalized = level.toLowerCase() as LogLevel;
  if (normalized in LOG_LEVELS) {
    currentLogLevel = LOG_LEVELS[normalized];
  }
}

export const logger = {
  debug(msg: string, ...args: unknown[]) {
    if (currentLogLevel <= LOG_LEVELS.debug) {
      console.log(`[DEBUG] ${msg}`, ...args);
    }
  },
  info(msg: string, ...args: unknown[]) {
    if (currentLogLevel <= LOG_LEVELS.info) {
      console.log(`[INFO] ${msg}`, ...args);
    }
  },
  warn(msg: string, ...args: unknown[]) {
    if (currentLogLevel <= LOG_LEVELS.warn) {
      console.warn(`[WARN] ${msg}`, ...args);
    }
  },
  error(msg: string, ...args: unknown[]) {
    if (currentLogLevel <= LOG_LEVELS.error) {
      console.error(`[ERROR] ${msg}`, ...args);
    }
  },
};
