import { describe, it, expect, jest, beforeEach } from '@jest/globals'
import { FakeAccessory, FakeHapStatusError, createFakeLogger, FakeServiceType, FakeCharacteristic } from './support/fakeHap.js'

// ---------------------------------------------------------------------------
// A shared, test-controllable fake ValloxClient. platform.ts constructs a
// real `ValloxClient`/`WebSocketTransport` internally, so the only way to
// intercept device I/O is to replace those two classes at the module level —
// everything else vallox.js exports (Profile, ValidationError, HistoryChannel,
// ...) is passed through untouched since valloxAccessory.ts/profileSwitches.ts
// need the real thing.
// ---------------------------------------------------------------------------

let currentFakeClientImpl: Record<string, unknown> = {}

function defaultFakeClientImpl(): Record<string, unknown> {
  return {
    getSerialNumber: jest.fn(async (_base?: 'hex' | 'decimal') => '2524262093'),
    getModel: jest.fn(async () => 'Vallox 110 MV'),
    getSoftwareVersion: jest.fn(async () => '3.1.6'),
    isPoweredOn: jest.fn(async () => true),
    powerOn: jest.fn(async () => {}),
    powerOff: jest.fn(async () => {}),
    getProfile: jest.fn(async () => 0),
    getSensorReadings: jest.fn(async () => ({
      extractAirTemp: 21,
      exhaustAirTemp: 3,
      outdoorAirTemp: 5,
      supplyCellAirTemp: 17,
      supplyAirTemp: 19,
      humidity: 42,
      co2: 650,
    })),
    getCo2Threshold: jest.fn(async () => 900),
    getFilterDaysRemaining: jest.fn(async () => 100),
    getHomeFanSpeed: jest.fn(async () => 50),
    getAwayFanSpeed: jest.fn(async () => 30),
    getBoostFanSpeed: jest.fn(async () => 80),
    setHomeFanSpeed: jest.fn(async () => {}),
    setAwayFanSpeed: jest.fn(async () => {}),
    setBoostFanSpeed: jest.fn(async () => {}),
    setProfile: jest.fn(async () => {}),
    clearTimedModes: jest.fn(async () => {}),
    getCriticalFaultActive: jest.fn(async () => false),
    getFaults: jest.fn(async () => []),
  }
}

// Deliberately does NOT spread a dynamically re-imported "actual" vallox.js
// module here: `await import('vallox.js')` from inside this same specifier's
// own mock factory deadlocks Jest's ESM module registry (the import call
// resolves back into this still-pending factory). Instead, the handful of
// real, stable exports valloxAccessory.ts/profileSwitches.ts need at runtime
// (Profile, ValidationError, HistoryChannel) are reproduced verbatim here;
// everything else those files import from 'vallox.js' is `import type`,
// which is erased at build time and never touches this mock.
jest.unstable_mockModule('vallox.js', () => {
  class FakeValloxClient {
    constructor(_transport: unknown) {
      Object.assign(this as object, currentFakeClientImpl)
    }
  }

  class FakeWebSocketTransport {
    constructor(_config: unknown) {}
    async getHistory() {
      return []
    }
  }

  class ValidationError extends Error {
    constructor(context: string, details?: string | null) {
      super(`Invalid ${context} received from device: ${details ?? 'unknown validation error'}`)
      this.name = 'ValidationError'
    }
  }

  const Profile = { NONE: 0, HOME: 1, AWAY: 2, BOOST: 3, FIREPLACE: 4, EXTRA: 5 } as const
  const HistoryChannel = {
    EXTRACT_AIR_TEMP: 0,
    EXHAUST_AIR_TEMP: 1,
    OUTDOOR_AIR_TEMP: 2,
    SUPPLY_AIR_TEMP: 3,
    MAX_CO2: 4,
    MAX_HUMIDITY: 5,
  } as const

  return {
    ValloxClient: FakeValloxClient,
    WebSocketTransport: FakeWebSocketTransport,
    ValidationError,
    Profile,
    HistoryChannel,
  }
})

const { ValloxHomebridgePlatform } = await import('../platform.js')
const { PLATFORM_NAME, PLUGIN_NAME } = await import('../settings.js')

// ---------------------------------------------------------------------------
// Fake `API`
// ---------------------------------------------------------------------------

function createFakeApi() {
  const listeners = new Map<string, () => void>()
  return {
    hap: {
      Service: FakeServiceType,
      Characteristic: FakeCharacteristic,
      HapStatusError: FakeHapStatusError,
      uuid: { generate: (seed: string) => `uuid:${seed}` },
    },
    user: { storagePath: () => '/tmp/homebridge-vallox-redux-tests' },
    platformAccessory: FakeAccessory as unknown as new (name: string, uuid: string) => FakeAccessory,
    registerPlatformAccessories: jest.fn(),
    unregisterPlatformAccessories: jest.fn(),
    on(event: string, cb: () => void) {
      listeners.set(event, cb)
      return this
    },
    async fireDidFinishLaunching(): Promise<void> {
      listeners.get('didFinishLaunching')?.()
      // discoverDevices() is invoked fire-and-forget (`void this.discoverDevices()`);
      // let its awaited I/O settle before assertions.
      await new Promise((r) => setTimeout(r, 20))
    },
  }
}

