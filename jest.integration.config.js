/** @type {import('@jest/types').Config.InitialOptions} */
const config = {
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
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
  testMatch: ['**/__tests__/integration/**/*.test.ts'],
  testEnvironment: 'node',
  // Booting a Homebridge container, waiting on mDNS-free HAP pairing, and
  // seeding the mock Vallox unit all take real wall-clock time; the default
  // 5s Jest timeout isn't enough.
  testTimeout: 180_000,
  maxWorkers: 1,
}

export default config
