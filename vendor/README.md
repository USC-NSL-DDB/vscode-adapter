# DDB TypeScript SDK

`ddb-debugger-api-client-0.1.0-10f0f8aa.tgz` is the upstream `@ddb-debugger/api-client`
package built from DDB commit `10f0f8aa`,
`ddb/sdk/typescript`. It is licensed under Apache-2.0. The upstream package is
preview-stage and is vendored because registry publication is not assumed.

Reproduce from that DDB checkout:

```sh
cd ddb/sdk/typescript
npm ci --ignore-scripts
npm run build
npm pack
mv ddb-debugger-api-client-0.1.0.tgz ddb-debugger-api-client-0.1.0-10f0f8aa.tgz
```

The tarball SHA-1 is `81188519bc67b7ca1ef0df722d9dace31a888fb8`.
Install with `npm ci`; the lockfile also pins its integrity digest. The adapter
uses the generated contract and client directly. Do not edit generated SDK code.

This revision includes retained evaluation metadata, typed variable assignment,
native console frame context, and typed debugger settings.
