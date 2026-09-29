import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from 'node:fs';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

const manifest = () => ({ cases: ['progressive420', 'top422', 'bottom422'].map((name) => {
	const progressive = name === 'progressive420';
	const duration = progressive ? 30 : 2;
	const frames = duration * 25;
	return { name, file: `${name}.mxf`, width: progressive ? 1280 : 1920, height: progressive ? 720 : 1080,
		duration, frames, format: progressive ? 'I420' : 'I422',
		scan: progressive ? 'progressive' : name === 'top422' ? 'interlaced-top-first' : 'interlaced-bottom-first',
		sha256: '0'.repeat(64), references: Object.fromEntries([0, Math.floor(frames / 2), frames - 1]
			.map(ordinal => [ordinal, `${name}-${ordinal}.rgba`])),
		packets: Array.from({ length: frames }, (_, ordinal) => ({
			timestamp: ordinal / 25, duration: 1 / 25, sha256: '0'.repeat(64),
		})),
	};
}) });

describe('given the consumer qualification CLI', () => {
	describe('when its manifest cannot qualify the required matrix', () => {
		it.each([
			['empty matrix', (input: ReturnType<typeof manifest>) => { input.cases = []; }, 'required matrix'],
			['missing field order', (input) => { input.cases.pop(); }, 'required matrix'],
			['duplicate case', (input) => { input.cases[2] = input.cases[1]!; }, 'required matrix'],
			['wrong geometry', (input) => { input.cases[0]!.width = 1920; }, 'dimensions, format or scan'],
			['nonpositive frames', (input) => { input.cases[0]!.frames = 0; }, 'frame count'],
			['nonfinite duration', (input) => { input.cases[0]!.duration = Infinity; }, 'duration'],
			['short duration', (input) => { input.cases[0]!.duration = 29; }, 'duration'],
			['missing packets', (input) => { input.cases[0]!.packets.pop(); }, 'packet count'],
			['duplicate timestamp', (input) => { input.cases[0]!.packets[1]!.timestamp = 0; }, 'packet timestamps'],
			['invalid hash', (input) => { input.cases[0]!.packets[0]!.sha256 = 'invalid'; }, 'SHA-256'],
			['missing last reference', (input) => { delete input.cases[0]!.references[749]; }, 'RGBA references'],
		] satisfies [string, (input: ReturnType<typeof manifest>) => void, string][])(
			'should reject %s before building or emitting a passing result', (_name, mutate, message) => {
				const temporary = mkdtempSync(path.join(tmpdir(), 'mpeg2-qualification-'));
				try {
					const input = manifest();
					mutate(input);
					writeFileSync(path.join(temporary, 'manifest.json'), JSON.stringify(input));
					const out = path.join(temporary, 'result');
					const result = spawnSync(process.execPath, ['node_modules/tsx/dist/cli.mjs',
						'scripts/qualify-mpeg2.ts', '--media', temporary, '--out', out],
					{ encoding: 'utf8', timeout: 10_000 });
					expect(result.status).toBe(1);
					expect(JSON.parse(readFileSync(path.join(out, 'report.json'), 'utf8'))).toMatchObject({
						passed: false, observations: null, scope: { realTimeAcceptance: false },
						failure: { phase: 'preflight' },
					});
					expect(result.stderr).toContain(message);
					expect(result.stdout).not.toContain('MPEG2_QUALIFICATION');
					expect(existsSync(path.join(out, 'extension.mjs'))).toBe(false);
				} finally { rmSync(temporary, { recursive: true, force: true }); }
			},
		);

		it('should reject a 30-second matrix for a formal paced run', () => {
			const temporary = mkdtempSync(path.join(tmpdir(), 'mpeg2-qualification-paced-'));
			try {
				writeFileSync(path.join(temporary, 'manifest.json'), JSON.stringify(manifest()));
				const result = spawnSync(process.execPath, ['node_modules/tsx/dist/cli.mjs',
					'scripts/qualify-mpeg2.ts', '--media', temporary, '--out', path.join(temporary, 'result'),
					'--paced'],
				{ encoding: 'utf8', timeout: 10_000 });
				expect(result.status).toBe(1);
				expect(result.stderr).toContain('duration must be 120..120 seconds');
				expect(result.stdout).not.toContain('MPEG2_QUALIFICATION');
			} finally { rmSync(temporary, { recursive: true, force: true }); }
		});
	});

	describe.skipIf(process.platform === 'win32')('when the owned browser driver stalls during startup', () => {
		it.each([
			'timeout', 'SIGTERM',
		] as const)('should retain a failed report and kill its process group on %s', async (reason) => {
			const temporary = mkdtempSync(path.join(tmpdir(), 'mpeg2-qualification-timeout-'));
			try {
				const media = path.join(temporary, 'media');
				mkdirSync(media);
				writeFileSync(path.join(media, 'manifest.json'), JSON.stringify(manifest()));
				const pidFile = path.join(temporary, 'driver.pid');
				const childPidFile = path.join(temporary, 'driver-child.pid');
				const driver = path.join(temporary, 'driver');
				writeFileSync(driver, [
					`#!${process.execPath}`,
					`if (process.argv.includes('--version')) {`,
					`console.log('Google Chrome 154.0.8037.58'); process.exit(); }`,
					`require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
					`const child = require('node:child_process').spawn(process.execPath, ['-e',`,
					`'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)']);`,
					`require('node:fs').writeFileSync(${JSON.stringify(childPidFile)}, String(child.pid));`,
					`process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);`,
				].join('\n'), { mode: 0o755 });
				const out = path.join(temporary, 'result');
				const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/qualify-mpeg2.ts',
					'--media', media, '--out', out, '--timeout-seconds', reason === 'timeout' ? '5' : '20'],
				{ stdio: 'ignore', timeout: 30_000,
					env: { ...process.env, CHROMEDRIVER_PATH: driver, CHROME_PATH: driver } });
				const watcher = watch(temporary, () => {
					if (reason === 'SIGTERM' && existsSync(childPidFile)) {
						watcher.close();
						child.kill('SIGTERM');
					}
				});
				const status = await new Promise<number | null>((resolve, reject) => {
					child.once('error', reject);
					child.once('close', resolve);
				}).finally(() => watcher.close());
				expect(status).toBe(reason === 'timeout' ? 1 : 143);
				expect(JSON.parse(readFileSync(path.join(out, 'report.json'), 'utf8'))).toMatchObject({
					passed: false, observations: null, runner: { termination: reason, cleanupErrors: [] },
				});
				expect(readFileSync(path.join(out, 'functional.log'), 'utf8')).toContain('RUN');
				const pids = [pidFile, childPidFile].map(file => Number(readFileSync(file, 'utf8')));
				const running = execFileSync('ps', ['-axo', 'pid=,stat='], { encoding: 'utf8' }).trim().split('\n')
					.some(line => pids.includes(Number(line.trim().split(/\s+/)[0])) && !line.includes('Z'));
				expect(running).toBe(false);
			} finally { rmSync(temporary, { recursive: true, force: true }); }
		}, 40_000);
	});
});
