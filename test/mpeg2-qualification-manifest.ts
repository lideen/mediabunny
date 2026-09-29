type QualificationCase = {
	name: string; file: string; width: number; height: number; frames: number; duration: number;
	format: string; scan: string; sha256: string; references: Record<string, string>;
	packets: { timestamp: number; duration: number; sha256: string }[];
};

const requireManifest: (condition: unknown, message: string) => asserts condition = (condition, message) => {
	if (!condition) throw new Error(`Invalid MPEG-2 qualification manifest: ${message}`);
};
const object = (value: unknown): Record<string, unknown> => {
	requireManifest(value !== null && typeof value === 'object' && !Array.isArray(value), 'expected an object');
	return value as Record<string, unknown>;
};
const sha256 = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export const qualificationScope = (paced: boolean) => ({
	kind: 'mpeg2-consumer-functional',
	matrix: ['progressive420', 'top422', 'bottom422'],
	paced,
	minimumContinuousSeconds: paced ? 120 : 30,
	realTimeAcceptance: false,
});

/** Both the CLI and browser validate the full matrix before any qualification work can pass. */
export const readQualificationManifest = (value: unknown, paced: boolean): { cases: QualificationCase[] } => {
	const cases = object(value)['cases'];
	const scope = qualificationScope(paced);
	requireManifest(Array.isArray(cases) && cases.length === 3,
		'required matrix is exactly progressive420, top422, bottom422');
	const names = new Set<string>();
	for (const entry of cases) {
		const fixture = object(entry);
		const name = fixture['name'];
		requireManifest(typeof name === 'string' && scope.matrix.includes(name) && !names.has(name),
			'required matrix is exactly progressive420, top422, bottom422');
		names.add(name);
		const progressive = name === 'progressive420';
		requireManifest(fixture['file'] === `${name}.mxf`
			&& fixture['width'] === (progressive ? 1280 : 1920)
			&& fixture['height'] === (progressive ? 720 : 1080)
			&& fixture['format'] === (progressive ? 'I420' : 'I422')
			&& fixture['scan'] === (progressive
				? 'progressive'
				: name === 'top422' ? 'interlaced-top-first' : 'interlaced-bottom-first'),
		`${name}: file, dimensions, format or scan do not match the generated matrix`);
		const duration = fixture['duration'];
		const frames = fixture['frames'];
		requireManifest(typeof duration === 'number' && Number.isSafeInteger(duration) && duration > 0
			&& (progressive ? duration >= scope.minimumContinuousSeconds && duration <= 120 : duration === 2),
		`${name}: duration must be ${progressive ? `${scope.minimumContinuousSeconds}..120` : '2'} seconds`);
		requireManifest(typeof frames === 'number' && Number.isSafeInteger(frames) && frames > 0
			&& frames === duration * 25, `${name}: frame count must equal duration * 25`);
		requireManifest(sha256(fixture['sha256']), `${name}: invalid media SHA-256`);
		const packets = fixture['packets'];
		requireManifest(Array.isArray(packets) && packets.length === frames, `${name}: incorrect packet count`);
		const ordinals = new Set<number>();
		for (const [index, entry] of packets.entries()) {
			const packet = object(entry);
			const timestamp = packet['timestamp'];
			requireManifest(typeof timestamp === 'number' && Number.isFinite(timestamp),
				`${name}: invalid packet timestamp`);
			const ordinal = Math.round(timestamp * 25);
			requireManifest(ordinal >= 0 && ordinal < frames && Math.abs(timestamp - ordinal / 25) < 1e-6
				&& !ordinals.has(ordinal) && (!progressive || ordinal === index),
			`${name}: packet timestamps must cover every frame exactly once`);
			ordinals.add(ordinal);
			requireManifest(packet['duration'] === 1 / 25 && sha256(packet['sha256']),
				`${name}: invalid packet duration or SHA-256`);
		}
		const references = object(fixture['references']);
		const targets = [0, Math.floor(frames / 2), frames - 1];
		requireManifest(Object.keys(references).length === 3
			&& targets.every(ordinal => references[ordinal] === `${name}-${ordinal}.rgba`),
		`${name}: first, middle and last RGBA references are required`);
	}
	return { cases: cases as QualificationCase[] };
};
