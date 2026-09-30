/// <reference types="@vitest/browser/providers/webdriverio" />

import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
	server: {
		headers: {
			'Cross-Origin-Opener-Policy': 'same-origin',
			'Cross-Origin-Embedder-Policy': 'require-corp',
		},
	},
	resolve: { alias: {
		'mediabunny': path.resolve('src/index.ts'),
		'@mediabunny/mpeg2': path.resolve('packages/mpeg2/dist/bundles/mediabunny-mpeg2.mjs'),
	} },
	test: {
		include: ['test/mpeg2-browser/**/*.test.ts'],
		browser: {
			enabled: true,
			provider: 'webdriverio',
			instances: [{ browser: 'chrome', capabilities: {
				'wdio:chromedriverOptions': { cacheDir: path.resolve('node_modules/.cache/webdriver') },
			} }],
			headless: false,
			screenshotFailures: false,
		},
	},
});
