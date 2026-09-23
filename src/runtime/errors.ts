import type {
  ProviderError,
  ProviderErrorCode,
} from '../core/types.js';

export class ProviderRuntimeError extends Error {
  readonly code: ProviderErrorCode;
  readonly debugMessage?: string;
  readonly httpStatus?: number;
  readonly localized: boolean;
  readonly retryAfterSeconds?: number;
  readonly retryable: boolean;

  constructor(
    code: ProviderErrorCode,
    message: string,
    options: {
      cause?: unknown;
      debugMessage?: string;
      httpStatus?: number;
      localized?: boolean;
      retryAfterSeconds?: number;
      retryable?: boolean;
    } = {},
  ) {
    super(message, {cause: options.cause});
    this.name = 'ProviderRuntimeError';
    this.code = code;
    this.debugMessage = options.debugMessage;
    this.httpStatus = options.httpStatus;
    this.localized = options.localized ?? false;
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.retryable = options.retryable ?? true;
  }

  toProviderError(): ProviderError {
    return {
      code: this.code,
      httpStatus: this.httpStatus,
      retryAfterSeconds: this.retryAfterSeconds,
      message: this.message,
      debugMessage: this.debugMessage,
      localized: this.localized,
      retryable: this.retryable,
    };
  }
}

export function normalizeProviderError(caught: unknown): ProviderError {
  if (caught instanceof ProviderRuntimeError)
    return caught.toProviderError();

  if (caught instanceof Error) {
    return {
      code: 'internal',
      message: caught.message,
      debugMessage: caught.stack,
      retryable: true,
    };
  }

  return {
    code: 'internal',
    message: String(caught),
    retryable: true,
  };
}
