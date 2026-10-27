import type { UpstreamIdentity } from "./providers";

/**
 * Context captured at login, encrypted into the OAuth token by OAuthProvider
 * and surfaced to the VaultMCP Durable Object as `this.props`. `login` is the
 * value the allowlist gate in `guard.ts` matches.
 */
export type Props = UpstreamIdentity & {
	accessToken: string;
};
