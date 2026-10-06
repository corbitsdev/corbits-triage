// SPDX-License-Identifier: GPL-2.0-only

import { installGithubAppFetch } from "./github-app-adapter";
import { DEFAULT_GITHUB_API_ORIGIN } from "./github-app-credential-adapter";

installGithubAppFetch(DEFAULT_GITHUB_API_ORIGIN);

export { installGithubAppCredentialAdapter } from "./github-app-adapter";
