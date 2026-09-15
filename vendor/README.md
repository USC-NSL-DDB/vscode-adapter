# DDB TypeScript SDK

`ddb-debugger-api-client-0.1.0-25e4a354.tgz` is the upstream `@ddb-debugger/api-client`
package built from DDB commit `25e4a354`,
`ddb/sdk/typescript`. It is licensed under Apache-2.0. The upstream package is
preview-stage and is vendored because registry publication is not assumed.

Reproduce from that DDB checkout:

```sh
cd ddb/sdk/typescript
npm ci --ignore-scripts
npm run build
npm pack
mv ddb-debugger-api-client-0.1.0.tgz ddb-debugger-api-client-0.1.0-25e4a354.tgz
```

The tarball SHA-1 is `ee0f528288839d750fde43959e8a4f8afd0b9e4e`.
Install with `npm ci`; the lockfile also pins its integrity digest. The adapter
uses the generated contract and client directly. Do not edit generated SDK code.

This revision fixes pagination when ProtoJSON omits an empty repeated field.
