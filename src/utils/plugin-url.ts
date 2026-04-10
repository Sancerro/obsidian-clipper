import browser from './browser-polyfill';
import { getErrorMessage } from './error-utils';

export const PLUGIN_URL = 'http://localhost:27124';

export type PluginErrorType = 'offline' | 'timeout' | 'http' | 'background' | 'invalid-response' | 'network';

export interface PluginResponse<T = unknown> {
	ok: boolean;
	status: number;
	statusText?: string;
	data?: T;
	error?: string;
	errorType?: PluginErrorType;
}

/** Fetch from the plugin via background script to bypass page CSP. */
export async function pluginFetch<T = unknown>(
	path: string,
	options?: { method?: string; body?: any; timeoutMs?: number }
): Promise<PluginResponse<T>> {
	try {
		const response = await browser.runtime.sendMessage({
			action: 'pluginFetch',
			url: `${PLUGIN_URL}${path}`,
			method: options?.method,
			body: options?.body,
			timeoutMs: options?.timeoutMs,
		}) as PluginResponse<T> | undefined;

		if (!response || typeof response !== 'object' || typeof response.ok !== 'boolean') {
			return {
				ok: false,
				status: 0,
				error: 'Invalid response from background script',
				errorType: 'invalid-response',
			};
		}

		return response;
	} catch (error) {
		return {
			ok: false,
			status: 0,
			error: getErrorMessage(error, 'Background script unavailable'),
			errorType: 'background',
		};
	}
}

export function getPluginErrorMessage(action: string, response: PluginResponse<unknown>): string {
	const detail = response.error || response.statusText;

	switch (response.errorType) {
		case 'offline':
			return `Could not ${action}: the Obsidian plugin is not reachable on localhost:27124.`;
		case 'timeout':
			return `Could not ${action}: the Obsidian plugin did not respond in time.`;
		case 'background':
			return `Could not ${action}: the extension background script is unavailable.`;
		case 'invalid-response':
			return `Could not ${action}: received an invalid response from the Obsidian plugin.`;
		case 'http':
			return detail
				? `Could not ${action}: ${detail}.`
				: `Could not ${action}: the Obsidian plugin returned HTTP ${response.status}.`;
		case 'network':
			return detail
				? `Could not ${action}: ${detail}.`
				: `Could not ${action}: a network error occurred.`;
		default:
			return detail
				? `Could not ${action}: ${detail}.`
				: `Could not ${action}.`;
	}
}
