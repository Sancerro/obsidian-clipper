import browser from './browser-polyfill';

export const PLUGIN_URL = 'http://localhost:27124';

interface PluginResponse {
	ok: boolean;
	status: number;
	data?: any;
	error?: string;
}

/** Fetch from the plugin via background script to bypass page CSP. */
export async function pluginFetch(path: string, options?: { method?: string; body?: any }): Promise<PluginResponse> {
	return browser.runtime.sendMessage({
		action: 'pluginFetch',
		url: `${PLUGIN_URL}${path}`,
		method: options?.method,
		body: options?.body,
	}) as Promise<PluginResponse>;
}
