/** @type {import('@jest/types').Config.InitialOptions} */
const config = {
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    // Strip .js extensions from relative imports so the transform resolves .ts sources
    '^(\\.{1,2}/.*)\\.js$': '$1',
    // See fakeHomebridgeModule.js for why the real 'homebridge' package isn't used here.
    '^homebridge$': '<rootDir>/src/__tests__/support/fakeHomebridgeModule.js',
  },
  transform: {
    // @swc/jest rather than ts-jest: ts-jest's peer range caps at `typescript
    // <7`, and this project's TypeScript 7 ("tsgo") is a from-scratch Go
    // rewrite with no in-process JS Compiler API for ts-jest to call into.
    // @swc/jest fully transpiles (parameter properties included) rather than
    // just erasing types, so it works regardless of the installed
    // TypeScript's own tooling. Type-checking itself still happens via
    // `npm run build` (tsc); this transform intentionally does not type-check.
    '^.+\\.tsx?$': [
      '@swc/jest',
      {
        jsc: {
          parser: { syntax: 'typescript', decorators: false },
          target: 'es2022',
        },
        module: { type: 'es6' },
      },
    ],
  },
  testMatch: ['**/__tests__/**/*.test.ts'],
  testPathIgnorePatterns: ['/node_modules/', '/__tests__/integration/'],
  testEnvironment: 'node',
  // ValloxAccessory starts a real setInterval poll loop with no public way to
  // stop it from outside (platform.test.ts constructs one indirectly via
  // discoverDevices() and never gets a handle back) — force the process down
  // once tests finish rather than waiting on that timer forever.
  forceExit: true,
}

export default config
