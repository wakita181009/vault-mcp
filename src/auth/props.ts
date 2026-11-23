import type { UpstreamIdentity } from "./providers";

/**
 * Context captured at login, encrypted into the OAuth token by OAuthProvider
 * and surfaced to the VaultMCP Durable Object as `this.props`. `login` is the
 * value the allowlist gate in `guard.ts` matches.
 *
 * The upstream access token is deliberately not kept: nothing after login
 * calls the IdP, so storing it would only widen what a leaked grant exposes.
 */
export type Props = UpstreamIdentity;
