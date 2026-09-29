import { build as bundle } from 'esbuild';
import { build, loadConfigFromFile, preview } from 'vite';
import { closeSync, cpSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { cpus, release } from 'node:os';
import { fileIdentity, verifyEmbeddedMpeg2, verifyMpeg2Artifact } from './mpeg2-artifact.js';
import { qualificationScope, readQualificationManifest } from '../test/mpeg2-qualification-manifest.js';

const { values } = parseArgs({ options: {
	'decoder': { type: 'string', default: 'packages/mpeg2/vendor/decoder' },
	'media': { type: 'string' }, 'out': { type: 'string' },
	'paced': { type: 'boolean' }, 'serial': { type: 'boolean' }, 'serve': { type: 'boolean' },
	'timeout-seconds': { type: 'string', default: '420' },
} });
if (!values.media || !values.out) {
	throw new Error('Usage: tsx scripts/qualify-mpeg2.ts --media GENERATED_DIRECTORY --out NEW_DIRECTORY '
		+ '[--decoder COMPLETE_ARTIFACT_DIRECTORY] [--paced] [--serial] [--serve] [--timeout-seconds 1..420]');
}
const out = path.resolve(values.out);
const media = path.resolve(values.media);
const scope = qualificationScope(!!values.paced);
const timeoutSeconds = Number(values['timeout-seconds']);
mkdirSync(out, { recursive: false });
try {
	if (process.platform === 'win32') throw new Error('Qualification process-group cleanup requires POSIX');
	if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 420) {
		throw new Error('--timeout-seconds must be an integer between 1 and 420');
	}
	readQualificationManifest(JSON.parse(readFileSync(path.join(media, 'manifest.json'), 'utf8')), !!values.paced);
} catch (error) {
	writeFileSync(path.join(out, 'report.json'), JSON.stringify({ schema: 1, passed: false, scope, identity: null,
		observations: null, failure: { phase: 'preflight', message: String(error) } }, null, 2) + '\n');
	writeFileSync(path.join(out, 'functional.log'), String(error) + '\n');
	throw error;
}
const directory = path.resolve(values.decoder);
const approved = path.resolve('packages/mpeg2/vendor/decoder');
const pin = JSON.parse(readFileSync('packages/mpeg2/vendor/PROVENANCE.json', 'utf8')) as {
	decoderModuleSha256: string;
};
if (!/^[a-f0-9]{64}$/.test(pin.decoderModuleSha256)) throw new Error('Missing approved MPEG-2 import pin');
const artifact = verifyMpeg2Artifact(directory, directory === approved ? pin.decoderModuleSha256 : undefined);
const extension = path.join(out, 'extension.mjs');
const bundled = await bundle({
	entryPoints: ['packages/mpeg2/src/index.ts'], bundle: true, format: 'esm', target: 'es2022',
	outfile: extension, external: ['mediabunny'], metafile: true,
	plugins: [{ name: 'qualified-decoder', setup(build) {
		build.onResolve({ filter: /vendor\/decoder\/mpeg2-decoder\.mjs$/ }, () => ({ path: artifact.module }));
	} }],
});
if (!Object.keys(bundled.metafile.inputs).some(file => path.resolve(file) === artifact.module)) {
	throw new Error('The consumer build did not consume the selected decoder module');
}
verifyEmbeddedMpeg2(extension, artifact.provenance.binaryInputs);
await bundle({ entryPoints: ['src/index.ts'], bundle: true, format: 'esm', target: 'es2022',
	outfile: path.join(out, 'core.mjs') });
cpSync(path.join(directory, 'PROVENANCE.json'), path.join(out, 'decoder-provenance.json'));
writeFileSync(path.join(out, 'metafile.json'), JSON.stringify(bundled.metafile, null, 2));
const viteConfig = (await loadConfigFromFile({ command: 'build', mode: 'production' }))!.config;
await build({
	...viteConfig, configFile: false,
	resolve: { alias: { ...viteConfig.resolve!.alias,
		'mediabunny': path.join(out, 'core.mjs'), '@mediabunny/mpeg2': extension,
	} },
	build: { ...viteConfig.build, outDir: path.join(out, 'site'), emptyOutDir: false,
		rollupOptions: { input: { 'media-player': path.resolve('examples/media-player/index.html') } },
	},
});
cpSync(media, path.join(out, 'site/media'), { recursive: true });
const playerBundles = Object.fromEntries(readdirSync(path.join(out, 'site/assets'))
	.filter(name => name.endsWith('.js')).map(name => [name, fileIdentity(path.join(out, 'site/assets', name))]));
