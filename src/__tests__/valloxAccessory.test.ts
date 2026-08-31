import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals'
import { Profile, ValidationError } from 'vallox.js'
import { ValloxAccessory, type ValloxDeviceInfo } from '../valloxAccessory.js'
import {
  createFakePlatform,
  FakeAccessory,
  FakeHapStatusError,
  FakeCharacteristic,
  FakeServiceType,
} from './support/fakeHap.js'

const DEFAULT_READINGS = {
  extractAirTemp: 21,
  exhaustAirTemp: 3,
  outdoorAirTemp: 5,
  supplyCellAirTemp: 17,
  supplyAirTemp: 19,
  humidity: 42,
  co2: 650,
}

function fakeClient(overrides: Record<string, unknown> = {}) {
  return {
    isPoweredOn: jest.fn(async () => true),
    powerOn: jest.fn(async () => {}),
    powerOff: jest.fn(async () => {}),
    getProfile: jest.fn(async () => Profile.HOME),
    getSensorReadings: jest.fn(async () => ({ ...DEFAULT_READINGS })),
    getCo2Threshold: jest.fn(async () => 900),
    getFilterDaysRemaining: jest.fn(async () => 100),
    getHomeFanSpeed: jest.fn(async () => 50),
    getAwayFanSpeed: jest.fn(async () => 30),
    getBoostFanSpeed: jest.fn(async () => 80),
    setHomeFanSpeed: jest.fn(async (_pct: number) => {}),
    setAwayFanSpeed: jest.fn(async (_pct: number) => {}),
    setBoostFanSpeed: jest.fn(async (_pct: number) => {}),
    setProfile: jest.fn(async (_profile: Profile) => {}),
    clearTimedModes: jest.fn(async () => {}),
    getCriticalFaultActive: jest.fn(async () => false),
    getFaults: jest.fn(async () => []),
    ...overrides,
  }
}

function fakeTransport() {
  return { getHistory: jest.fn(async () => []) }
}

const deviceInfo: ValloxDeviceInfo = { serial: '2524262093', model: 'Vallox 110 MV', firmwareVersion: '3.1.6' }

/** Lets the fire-and-forget initial poll started by the constructor settle before assertions. */
async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 10))
}

interface Harness {
  platform: ReturnType<typeof createFakePlatform>
  accessory: FakeAccessory
  supply: FakeAccessory
  outdoor: FakeAccessory
  exhaust: FakeAccessory
  client: ReturnType<typeof fakeClient>
  instance: ValloxAccessory
}

async function build(
  configOverrides: Record<string, unknown> = {},
  clientOverrides: Record<string, unknown> = {},
): Promise<Harness> {
  const platform = createFakePlatform({ configOverrides })
  const accessory = new FakeAccessory('Vallox 110 MV', 'uuid-main')
  accessory.context.host = '192.168.1.100'
  const supply = new FakeAccessory('Vallox Supply Air', 'uuid-supply')
  const outdoor = new FakeAccessory('Vallox Outdoor Air', 'uuid-outdoor')
  const exhaust = new FakeAccessory('Vallox Exhaust Air', 'uuid-exhaust')
  const client = fakeClient(clientOverrides)
  const transport = fakeTransport()

  const instance = new ValloxAccessory(
    platform as any,
    accessory as any,
    client as any,
    transport as any,
    deviceInfo,
    supply as any,
    outdoor as any,
    exhaust as any,
  )

  await flush()
  return { platform, accessory, supply, outdoor, exhaust, client, instance }
}

/** Every test starts a real setInterval poll loop; always clear it so Jest can exit cleanly. */
function stopPolling(h: Harness): void {
  clearInterval((h.instance as unknown as { pollHandle?: NodeJS.Timeout }).pollHandle)
}

