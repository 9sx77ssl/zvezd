import { type DestinationStream, type Logger as PinoLogger, pino } from 'pino';
import pretty from 'pino-pretty';

export type LogContext = Record<string, unknown>;

export interface LoggerOptions {
  level: string;
  pretty: boolean;
}

/**
 * Thin OOP wrapper around pino that guarantees every log line carries the
 * originating module. Instances are immutable and cheap to `child()`.
 */
export class Logger {
  private readonly pino: PinoLogger;

  private constructor(pinoInstance: PinoLogger) {
    this.pino = pinoInstance;
  }

  static create(options: LoggerOptions): Logger {
    const stream = options.pretty
      ? pretty({
          colorize: true,
          translateTime: 'SYS:HH:MM:ss.l',
          ignore: 'pid,hostname',
          messageFormat: '{module} {msg}',
        })
      : undefined;

    const instance = pino(
      {
        level: options.level,
        base: undefined,
        timestamp: pino.stdTimeFunctions.isoTime,
      },
      stream as unknown as DestinationStream,
    );

    return new Logger(instance);
  }

  /** Create a namespaced child logger, e.g. `log.child('ForumClient')`. */
  child(module: string, context: LogContext = {}): Logger {
    return new Logger(this.pino.child({ module, ...context }));
  }

  trace(message: string, context?: LogContext): void {
    this.pino.trace(context ?? {}, message);
  }

  debug(message: string, context?: LogContext): void {
    this.pino.debug(context ?? {}, message);
  }

  info(message: string, context?: LogContext): void {
    this.pino.info(context ?? {}, message);
  }

  warn(message: string, context?: LogContext): void {
    this.pino.warn(context ?? {}, message);
  }

  error(message: string, context?: LogContext): void {
    this.pino.error(context ?? {}, message);
  }

  fatal(message: string, context?: LogContext): void {
    this.pino.fatal(context ?? {}, message);
  }
}

/** Serialize an unknown thrown value for structured logging. */
export function errorToLog(err: unknown): LogContext {
  if (err instanceof Error) {
    return {
      error: {
        name: err.name,
        message: err.message,
        code: (err as { code?: string }).code,
        stack: err.stack,
      },
    };
  }
  return { error: String(err) };
}
