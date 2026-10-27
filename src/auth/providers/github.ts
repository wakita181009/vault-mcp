import { Octokit } from "octokit";
import { parseList } from "../../vault";
import type { UpstreamProvider } from "./types";

export const githubProvider: UpstreamProvider = {
	name: "github",
	displayName: () => "GitHub",
	logo: "https://avatars.githubusercontent.com/u/314135?s=200&v=4",
	scope: "read:user",
	endpoints: async () => ({
		authorizeUrl: "https://github.com/login/oauth/authorize",
		tokenUrl: "https://github.com/login/oauth/access_token",
	}),
	credentials: (env) => ({
		clientId: env.GITHUB_CLIENT_ID ?? "",
		clientSecret: env.GITHUB_CLIENT_SECRET ?? "",
	}),
	allowedLogins: (env) => parseList(env.VAULT_ALLOWED_GITHUB_LOGINS),
	fetchIdentity: async (accessToken) => {
		const user = await new Octokit({ auth: accessToken }).rest.users.getAuthenticated();
		const { login, name, email } = user.data;
		return { login, name: name ?? login, email: email ?? "" };
	},
};
