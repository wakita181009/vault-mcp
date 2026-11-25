export type EnvIssue = { key: string; message: string };

/**
 * The one error shape for a misconfigured deploy, whether the problem is found
 * by `parseEnv` or by a check that runs outside it (the provider lookup on the
 * hot path, the R2 binding). Import-free so either layer can use it without a cycle.
 */
export function invalidEnvError(issues: EnvIssue[]): Error {
	const lines = issues
		.map(({ key, message }) => `  - ${key}: ${message}`)
		.join("\n");
	return new Error(`Invalid Worker environment:\n${lines}`);
}
