export const withDeadline = async <T>(operation: Promise<T>, message: string): Promise<T> => {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([operation, new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error(message)), 2000);
		})]);
	} finally {
		clearTimeout(timer);
	}
};

export const waitForWorkerRequest = (request: Promise<void>, operation: Promise<unknown>) => withDeadline(
	Promise.race([
		request,
		operation.then(() => {
			throw new Error('Selection completed before the blocked worker request');
		}),
	]),
	'Selection did not reach the blocked worker request',
);
