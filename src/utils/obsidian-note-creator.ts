import browser from './browser-polyfill';
import { sanitizeFileName } from '../utils/string-utils';
import { generateFrontmatter as generateFrontmatterCore } from './shared';
import { Template, Property } from '../types/types';
import { generalSettings, incrementStat } from './storage-utils';
import { copyToClipboard } from './clipboard-utils';
import { getMessage } from './i18n';
import { AppError, getErrorMessage, logHandledError } from './error-utils';

export async function generateFrontmatter(properties: Property[]): Promise<string> {
	const typeMap: Record<string, string> = {};
	for (const pt of generalSettings.propertyTypes) {
		typeMap[pt.name] = pt.type;
	}
	return generateFrontmatterCore(properties, typeMap);
}

function tryWindowOpen(url: string): boolean {
	try {
		return window.open(url, '_blank') !== null;
	} catch {
		return false;
	}
}

async function openObsidianUrl(url: string): Promise<void> {
	let lastError: string | null = null;

	try {
		const response = await browser.runtime.sendMessage({
			action: "openObsidianUrl",
			url: url
		}) as { success?: boolean; error?: string } | undefined;

		if (response?.success) return;
		lastError = response?.error || 'Background script failed to open the Obsidian URL';
	} catch (error) {
		lastError = getErrorMessage(error, 'Background script failed to open the Obsidian URL');
	}

	logHandledError('ObsidianOpen', lastError || 'Unknown Obsidian URL error', { url });
	if (tryWindowOpen(url)) return;

	throw new AppError({
		code: 'OBSIDIAN_OPEN_FAILED',
		message: `Unable to open Obsidian URL: ${lastError || 'window.open failed'}`,
		userMessage: 'Could not hand off the note to Obsidian. Make sure Obsidian is installed and that the obsidian:// protocol is allowed.',
		details: lastError || undefined,
	});
}

async function tryClipboardWrite(fileContent: string, obsidianUrl: string): Promise<void> {
	const success = await copyToClipboard(fileContent);
	
	if (success) {
		// &clipboard tells Obsidian to read data from clipboard instead of the content param.
		// content is a fallback shown only if Obsidian can't access the clipboard (e.g. on Linux).
		obsidianUrl += `&clipboard&content=${encodeURIComponent(getMessage('clipboardError', 'https://help.obsidian.md/web-clipper/troubleshoot'))}`;
		await openObsidianUrl(obsidianUrl);
		console.log('Obsidian URL:', obsidianUrl);
	} else {
		logHandledError('ClipboardWrite', 'Clipboard write failed, falling back to URI payload');
		// Final fallback: use URI method with actual content (same as legacy mode)
		// Note: We don't add &clipboard here since we're bypassing the clipboard entirely
		obsidianUrl += `&content=${encodeURIComponent(fileContent)}`;
		await openObsidianUrl(obsidianUrl);
		console.log('Obsidian URL (URI fallback):', obsidianUrl);
	}
}

export async function saveToObsidian(
	fileContent: string,
	noteName: string,
	path: string,
	vault: string,
	behavior: Template['behavior'],
): Promise<void> {
	let obsidianUrl: string;

	const isDailyNote = behavior === 'append-daily' || behavior === 'prepend-daily';

	if (isDailyNote) {
		obsidianUrl = `obsidian://daily?`;
	} else {
		// Ensure path ends with a slash
		if (path && !path.endsWith('/')) {
			path += '/';
		}

		const formattedNoteName = sanitizeFileName(noteName);
		obsidianUrl = `obsidian://new?file=${encodeURIComponent(path + formattedNoteName)}`;
	}

	if (behavior.startsWith('append')) {
		obsidianUrl += '&append=true';
	} else if (behavior.startsWith('prepend')) {
		obsidianUrl += '&prepend=true';
	} else if (behavior === 'overwrite') {
		obsidianUrl += '&overwrite=true';
	}

	const vaultParam = vault ? `&vault=${encodeURIComponent(vault)}` : '';
	obsidianUrl += vaultParam;

	// Add silent parameter if silentOpen is enabled
	if (generalSettings.silentOpen) {
		obsidianUrl += '&silent=true';
	}

	if (generalSettings.legacyMode) {
		// Use the URI method
		obsidianUrl += `&content=${encodeURIComponent(fileContent)}`;
		console.log('Obsidian URL:', obsidianUrl);
		await openObsidianUrl(obsidianUrl);
	} else {
		// Try to copy to clipboard with fallback mechanisms
		await tryClipboardWrite(fileContent, obsidianUrl);
	}
}
