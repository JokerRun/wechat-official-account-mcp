export enum LogLevel {
  TRACE = 0,
  DEBUG = 1,
  INFO = 2,
  WARN = 3,
  ERROR = 4,
}

class Logger {
  private level: LogLevel = LogLevel.INFO;
  private silent: boolean = false;

  setLevel(level: LogLevel) {
    this.level = level;
  }

  setSilent(silent: boolean) {
    this.silent = silent;
  }

  private log(level: LogLevel, message: string, ...args: unknown[]) {
    if (this.silent) return;
    if (level >= this.level) {
      const timestamp = new Date().toISOString();
      const levelName = LogLevel[level];
      console.error(`[${timestamp}] [${levelName}] ${message}`, ...args);
    }
  }

  trace(message: string, ...args: unknown[]) {
    this.log(LogLevel.TRACE, message, ...args);
  }

  debug(message: string, ...args: unknown[]) {
    this.log(LogLevel.DEBUG, message, ...args);
  }

  info(message: string, ...args: unknown[]) {
    this.log(LogLevel.INFO, message, ...args);
  }

  warn(message: string, ...args: unknown[]) {
    this.log(LogLevel.WARN, message, ...args);
  }

  error(message: string, ...args: unknown[]) {
    this.log(LogLevel.ERROR, message, ...args);
  }
}

export const logger = new Logger();