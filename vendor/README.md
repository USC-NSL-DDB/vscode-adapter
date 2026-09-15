# DDB TypeScript SDK

`ddb-debugger-api-client-0.1.0.tgz` is the upstream `@ddb-debugger/api-client`
package built from DDB commit `7309720806cb455a7124bc2d42174754f637cd54`,
`ddb/sdk/typescript`. It is licensed under Apache-2.0. The upstream package is
preview-stage and is vendored because registry publication is not assumed.

Reproduce from that DDB checkout:

```sh
cd ddb/sdk/typescript
npm ci --ignore-scripts
npm run build
npm pack
```

The tarball SHA-1 is `28bb0aee4ca1db1697aaa4e20aba826d798098da`.
Install with `npm ci`; the lockfile also pins its integrity digest. The adapter
uses the generated contract and client directly. Do not edit generated SDK code.
