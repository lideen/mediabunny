import { describe, expect, it } from 'vitest';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileIdentity, verifyMpeg2Artifact } from '../../scripts/mpeg2-artifact.js';
import imported from '../../packages/mpeg2/vendor/PROVENANCE.json' with { type: 'json' };

describe('given a complete standalone MPEG-2 artifact', () => {
	it('should reject unsupported provenance, unapproved modules and changed embedded WASM', () => {
		const directory = path.resolve('packages/mpeg2/vendor/decoder');
		expect(verifyMpeg2Artifact(directory, imported.decoderModuleSha256).identity.sha256)
			.toBe(imported.decoderModuleSha256);
		expect(() => verifyMpeg2Artifact(directory, '0'.repeat(64))).toThrow('approved import pin');
		const temporary = mkdtempSync(path.resolve('node_modules/.mpeg2-artifact-'));
		try {
			cpSync(directory, temporary, { recursive: true });
			const file = path.join(temporary, 'PROVENANCE.json');
			const provenance = JSON.parse(readFileSync(file, 'utf8')) as {
				schema: number;
				outputs: Record<string, ReturnType<typeof fileIdentity>>;
			};
			writeFileSync(file, JSON.stringify({ ...provenance, schema: 1 }));
			expect(() => verifyMpeg2Artifact(temporary)).toThrow('Unsupported MPEG-2 artifact provenance schema');
			writeFileSync(file, JSON.stringify(provenance));
			const module = path.join(temporary, 'mpeg2-decoder.mjs');
			writeFileSync(module, readFileSync(module, 'utf8').replace('AGFzbQ', 'BGFzbQ'));
			expect(() => verifyMpeg2Artifact(temporary)).toThrow('artifact identity mismatch');
			provenance.outputs['mpeg2-decoder.mjs'] = fileIdentity(module);
			writeFileSync(file, JSON.stringify(provenance));
			expect(() => verifyMpeg2Artifact(temporary)).toThrow('WASM does not match provenance');
		} finally {
			rmSync(temporary, { recursive: true, force: true });
		}
	});
});