function validConfig(overrides: Record<string, unknown> = {}) {
  return { platform: PLATFORM_NAME, host: '192.168.1.100', ...overrides }
}

describe('ValloxHomebridgePlatform', () => {
  let api: ReturnType<typeof createFakeApi>
  let log: ReturnType<typeof createFakeLogger>

  beforeEach(() => {
    currentFakeClientImpl = defaultFakeClientImpl()
    api = createFakeApi()
    log = createFakeLogger()
  })

  it('does not register a didFinishLaunching listener when the config is invalid', () => {
    const errorSpy = jest.fn()
    log.error = errorSpy
    new ValloxHomebridgePlatform(log as any, { platform: PLATFORM_NAME } as any /* missing host */, api as any)

    expect(errorSpy).toHaveBeenCalledTimes(1)
    // No listener was registered, so firing the event is a no-op — registerPlatformAccessories
    // must never be called.
    return api.fireDidFinishLaunching().then(() => {
      expect(api.registerPlatformAccessories).not.toHaveBeenCalled()
    })
  })

  it('discovers the main accessory plus 3 satellites and registers all 4 as new', async () => {
    new ValloxHomebridgePlatform(log as any, validConfig() as any, api as any)
    await api.fireDidFinishLaunching()

    expect(api.registerPlatformAccessories).toHaveBeenCalledTimes(1)
    const [pluginName, platformName, registered] = api.registerPlatformAccessories.mock.calls[0] as [
      string,
      string,
      FakeAccessory[],
    ]
    expect(pluginName).toBe(PLUGIN_NAME)
    expect(platformName).toBe(PLATFORM_NAME)
    expect(registered).toHaveLength(4)
    expect(registered.map((a) => a.displayName).sort()).toEqual(
      ['Vallox 110 MV', 'Vallox Exhaust Air', 'Vallox Outdoor Air', 'Vallox Supply Air'].sort(),
    )
  })

  it('seeds accessory UUIDs from the unit serial number when available', async () => {
    new ValloxHomebridgePlatform(log as any, validConfig() as any, api as any)
    await api.fireDidFinishLaunching()

    const [, , registered] = api.registerPlatformAccessories.mock.calls[0] as [string, string, FakeAccessory[]]
    const main = registered.find((a) => a.displayName === 'Vallox 110 MV')!
    expect(main.UUID).toBe('uuid:2524262093')
    const supply = registered.find((a) => a.displayName === 'Vallox Supply Air')!
    expect(supply.UUID).toBe('uuid:2524262093:supply')
  })

  it('falls back to host:port for accessory identity when the serial read fails at startup', async () => {
    currentFakeClientImpl.getSerialNumber = jest.fn(async () => {
      throw new Error('unit offline')
    })
    const warnSpy = jest.fn()
    log.warn = warnSpy

    new ValloxHomebridgePlatform(log as any, validConfig() as any, api as any)
    await api.fireDidFinishLaunching()

    expect(warnSpy).toHaveBeenCalled()
    const [, , registered] = api.registerPlatformAccessories.mock.calls[0] as [string, string, FakeAccessory[]]
    const main = registered.find((a) => a.displayName === 'Vallox 110 MV')!
    expect(main.UUID).toBe('uuid:192.168.1.100:80')
  })

  it('reuses cached accessories instead of registering them again', async () => {
    const platform = new ValloxHomebridgePlatform(log as any, validConfig() as any, api as any)

    for (const uuid of [
      'uuid:2524262093',
      'uuid:2524262093:supply',
      'uuid:2524262093:outdoor',
      'uuid:2524262093:exhaust',
    ]) {
      platform.configureAccessory(new FakeAccessory('Cached', uuid) as any)
    }

    await api.fireDidFinishLaunching()

    expect(api.registerPlatformAccessories).not.toHaveBeenCalled()
  })

  it('unregisters a stale cached accessory that no longer matches any discovered device', async () => {
    const platform = new ValloxHomebridgePlatform(log as any, validConfig() as any, api as any)
    const stale = new FakeAccessory('Orphaned', 'uuid:some-other-unit')
    platform.configureAccessory(stale as any)

    await api.fireDidFinishLaunching()

    expect(api.unregisterPlatformAccessories).toHaveBeenCalledTimes(1)
    const [, , unregistered] = api.unregisterPlatformAccessories.mock.calls[0] as [string, string, FakeAccessory[]]
    expect(unregistered).toEqual([stale])
  })

  it('uses the explicit config name over the detected model for the main accessory', async () => {
    new ValloxHomebridgePlatform(log as any, validConfig({ name: 'My Ventilation Unit' }) as any, api as any)
    await api.fireDidFinishLaunching()

    const [, , registered] = api.registerPlatformAccessories.mock.calls[0] as [string, string, FakeAccessory[]]
    expect(registered.some((a) => a.displayName === 'My Ventilation Unit')).toBe(true)
  })
})
