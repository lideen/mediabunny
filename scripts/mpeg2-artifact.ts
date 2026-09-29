import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

type Identity = { bytes: number; sha256: string };
type Provenance = {
	outputs: Record<string, Identity>;
	binaryInputs: Record<'scalar' | 'shared', { wasm: Identity; derivedWasm: Identity }>;
};

export const verifyEmbeddedMpeg2 = (file: string, inputs: Provenance['binaryInputs']) => {
	const source = readFileSync(file, 'utf8');
	const payloads = [...source.matchAll(/AGFzbQ[A-Za-z0-9+/=]+/g)].map((match) => {
		const bytes = Buffer.from(match[0], 'base64');
		return { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
	});
	for (const target of ['scalar', 'shared'] as const) {
		const expected = inputs[target].derivedWasm;
		if (!payloads.some(actual => actual.bytes === expected.bytes && actual.sha256 === expected.sha256)) {
			throw new Error(`MPEG-2 embedded ${target} WASM does not match provenance`);
		}
	}
};

export const fileIdentity = (file: string): Identity => {
	const bytes = readFileSync(file);
	return { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
};

/** Validate the complete producer artifact, including the bytes embedded in its executable module. */
export const verifyMpeg2Artifact = (directory: string, expectedModuleHash?: string) => {
	const provenance = JSON.parse(readFileSync(path.join(directory, 'PROVENANCE.json'), 'utf8')) as Provenance;
	for (const required of ['mpeg2-decoder.mjs', 'mpeg2-decoder.d.mts', 'package.json', 'NOTICE.txt',
		'types/index.d.ts']) {
		if (!provenance.outputs[required]) throw new Error(`Missing MPEG-2 artifact identity: ${required}`);
	}
	for (const [name, expected] of Object.entries(provenance.outputs)) {
		const file = path.resolve(directory, name);
		if (!file.startsWith(path.resolve(directory) + path.sep)) throw new Error(`Invalid artifact path: ${name}`);
		const actual = fileIdentity(file);
		if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) {
			throw new Error(`MPEG-2 artifact identity mismatch: ${name}`);
		}
	}
	const module = path.join(directory, 'mpeg2-decoder.mjs');
	const identity = fileIdentity(module);
	if (expectedModuleHash && identity.sha256 !== expectedModuleHash) {
		throw new Error('MPEG-2 module does not match the approved import pin');
	}
	verifyEmbeddedMpeg2(module, provenance.binaryInputs);
	return { module, identity, provenance };
};
