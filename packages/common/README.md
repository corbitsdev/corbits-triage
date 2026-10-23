# @corbits/common

Dependency-free helpers shared across the apps and packages.

## Use

```ts
import { asRecord, errorText } from "@corbits/common";
import { parsePatch } from "@corbits/common/patch";
import { contentSecurityPolicy, securityHeaders } from "@corbits/common/security-headers";
import { verifyXHubSignature } from "@corbits/common/x-hub-signature";
import { xHubHookMetadata, GITHUB_HOOK_HEADERS } from "@corbits/common/hook-metadata";
```

## Test

```sh
bun --conditions=intx-src test packages/common
```

## Docs

- [ARCHITECTURE.md](../../docs/ARCHITECTURE.md)
