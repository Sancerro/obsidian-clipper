export class AppError extends Error {
	code: string;
	userMessage: string;
	details?: string;
	cause?: unknown;

	constructor(options: {
		code: string;
		message: string;
		userMessage: string;
		details?: string;
		cause?: unknown;
	}) {
		super(options.message);
		this.name = 'AppError';
		this.code = options.code;
		this.userMessage = options.userMessage;
		this.details = options.details;
		this.cause = options.cause;
	}
}

export function isAppError(error: unknown): error is AppError {
	return error instanceof AppError;
}

export function getErrorMessage(error: unknown, fallback = 'Unknown error'): string {
	if (typeof error === 'string') return error;
	if (error instanceof Error) return error.message || fallback;
	if (error && typeof error === 'object') {
		try {
			return JSON.stringify(error);
		} catch {
			return fallback;
		}
	}
	return fallback;
}

export function getUserFacingError(error: unknown, fallback: string): string {
	if (isAppError(error)) return error.userMessage;
	return getErrorMessage(error, fallback);
}

export function logHandledError(scope: string, error: unknown, details?: Record<string, unknown>): void {
	if (details) {
		console.warn(`[${scope}] ${getErrorMessage(error)}`, details, error);
		return;
	}
	console.warn(`[${scope}] ${getErrorMessage(error)}`, error);
}