const playerWithDecoder = Object.keys(playerBundles).filter((name) => {
	try {
		verifyEmbeddedMpeg2(path.join(out, 'site/assets', name), artifact.provenance.binaryInputs);
		return true;
	} catch { return false; }
});
if (playerWithDecoder.length !== 1) throw new Error('Cannot identify the selected decoder in the built player');
const identity = {
	host: { platform: process.platform, architecture: process.arch, release: release(),
		cpu: cpus()[0]?.model, node: process.version },
	consumerRevision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
	consumerSourceFiles: Object.fromEntries(execFileSync('git', ['ls-files', '-z', 'src',
		'packages/mpeg2/src', 'examples/media-player'], { encoding: 'utf8' }).split('\0').filter(Boolean)
		.map(file => [file, fileIdentity(file)])),
	qualificationSourceFiles: Object.fromEntries(['scripts/qualify-mpeg2.ts', 'scripts/mpeg2-artifact.ts',
		'test/mpeg2-qualification.config.ts', 'test/browser/mpeg2-qualification.test.ts',
		'test/mpeg2-qualification-manifest.ts',
		'test/node/generate-mpeg2-qualification.py'].map(file => [file, fileIdentity(file)])),
	decoderDirectory: directory, approvedVendor: directory === approved, decoder: artifact.identity,
	embeddedWasm: { scalar: artifact.provenance.binaryInputs.scalar.derivedWasm,
		shared: artifact.provenance.binaryInputs.shared.derivedWasm },
	consumer: fileIdentity(extension), core: fileIdentity(path.join(out, 'core.mjs')),
	playerBundles, playerWithDecoder, mediaManifest: fileIdentity(path.join(media, 'manifest.json')),
	paced: !!values.paced, serial: !!values.serial,
};
writeFileSync(path.join(out, 'identity.json'), JSON.stringify(identity, null, 2) + '\n');
const logFile = path.join(out, 'functional.log');
const log = openSync(logFile, 'wx');
const child = spawn(process.execPath, ['node_modules/vitest/vitest.mjs', 'run',
	'--config', 'test/mpeg2-qualification.config.ts', '--reporter=default', '--reporter=json',
	`--outputFile=${path.join(out, 'vitest.json')}`], {
	detached: true, stdio: ['ignore', log, log],
	env: { ...process.env, MPEG2_QUALIFICATION_STAGE: out, VITE_MPEG2_QUALIFICATION_MEDIA: media,
		VITE_MPEG2_QUALIFICATION_PACED: values.paced ? '1' : '0',
		MPEG2_QUALIFICATION_SERIAL: values.serial ? '1' : '0' },
});
let termination: 'timeout' | 'SIGINT' | 'SIGTERM' | null = null;
let spawnError: Error | undefined;
const cleanupErrors: string[] = [];
const cleanupWarnings: string[] = [];
const groupMembers = () => execFileSync('ps', ['-axo', 'pid=,pgid=,stat='], {
	encoding: 'utf8', timeout: 2000,
}).trim().split('\n').flatMap((line) => {
	const [pid, group, state] = line.trim().split(/\s+/);
	return Number(group) === child.pid && !state?.startsWith('Z') ? [Number(pid)] : [];
});
const killGroup = (signal: NodeJS.Signals) => {
	if (child.pid === undefined) return;
	try {
		process.kill(-child.pid, signal);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
		try {
			if (groupMembers().length === 0) {
				cleanupWarnings.push(`${String(error)}; no live owned process-group members`);
			} else { cleanupErrors.push(String(error)); }
		} catch (inspectionError) { cleanupErrors.push(String(inspectionError)); }
	}
};
let escalation: ReturnType<typeof setTimeout> | undefined;
const stop = (reason: NonNullable<typeof termination>) => {
	if (termination) return;
	termination = reason;
	killGroup('SIGTERM');
	escalation = setTimeout(() => killGroup('SIGKILL'), 2000);
};
const interrupt = () => stop('SIGINT');
const terminate = () => stop('SIGTERM');
process.on('SIGINT', interrupt);
process.on('SIGTERM', terminate);
const deadline = setTimeout(() => stop('timeout'), timeoutSeconds * 1000);
let remainingProcessIds: number[] = [];
const status = await new Promise<number | null>((resolve) => {
	child.once('error', (error) => {
		spawnError = error;
	});
	child.once('close', resolve);
}).finally(async () => {
	clearTimeout(deadline);
	clearTimeout(escalation);
	killGroup('SIGKILL'); // Also remove any remaining descendants after runner exit.
	try {
		const cleanupDeadline = Date.now() + 2000;
		do {
			remainingProcessIds = groupMembers();
			if (remainingProcessIds.length === 0) break;
			await new Promise(resolve => setTimeout(resolve, 50));
		} while (Date.now() < cleanupDeadline);
		if (remainingProcessIds.length) {
			cleanupErrors.push(`Live owned processes remain: ${remainingProcessIds.join(', ')}`);
		}
	} catch (error) { cleanupErrors.push(String(error)); }
	closeSync(log);
	process.off('SIGINT', interrupt);
	process.off('SIGTERM', terminate);
});
const output = readFileSync(logFile, 'utf8');
const observation = output.match(/MPEG2_QUALIFICATION (\{[^\n]+\})/);
const passed = status === 0 && !!observation && !termination && !spawnError && cleanupErrors.length === 0;
writeFileSync(path.join(out, 'report.json'), JSON.stringify({ schema: 1, identity, scope, passed,
	observations: observation ? JSON.parse(observation[1]!) as unknown : null,
	runner: { status, termination, timeoutSeconds, processGroupId: child.pid,
		spawnError: spawnError?.message, cleanupErrors, cleanupWarnings, remainingProcessIds },
	limits: 'This report covers packaged sink behavior. Player UI, compositor drops, acoustic A/V sync, '
		+ 'whole-process memory and production-duration qualification require separate evidence.',
}, null, 2) + '\n');
process.stdout.write(output);
if (!passed) {
	console.error('Qualification failed:', { termination, status, error: spawnError?.message, cleanupErrors });
	process.exit(termination === 'SIGINT' ? 130 : termination === 'SIGTERM' ? 143 : 1);
}
if (values.serve) {
	const server = await preview({ configFile: false, build: { outDir: path.join(out, 'site') },
		preview: { host: '127.0.0.1', port: 0, headers: values.serial
			? {}
			: {
					'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp',
				} },
	});
	server.printUrls();
	for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => server.httpServer.close());
}
