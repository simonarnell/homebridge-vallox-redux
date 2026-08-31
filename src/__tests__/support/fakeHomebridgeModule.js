// Stands in for the real 'homebridge' package in tests (see jest.config.js's
// moduleNameMapper). The real package pulls in @homebridge/hap-nodejs's
// Matter subsystem, which uses Node's `imports` (`#foo`) subpath resolution
// in a way Jest's ESM loader currently mishandles for nested/hoisted
// versions — unrelated to anything this plugin does. Production code only
// ever imports one *value* from 'homebridge' (`HAPStatus`); everything else
// it imports from there is `import type`, which is erased at build time and
// never reaches this module at runtime.
export const HAPStatus = {
  SUCCESS: 0,
  SERVICE_COMMUNICATION_FAILURE: -70402,
}
