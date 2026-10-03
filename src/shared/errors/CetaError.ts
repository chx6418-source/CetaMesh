import type {CorrelationContext} from '../index';
import type {CetaErrorCode} from './CetaErrorCode';

export type CetaErrorOptions = {
  readonly context?: CorrelationContext;
  readonly cause?: unknown;
};

export class CetaError extends Error {
  readonly code: CetaErrorCode;
  readonly context: CorrelationContext;
  readonly cause?: unknown;

  constructor(code: CetaErrorCode, message: string, options: CetaErrorOptions = {}) {
    super(message);
    this.name = 'CetaError';
    this.code = code;
    this.context = options.context ?? {};
    this.cause = options.cause;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