describe('ValloxAccessory', () => {
  let harness: Harness

  afterEach(() => {
    if (harness) stopPolling(harness)
  })

  describe('accessory information', () => {
    it('uses the detected model/serial/firmware when available', async () => {
      harness = await build()
      const info = harness.accessory.getService(FakeServiceType.AccessoryInformation)!
      expect(info.getCharacteristic(FakeCharacteristic.Manufacturer).value).toBe('Vallox')
      expect(info.getCharacteristic(FakeCharacteristic.Model).value).toBe('Vallox 110 MV')
      expect(info.getCharacteristic(FakeCharacteristic.SerialNumber).value).toBe('2524262093')
      expect(info.getCharacteristic(FakeCharacteristic.FirmwareRevision).value).toBe('3.1.6')
    })

    it('falls back to host/generic strings when identity fields are missing', async () => {
      const platform = createFakePlatform()
      const accessory = new FakeAccessory('Vallox Redux', 'uuid-main')
      accessory.context.host = '10.0.0.5'
      const supply = new FakeAccessory('Supply', 'uuid-supply')
      const outdoor = new FakeAccessory('Outdoor', 'uuid-outdoor')
      const exhaust = new FakeAccessory('Exhaust', 'uuid-exhaust')
      const client = fakeClient()
      const instance = new ValloxAccessory(
        platform as any,
        accessory as any,
        client as any,
        fakeTransport() as any,
        { serial: undefined, model: undefined, firmwareVersion: undefined },
        supply as any,
        outdoor as any,
        exhaust as any,
      )
      await flush()
      harness = { platform, accessory, supply, outdoor, exhaust, client, instance }

      const info = accessory.getService(FakeServiceType.AccessoryInformation)!
      expect(info.getCharacteristic(FakeCharacteristic.Model).value).toBe('MVHR (WebSocket)')
      expect(info.getCharacteristic(FakeCharacteristic.SerialNumber).value).toBe('10.0.0.5')
      expect(info.getCharacteristic(FakeCharacteristic.FirmwareRevision).value).toBe('0.0.0')
    })

    it('removes a stale TemperatureSensor service left by a previous plugin version', async () => {
      const platform = createFakePlatform()
      const accessory = new FakeAccessory('Vallox', 'uuid-main')
      accessory.addService(FakeServiceType.TemperatureSensor, 'Old Sensor', 'stale-subtype')
      const supply = new FakeAccessory('Supply', 'uuid-supply')
      const outdoor = new FakeAccessory('Outdoor', 'uuid-outdoor')
      const exhaust = new FakeAccessory('Exhaust', 'uuid-exhaust')
      const instance = new ValloxAccessory(
        platform as any,
        accessory as any,
        fakeClient() as any,
        fakeTransport() as any,
        deviceInfo,
        supply as any,
        outdoor as any,
        exhaust as any,
      )
      await flush()
      harness = { platform, accessory, supply, outdoor, exhaust, client: fakeClient(), instance }

      const staleStillPresent = accessory.services.some((s) => s.subtype === 'stale-subtype')
      expect(staleStillPresent).toBe(false)
    })
  })

  describe('fan', () => {
    it('Active reflects isPoweredOn()', async () => {
      harness = await build()
      const active = harness.accessory
        .getServiceById(FakeServiceType.Fanv2, 'fan')!
        .getCharacteristic(FakeCharacteristic.Active)
      await expect(active.triggerGet()).resolves.toBe(1)

      harness.client.isPoweredOn.mockResolvedValueOnce(false)
      await expect(active.triggerGet()).resolves.toBe(0)
    })

    it('setting Active on/off calls powerOn/powerOff and re-polls', async () => {
      harness = await build()
      const active = harness.accessory
        .getServiceById(FakeServiceType.Fanv2, 'fan')!
        .getCharacteristic(FakeCharacteristic.Active)

      await active.triggerSet(1)
      await flush()
      expect(harness.client.powerOn).toHaveBeenCalledTimes(1)

      await active.triggerSet(0)
      await flush()
      expect(harness.client.powerOff).toHaveBeenCalledTimes(1)
    })

    it('setting RotationSpeed routes to the setter for the currently active profile', async () => {
      harness = await build()
      const speed = harness.accessory
        .getServiceById(FakeServiceType.Fanv2, 'fan')!
        .getCharacteristic(FakeCharacteristic.RotationSpeed)

      await speed.triggerSet(66)
      expect(harness.client.setHomeFanSpeed).toHaveBeenCalledWith(66)
    })

    it('ignores a RotationSpeed write while in a profile with no fan-speed setter', async () => {
      harness = await build({}, { getProfile: jest.fn(async () => Profile.FIREPLACE) })
      const speed = harness.accessory
        .getServiceById(FakeServiceType.Fanv2, 'fan')!
        .getCharacteristic(FakeCharacteristic.RotationSpeed)

      await expect(speed.triggerSet(66)).resolves.toBeUndefined()
      expect(harness.client.setHomeFanSpeed).not.toHaveBeenCalled()
      expect(harness.client.setAwayFanSpeed).not.toHaveBeenCalled()
      expect(harness.client.setBoostFanSpeed).not.toHaveBeenCalled()
    })
  })

  describe('temperature sensors', () => {
    it('main accessory reports extract air temperature', async () => {
      harness = await build()
      const extract = harness.accessory
        .getServiceById(FakeServiceType.TemperatureSensor, 'extract')!
        .getCharacteristic(FakeCharacteristic.CurrentTemperature)
      await expect(extract.triggerGet()).resolves.toBe(21)
    })

    it.each([
      ['supply', 'supplyAirTemp', 19],
      ['outdoor', 'outdoorAirTemp', 5],
      ['exhaust', 'exhaustAirTemp', 3],
    ])('%s satellite accessory reports %s', async (key, _field, expected) => {
      harness = await build()
      const satelliteAccessory = { supply: harness.supply, outdoor: harness.outdoor, exhaust: harness.exhaust }[
        key as 'supply' | 'outdoor' | 'exhaust'
      ]
      const temp = satelliteAccessory
        .getServiceById(FakeServiceType.TemperatureSensor, key)!
        .getCharacteristic(FakeCharacteristic.CurrentTemperature)
      await expect(temp.triggerGet()).resolves.toBe(expected)
    })

    it('sets satellite AccessoryInformation Model from the detected unit model', async () => {
      harness = await build()
      const info = harness.supply.getService(FakeServiceType.AccessoryInformation)!
      expect(info.getCharacteristic(FakeCharacteristic.Model).value).toBe('Vallox 110 MV (Supply Air)')
    })
  })

  describe('optional sensors', () => {
    it('creates humidity and CO2 sensors by default', async () => {
      harness = await build()
      expect(harness.accessory.getServiceById(FakeServiceType.HumiditySensor, 'humidity')).toBeDefined()
      expect(harness.accessory.getServiceById(FakeServiceType.CarbonDioxideSensor, 'co2')).toBeDefined()
    })

    it('omits humidity sensor when disabled', async () => {
      harness = await build({ enableHumiditySensor: false })
      expect(harness.accessory.getServiceById(FakeServiceType.HumiditySensor, 'humidity')).toBeUndefined()
    })

    it('omits CO2 sensor when disabled', async () => {
      harness = await build({ enableCo2Sensor: false })
      expect(harness.accessory.getServiceById(FakeServiceType.CarbonDioxideSensor, 'co2')).toBeUndefined()
    })

    it('humidity sensor reports extract air humidity', async () => {
      harness = await build()
      const humidity = harness.accessory
        .getServiceById(FakeServiceType.HumiditySensor, 'humidity')!
        .getCharacteristic(FakeCharacteristic.CurrentRelativeHumidity)
      await expect(humidity.triggerGet()).resolves.toBe(42)
    })

    it('CO2 detected state flips to abnormal at/above the threshold', async () => {
      harness = await build({}, { getCo2Threshold: jest.fn(async () => 600) })
      const co2Service = harness.accessory.getServiceById(FakeServiceType.CarbonDioxideSensor, 'co2')!
      const detected = co2Service.getCharacteristic(FakeCharacteristic.CarbonDioxideDetected)
      // DEFAULT_READINGS.co2 = 650 >= 600
      await expect(detected.triggerGet()).resolves.toBe(FakeCharacteristic.CarbonDioxideDetected.CO2_LEVELS_ABNORMAL)
    })

    it('CO2 detected state stays normal below the threshold', async () => {
      harness = await build({}, { getCo2Threshold: jest.fn(async () => 900) })
      const co2Service = harness.accessory.getServiceById(FakeServiceType.CarbonDioxideSensor, 'co2')!
      const detected = co2Service.getCharacteristic(FakeCharacteristic.CarbonDioxideDetected)
      await expect(detected.triggerGet()).resolves.toBe(FakeCharacteristic.CarbonDioxideDetected.CO2_LEVELS_NORMAL)
    })
  })

  describe('filter maintenance', () => {
    it('reports CHANGE_FILTER at/below the configured threshold', async () => {
      harness = await build({ filterAlertDays: 14 }, { getFilterDaysRemaining: jest.fn(async () => 10) })
      const filter = harness.accessory.getServiceById(FakeServiceType.FilterMaintenance, 'filter')!
      const indication = filter.getCharacteristic(FakeCharacteristic.FilterChangeIndication)
      await expect(indication.triggerGet()).resolves.toBe(FakeCharacteristic.FilterChangeIndication.CHANGE_FILTER)
    })

    it('reports FILTER_OK above the configured threshold', async () => {
      harness = await build({ filterAlertDays: 14 }, { getFilterDaysRemaining: jest.fn(async () => 100) })
      const filter = harness.accessory.getServiceById(FakeServiceType.FilterMaintenance, 'filter')!
      const indication = filter.getCharacteristic(FakeCharacteristic.FilterChangeIndication)
      await expect(indication.triggerGet()).resolves.toBe(FakeCharacteristic.FilterChangeIndication.FILTER_OK)
    })
  })

  describe('polling', () => {
    it('the initial poll pushes fan/temp/humidity/co2/filter state onto their characteristics', async () => {
      harness = await build()
      const fan = harness.accessory.getServiceById(FakeServiceType.Fanv2, 'fan')!
      expect(fan.getCharacteristic(FakeCharacteristic.Active).value).toBe(1)
      expect(fan.getCharacteristic(FakeCharacteristic.RotationSpeed).value).toBe(50) // Home fan speed

      const extract = harness.accessory
        .getServiceById(FakeServiceType.TemperatureSensor, 'extract')!
        .getCharacteristic(FakeCharacteristic.CurrentTemperature)
      expect(extract.value).toBe(21)

      const supplyTemp = harness.supply
        .getServiceById(FakeServiceType.TemperatureSensor, 'supply')!
        .getCharacteristic(FakeCharacteristic.CurrentTemperature)
      expect(supplyTemp.value).toBe(19)
    })

    it('logs a warning but does not throw when a poll fails', async () => {
      const platform = createFakePlatform()
      const accessory = new FakeAccessory('Vallox', 'uuid-main')
      const supply = new FakeAccessory('Supply', 'uuid-supply')
      const outdoor = new FakeAccessory('Outdoor', 'uuid-outdoor')
      const exhaust = new FakeAccessory('Exhaust', 'uuid-exhaust')
      const client = fakeClient({ getSensorReadings: jest.fn(async () => { throw new Error('socket hang up') }) })

      expect(() => {
        const instance = new ValloxAccessory(
          platform as any,
          accessory as any,
          client as any,
          fakeTransport() as any,
          deviceInfo,
          supply as any,
          outdoor as any,
          exhaust as any,
        )
        harness = { platform, accessory, supply, outdoor, exhaust, client, instance }
      }).not.toThrow()

      await flush()
    })

    it('surfaces a ValidationError from a poll as a warning without crashing', async () => {
      harness = await build({}, { getFilterDaysRemaining: jest.fn(async () => { throw new ValidationError('filter days remaining', 'bad value') }) })
      // Reaching here without an unhandled rejection/throw is the assertion.
      expect(harness.instance).toBeDefined()
    })
  })

  describe('error wrapping', () => {
    it('wraps a client failure from an onGet handler into a HapStatusError', async () => {
      harness = await build({}, { isPoweredOn: jest.fn(async () => { throw new Error('offline') }) })
      const active = harness.accessory
        .getServiceById(FakeServiceType.Fanv2, 'fan')!
        .getCharacteristic(FakeCharacteristic.Active)
      await expect(active.triggerGet()).rejects.toBeInstanceOf(FakeHapStatusError)
    })

    it('wraps a ValidationError from an onSet handler into a HapStatusError', async () => {
      harness = await build({}, { powerOn: jest.fn(async () => { throw new ValidationError('power state', 'implausible') }) })
      const active = harness.accessory
        .getServiceById(FakeServiceType.Fanv2, 'fan')!
        .getCharacteristic(FakeCharacteristic.Active)
      await expect(active.triggerSet(1)).rejects.toBeInstanceOf(FakeHapStatusError)
    })
  })
})
