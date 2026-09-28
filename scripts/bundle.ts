import * as esbuild from 'esbuild';
import process from 'node:process';
import { cpSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import PluginExternalGlobal from 'esbuild-plugin-external-global';
import { inlineWorkerPlugin } from './esbuild/inlined-workers.js';

/** Creates UMD and ESM variants, each unminified and minified. */
const createVariants = async (
	entryPoint: string,
	globalName: string,
	outfileBase: string,
	umdExtension: string,
	specificUmdConfig: esbuild.BuildOptions = {},
	specificEsmConfig: esbuild.BuildOptions = {},
	nodeUmdVariant = false,
) => {
	const baseConfig: esbuild.BuildOptions = {
		entryPoints: [entryPoint],
		bundle: true,
		logLevel: 'info',
		target: 'es2021',
		logOverride: {
			'import-is-undefined': 'silent', // Warning caused by the disabled "node.ts" import
		},
		banner: {
			js: `/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */`,
		},
		legalComments: 'none',
	};

	const umdConfig: esbuild.BuildOptions = {
		...baseConfig,
		format: 'iife',
		globalName,
		footer: {
			js:
`if (typeof module === "object" && typeof module.exports === "object") Object.assign(module.exports, ${globalName})`,
		},
	};

	const esmConfig: esbuild.BuildOptions = {
		...baseConfig,
		format: 'esm',
	};

	const umdVariant = await esbuild.context({
		...umdConfig,
		...specificUmdConfig,
		outfile: `${outfileBase}.${umdExtension}`,
	});

	const esmVariant = await esbuild.context({
		...esmConfig,
		...specificEsmConfig,
		outfile: `${outfileBase}.mjs`,
	});

	const umdMinifiedVariant = await esbuild.context({
		...umdConfig,
		...specificUmdConfig,
		outfile: `${outfileBase}.min.${umdExtension}`,
		minify: true,
	});

	const esmMinifiedVariant = await esbuild.context({
		...esmConfig,
		...specificEsmConfig,
		outfile: `${outfileBase}.min.mjs`,
		minify: true,
	});

	const variants = [umdVariant, esmVariant, umdMinifiedVariant, esmMinifiedVariant];

	if (nodeUmdVariant) {
		const nodeVariant = await esbuild.context({
			...umdConfig,
			...specificUmdConfig,
			outfile: `${outfileBase}.node.${umdExtension}`,
			platform: 'node', // This is different
		});
		variants.push(nodeVariant);
	}

	return variants;
};

const mediabunnyVariants = await createVariants(
	'src/index.ts',
	'Mediabunny',
	'dist/bundles/mediabunny',
	'cjs',
	undefined,
	undefined,
	true,
);

const mp3EncoderVariants = await createVariants(
	'packages/mp3-encoder/src/index.ts',
	'MediabunnyMp3Encoder',
	'packages/mp3-encoder/dist/bundles/mediabunny-mp3-encoder',
	'js', // The bundles are purely for the browser, not for Node (due to the peer dependency)
	{
		plugins: [
			PluginExternalGlobal.externalGlobalPlugin({
				mediabunny: 'Mediabunny',
			}),
			inlineWorkerPlugin({
				define: {
					'import.meta.url': '""',
				},
				legalComments: 'none',
			}),
		],
	},
	{
		external: ['mediabunny'],
		plugins: [
			inlineWorkerPlugin({
				define: {
					'import.meta.url': '""',
				},
				legalComments: 'none',
			}),
		],
	},
);

const ac3Variants = await createVariants(
	'packages/ac3/src/index.ts',
	'MediabunnyAc3',
	'packages/ac3/dist/bundles/mediabunny-ac3',
	'js', // The bundles are purely for the browser, not for Node (due to the peer dependency)
	{
		plugins: [
			PluginExternalGlobal.externalGlobalPlugin({
				mediabunny: 'Mediabunny',
			}),
			inlineWorkerPlugin({
				define: {
					'import.meta.url': '""',
				},
				legalComments: 'none',
			}),
		],
	},
	{
		external: ['mediabunny'],
		plugins: [
			inlineWorkerPlugin({
				define: {
					'import.meta.url': '""',
				},
				legalComments: 'none',
			}),
		],
	},
);

const dtsVariants = await createVariants(
	'packages/dts/src/index.ts',
	'MediabunnyDts',
	'packages/dts/dist/bundles/mediabunny-dts',
	'js', // The bundles are purely for the browser, not for Node (due to the peer dependency)
	{
		plugins: [
			PluginExternalGlobal.externalGlobalPlugin({
				mediabunny: 'Mediabunny',
			}),
			inlineWorkerPlugin({
				define: {
					'import.meta.url': '""',
				},
				legalComments: 'none',
			}),
		],
	},
	{
		external: ['mediabunny'],
		plugins: [
			inlineWorkerPlugin({
				define: {
					'import.meta.url': '""',
				},
				legalComments: 'none',
			}),
		],
	},
);

const aacEncoderVariants = await createVariants(
	'packages/aac-encoder/src/index.ts',
	'MediabunnyAacEncoder',
	'packages/aac-encoder/dist/bundles/mediabunny-aac-encoder',
	'js', // The bundles are purely for the browser, not for Node (due to the peer dependency)
	{
		plugins: [
			PluginExternalGlobal.externalGlobalPlugin({
				mediabunny: 'Mediabunny',
			}),
			inlineWorkerPlugin({
				define: {
					'import.meta.url': '""',
				},
				legalComments: 'none',
			}),
		],
	},
	{
		external: ['mediabunny'],
		plugins: [
			inlineWorkerPlugin({
				define: {
					'import.meta.url': '""',
				},
				legalComments: 'none',
			}),
		],
	},
);

const flacEncoderVariants = await createVariants(
	'packages/flac-encoder/src/index.ts',
	'MediabunnyFlacEncoder',
	'packages/flac-encoder/dist/bundles/mediabunny-flac-encoder',
	'js', // The bundles are purely for the browser, not for Node (due to the peer dependency)
	{
		plugins: [
			PluginExternalGlobal.externalGlobalPlugin({
				mediabunny: 'Mediabunny',
			}),
			inlineWorkerPlugin({
				define: {
					'import.meta.url': '""',
				},
				legalComments: 'none',
			}),
		],
	},
	{
		external: ['mediabunny'],
		plugins: [
			inlineWorkerPlugin({
				define: {
					'import.meta.url': '""',
				},
				legalComments: 'none',
			}),
		],
	},
);

const proresVariants = await createVariants(
	'packages/prores/src/index.ts',
	'MediabunnyProres',
	'packages/prores/dist/bundles/mediabunny-prores',
	'js', // The bundles are purely for the browser, not for Node (due to the peer dependency)
	{
		plugins: [
			PluginExternalGlobal.externalGlobalPlugin({
				mediabunny: 'Mediabunny',
			}),
		],
	},
	{
		external: ['mediabunny'],
		platform: 'node', // To retain the Node imports
	},
);

const htj2kNotices = readdirSync('packages/htj2k/vendor').filter(name => name.startsWith('LICENSE'))
	.map(name => `/* ${name}\n${readFileSync(`packages/htj2k/vendor/${name}`, 'utf8').replaceAll('*/', '* /')}\n*/`)
	.join('\n');
const htj2kVariants = await createVariants(
	'packages/htj2k/src/index.ts',
	'MediabunnyHtj2k',
	'packages/htj2k/dist/bundles/mediabunny-htj2k',
	'js',
	{
		loader: { '.wasm': 'binary' },
		external: ['node:*'],
		define: { 'import.meta.url': '""' },
		banner: { js: htj2kNotices },
		plugins: [PluginExternalGlobal.externalGlobalPlugin({ mediabunny: 'Mediabunny' })],
	},
	{
		loader: { '.wasm': 'binary' },
		external: ['mediabunny', 'node:*'],
		platform: 'neutral',
		banner: { js: htj2kNotices },
	},
);

const mpeg2Notice = `/* Private local integration. NOT FOR PUBLIC DISTRIBUTION.
 * MPEG-2 Rust/WASM and generated vendor files have no selected project license.
 * MPL-2.0 applies only to the Mediabunny adapter source. See packages/mpeg2/vendor/PROVENANCE.json.
 * Default WASM numerical version: h262-butterfly-q14-q5-v1. Native f64 is unchanged.
 * WASM SHA-256: c06ed93c42aa17dfe45bcad2e55b6d14fca5e0c07b5bca1cc469b52999407b9b
 */`;

const mpeg2WorkerPlugin: esbuild.Plugin = {
	name: 'embedded-mpeg2-worker',
	setup(build) {
		build.onResolve({ filter: /^#mpeg2-worker-source$/ }, () => ({
			path: 'mpeg2-worker', namespace: 'embedded-mpeg2-worker',
		}));
		build.onLoad({ filter: /.*/, namespace: 'embedded-mpeg2-worker' }, async () => {
			const worker = await esbuild.build({
				entryPoints: ['packages/mpeg2/src/worker-entry.ts'],
				bundle: true, write: false, metafile: true, format: 'iife', platform: 'browser', target: 'es2021',
				loader: { '.wasm': 'binary' }, banner: { js: mpeg2Notice }, legalComments: 'inline',
				define: { 'import.meta.url': '""' },
			});
			return {
				contents: `export default ${JSON.stringify(worker.outputFiles[0]!.text)};`,
				loader: 'js', watchFiles: Object.keys(worker.metafile.inputs),
			};
		});
	},
};
const mpeg2Variants = await createVariants(
	'packages/mpeg2/src/index.ts',
	'MediabunnyMpeg2',
	'packages/mpeg2/dist/bundles/mediabunny-mpeg2',
	'js',
	{
		loader: { '.wasm': 'binary' },
		define: { 'import.meta.url': '""' },
		banner: { js: mpeg2Notice },
		legalComments: 'inline',
		plugins: [mpeg2WorkerPlugin, PluginExternalGlobal.externalGlobalPlugin({ mediabunny: 'Mediabunny' })],
	},
	{
		loader: { '.wasm': 'binary' },
		external: ['mediabunny'],
		platform: 'neutral',
		banner: { js: mpeg2Notice },
		legalComments: 'inline',
		plugins: [mpeg2WorkerPlugin],
	},
);

// Preserve import.meta.url and Rayon snippet paths in the separately served private runtime.
rmSync('packages/mpeg2/dist/threads', { recursive: true, force: true });
cpSync('packages/mpeg2/vendor/threads', 'packages/mpeg2/dist/threads', { recursive: true });

const serverVariants = await createVariants(
	'packages/server/src/index.ts',
	'MediabunnyServer',
	'packages/server/dist/bundles/mediabunny-server',
	'cjs',
	{
		platform: 'node',
		packages: 'external',
		external: ['mediabunny'],
	},
	{
		platform: 'node',
		packages: 'external',
		external: ['mediabunny'],
	},
);

const contexts = [
	...mediabunnyVariants,
	...mp3EncoderVariants,
	...ac3Variants,
	...dtsVariants,
	...aacEncoderVariants,
	...flacEncoderVariants,
	...proresVariants,
	...htj2kVariants,
	...mpeg2Variants,
	...serverVariants,
];

if (process.argv[2] === '--watch') {
	await Promise.all(contexts.map(ctx => ctx.watch()));
} else {
	for (const ctx of contexts) {
		await ctx.rebuild();
		await ctx.dispose();
	}
}
