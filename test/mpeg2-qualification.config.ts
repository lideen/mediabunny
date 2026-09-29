import { defineConfig } from 'vitest/config';
import path from 'node:path';

const stage = process.env['MPEG2_QUALIFICATION_STAGE'];
const media = process.env['VITE_MPEG2_QUALIFICATION_MEDIA'];
if (!stage || !media) throw new Error('Use scripts/qualify-mpeg2.ts to stage the exact consumer artifacts first');

export default defineConfig({
	server: {
		fs: { allow: [process.cwd(), stage, media] },
		headers: process.env['MPEG2_QUALIFICATION_SERIAL'] === '1'
			? {}
			: {
					'Cross-Origin-Opener-Policy': 'same-origin',
					'Cross-Origin-Embedder-Policy': 'require-corp',
				},
	},
	resolve: { alias: {
		'mediabunny': path.join(stage, 'core.mjs'),
		'@mediabunny/mpeg2': path.join(stage, 'extension.mjs'),
	} },
	test: {
		include: ['test/browser/mpeg2-qualification.test.ts'],
		browser: {
			enabled: true,
			provider: 'webdriverio',
			instances: [{ browser: 'chrome', capabilities: {
				'goog:chromeOptions': { binary: process.env['CHROME_PATH'] },
			} }],
			headless: false,
			screenshotFailures: false,
		},
	},
});
