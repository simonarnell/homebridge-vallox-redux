import { existsSync, statSync, unlinkSync } from 'node:fs'
import { hostname as osHostname } from 'node:os'
import { join } from 'node:path'
import type { CharacteristicValue, Logger, PlatformAccessory, Service, WithUUID } from 'homebridge'
import { HAPStatus } from 'homebridge'
import fakegatoHistory, { type FakeGatoHistoryService } from 'fakegato-history'
import {
  HistoryChannel,
  Profile,
  ValidationError,
  type HistorySample,
  type SensorReadings,
  type ValloxClient,
  type WebSocketTransport,
} from 'vallox.js'
import type { ValloxHomebridgePlatform } from './platform.js'
import { attachProfileSwitches, type ProfileSwitchesController } from './profileSwitches.js'
import {
  DEFAULT_CO2_ALERT_PPM,
  DEFAULT_FILTER_ALERT_DAYS,
  DEFAULT_POLL_SECONDS,
  type ValloxAccessoryContext,
} from './settings.js'

/** Centikelvin → Celsius, matching vallox.js's own (private) conversion for live sensor registers. */
function centiKelvinToCelsius(cK: number): number {
  return (cK - 27315) / 100
}

/**
 * Works around a real bug in fakegato-history (github.com/simont77/fakegato-history, reported
 * upstream at PR #135): if a persist file exists but is empty — left behind by any interrupted
 * write, e.g. a process crash mid-save — its `load()` callback is silently never invoked at all
 * (`fs.readFile` resolves an empty file as `data: ""`, which is falsy, and the success branch
 * only calls back when `data` is truthy). Since that callback is the only place `this.loaded`
 * gets set to `true`, this leaves it permanently `false`, and every future `_addEntry()`/`save()`
 * call for that accessory retries forever every 100ms without ever succeeding — silently, no
 * error, no way to recover short of deleting the file.
 *
 * Works around it by deleting the empty file *before* fakegato-history ever tries to read it, so
 * `load()` hits its already-correct "file doesn't exist" path instead of the buggy "file exists
 * but is empty" one. Computes the exact same path fakegato-history's storage module would (see
 * its `hostname + '_' + accessoryName + '_persist.json'` naming), matching the accessory's
 * *current* displayName at construction time.
 */
function removeEmptyFakeGatoPersistFile(storagePath: string, accessoryDisplayName: string, log: Logger): void {
  const host = osHostname().split('.')[0]
  const filePath = join(storagePath, `${host}_${accessoryDisplayName}_persist.json`)
  try {
    if (existsSync(filePath) && statSync(filePath).size === 0) {
      unlinkSync(filePath)
      log.warn(
        `Removed an empty Eve history file (likely left by an interrupted previous write) so history for "${accessoryDisplayName}" can load: ${filePath}`,
      )
    }
  } catch (err) {
    // Best-effort — if this fails for any reason, fall through and let fakegato-history's own
    // load() handle it as-is; not worth failing accessory setup over a housekeeping step.
    log.debug(`Could not check/remove a stale empty Eve history file for "${accessoryDisplayName}":`, err)
  }
}

/**
 * Identity fields read from the unit once at startup. All optional — `getModel()` returns
 * `undefined` for a model code not in vallox.js's lookup table, and every field can fail
 * independently (or the whole set, if the unit is offline at startup) without blocking
 * accessory creation.
 */
export interface ValloxDeviceInfo {
  serial: string | undefined
  model: string | undefined
  firmwareVersion: string | undefined
}

interface EveHistoryEntry {
  time: number
  temp?: number
  humidity?: number
}

/**
 * Cap on how many entries backfillEveHistory() will seed per accessory. fakegato-history's
 * `_addEntry` triggers a full synchronous re-save of the accessory's *entire* history buffer on
 * every single call (see backfillEveHistory's doc comment) — backfilling the unit's full
 * multi-month log (thousands of samples) across several accessories at once means tens of
 * thousands of these full-buffer rewrites serialized through one global write lock, which is
 * enough real CPU/GC work to exhaust the heap. Backfill only exists so a graph doesn't start
 * empty, not to front-load the entire history in one burst — live polling fills the rest in over
 * time regardless, so a modest recent window is enough.
 */
const MAX_BACKFILL_ENTRIES = 500

/**
 * The unit logs one channel per sample; Eve's 'room' entries need temp/humidity combined into a
 * single record per timestamp. Samples missing a temperature reading are dropped — humidity is a
 * "max within the minute" value the unit itself only records alongside a temp sample, so a
 * temp-less group is an incomplete/misaligned one, not a legitimate all-blank entry.
 *
 * CO2 is deliberately not tracked in history. Both 'room' (`ppm`) and 'room2' (`voc`, CO2 fed
 * into the VOC slot on the theory that a real, currently-sold Eve product's field might have
 * working graph support where 'room''s doesn't) were tried, including a full remove-and-re-pair
 * to rule out Eve caching a stale accessory-type declaration — neither produced a graph in Eve,
 * just a live reading with no history line and no drill-down. CO2 stays available as a live
 * HomeKit CarbonDioxideSensor reading; it's just not part of the history stream.
 */
function groupHistorySamples(samples: readonly HistorySample[]): EveHistoryEntry[] {
  const byMinute = new Map<number, EveHistoryEntry>()

  for (const sample of samples) {
    const time = Math.round(sample.timestamp.getTime() / 1000)
    const entry = byMinute.get(time) ?? { time }

    switch (sample.channel) {
      case HistoryChannel.EXTRACT_AIR_TEMP:
        entry.temp = centiKelvinToCelsius(sample.value)
        break
      case HistoryChannel.MAX_HUMIDITY:
        entry.humidity = sample.value
        break
      default:
        continue
    }

    byMinute.set(time, entry)
  }

  return [...byMinute.values()]
    .filter((entry) => entry.temp !== undefined)
    .sort((a, b) => a.time - b.time)
    .slice(-MAX_BACKFILL_ENTRIES)
}

/** A single-channel satellite sensor's history is just that one temp channel, verbatim. */
function groupSingleTempHistorySamples(samples: readonly HistorySample[], channel: HistoryChannel): EveHistoryEntry[] {
  return samples
    .filter((sample) => sample.channel === channel)
    .map((sample) => ({
      time: Math.round(sample.timestamp.getTime() / 1000),
      temp: centiKelvinToCelsius(sample.value),
    }))
    .sort((a, b) => a.time - b.time)
    .slice(-MAX_BACKFILL_ENTRIES)
}

interface SatelliteSpec {
  key: 'supply' | 'outdoor' | 'exhaust'
  name: string
  field: keyof SensorReadings
  historyChannel: HistoryChannel
}

// Each gets its own accessory (not just its own service on a shared one) for two reasons: the
// Home app groups sibling services from one accessory as a single movable unit when reassigning
// rooms, and Eve's History service is per-accessory, so sensors sharing an accessory also share
// one graph. Extract stays on the main accessory alongside Humidity/CO2 deliberately — same
// physical measurement point, so a shared graph there is correct, unlike these three, which are
// genuinely different readings that were wrongly sharing a graph before this split.
const SATELLITE_SENSORS: SatelliteSpec[] = [
  { key: 'supply', name: 'Supply Air', field: 'supplyAirTemp', historyChannel: HistoryChannel.SUPPLY_AIR_TEMP },
  { key: 'outdoor', name: 'Outdoor Air', field: 'outdoorAirTemp', historyChannel: HistoryChannel.OUTDOOR_AIR_TEMP },
  { key: 'exhaust', name: 'Exhaust Air', field: 'exhaustAirTemp', historyChannel: HistoryChannel.EXHAUST_AIR_TEMP },
]

interface Satellite {
  spec: SatelliteSpec
  accessory: PlatformAccessory<ValloxAccessoryContext>
  tempService: Service
  history?: FakeGatoHistoryService
}

export class ValloxAccessory {
  private readonly fanService: Service
  private readonly customSupplyFanService: Service
  private readonly extractTempService: Service
  private readonly humidityService?: Service
  private readonly co2Service?: Service
  private readonly filterService: Service
  private readonly supplyThermostatService: Service
  private readonly profileSwitches: ProfileSwitchesController
  private readonly history?: FakeGatoHistoryService
  private readonly satellites: Satellite[]

  private lastKnownProfile: Profile = Profile.NONE
  private lastKnownFanPct = 0
  private lastKnownCustomSupplyFanPct = 0
  private lastKnownSupplyTempSetpoint = 18
  private pollHandle?: NodeJS.Timeout
  private timeSyncHandle?: NodeJS.Timeout

  constructor(
    private readonly platform: ValloxHomebridgePlatform,
    private readonly accessory: PlatformAccessory<ValloxAccessoryContext>,
    private readonly client: ValloxClient,
    private readonly transport: WebSocketTransport,
    deviceInfo: ValloxDeviceInfo,
    supplyAccessory: PlatformAccessory<ValloxAccessoryContext>,
    outdoorAccessory: PlatformAccessory<ValloxAccessoryContext>,
    exhaustAccessory: PlatformAccessory<ValloxAccessoryContext>,
  ) {
    const { serial, model, firmwareVersion } = deviceInfo
    const enableEveHistory = this.platform.configOption('enableEveHistory', false)

    accessory
      .getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Vallox')
      .setCharacteristic(this.platform.Characteristic.Model, model ?? 'MVHR (WebSocket)')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, serial ?? accessory.context.host)
      .setCharacteristic(this.platform.Characteristic.FirmwareRevision, firmwareVersion ?? '0.0.0')

    this.fanService = this.setupFan()
    this.customSupplyFanService = this.setupCustomSupplyFan()
    this.pruneStaleTempSensors(this.accessory, ['extract'])
    this.extractTempService = this.setupTempSensor(this.accessory, 'Extract Air', 'extract', 'extractAirTemp')

    if (this.platform.configOption('enableHumiditySensor', true)) {
      this.humidityService = this.setupHumiditySensor()
    }
    if (this.platform.configOption('enableCo2Sensor', true)) {
      this.co2Service = this.setupCo2Sensor()
    }

    this.filterService = this.setupFilterMaintenance()

    const satelliteAccessories = { supply: supplyAccessory, outdoor: outdoorAccessory, exhaust: exhaustAccessory }
    this.satellites = SATELLITE_SENSORS.map((spec) => {
      const satAccessory = satelliteAccessories[spec.key]
      this.setupSatelliteAccessoryInfo(satAccessory, model, firmwareVersion, spec.name)
      this.pruneStaleTempSensors(satAccessory, [spec.key])
      const tempService = this.setupTempSensor(satAccessory, spec.name, spec.key, spec.field)
      const history = enableEveHistory ? this.setupEveHistoryService(satAccessory, 'room') : undefined
      return { spec, accessory: satAccessory, tempService, history }
    })

    this.supplyThermostatService = this.setupSupplyTempSetpoint(supplyAccessory)

    if (enableEveHistory) {
      this.history = this.setupEveHistoryService(this.accessory, 'room')
      void this.backfillEveHistory()
    }

    this.profileSwitches = attachProfileSwitches(
      platform,
      accessory,
      client,
      () => this.lastKnownProfile,
      () => void this.pollOnce(),
    )

    this.startPolling()

    if (this.platform.configOption('enableDailyTimeSync', true)) {
      this.startDailyTimeSync()
    }
  }

  // ---------------------------------------------------------------------
  // Service setup
  // ---------------------------------------------------------------------

  private setupSatelliteAccessoryInfo(
    satAccessory: PlatformAccessory<ValloxAccessoryContext>,
    model: string | undefined,
    firmwareVersion: string | undefined,
    sensorName: string,
  ): void {
    satAccessory
      .getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Vallox')
      .setCharacteristic(this.platform.Characteristic.Model, model ? `${model} (${sensorName})` : `${sensorName} Sensor`)
      .setCharacteristic(
        this.platform.Characteristic.SerialNumber,
        satAccessory.context.serial ?? satAccessory.context.host,
      )
      .setCharacteristic(this.platform.Characteristic.FirmwareRevision, firmwareVersion ?? '0.0.0')
  }

  /**
   * Removes any TemperatureSensor service on `accessory` whose subtype isn't in
   * `expectedSubtypes`. Homebridge's accessory cache persists whatever services a previous
   * version of this plugin created; when a temp sensor moves to a different accessory (as
   * Supply/Outdoor/Exhaust did, off the main accessory and onto their own), the old service isn't
   * automatically cleaned up — it just sits there orphaned, stale, and confusing in the Home app,
   * since nothing updates its characteristics anymore. Called before (re)creating this
   * accessory's own expected sensors, so a genuinely-expected one being briefly absent from cache
   * never gets pruned by mistake.
   */
  private pruneStaleTempSensors(accessory: PlatformAccessory<ValloxAccessoryContext>, expectedSubtypes: string[]): void {
    for (const service of accessory.services) {
      if (
        service.UUID === this.platform.Service.TemperatureSensor.UUID &&
        !expectedSubtypes.includes(service.subtype ?? '')
      ) {
        accessory.removeService(service)
      }
    }
  }

  /**
   * Resolves a service by subtype, creating it if needed, and always (re)sets
   * its Name characteristic. A service restored from Homebridge's persisted
   * accessory cache keeps whatever Name it was originally given — skipping
   * this on the cached path would leave a stale/wrong name (e.g. every
   * TemperatureSensor showing the accessory's own display name in the Home
   * app) stuck forever across restarts.
   */
  private getOrAddService(
    accessory: PlatformAccessory<ValloxAccessoryContext>,
    serviceClass: WithUUID<typeof Service>,
    name: string,
    subtype: string,
  ): Service {
    const service = accessory.getServiceById(serviceClass, subtype) ?? accessory.addService(serviceClass, name, subtype)
    // ConfiguredName as well as Name: the Home/Eve apps auto-label multiple services of the same
    // type on one accessory by position ("Temperature Sensor 2") rather than respecting Name,
    // once that label has ever been assigned — ConfiguredName is the newer characteristic Apple
    // added specifically so a custom name sticks in that situation too.
    service
      .setCharacteristic(this.platform.Characteristic.Name, name)
      .setCharacteristic(this.platform.Characteristic.ConfiguredName, name)
    return service
  }

  /**
   * Wires Active (on/off) identically for any Fanv2 service on this accessory — both the main fan
   * and the Custom Supply fan are just two control surfaces onto the same physical unit's single
   * power state, so turning either one on/off does the same powerOn()/powerOff().
   */
  private wireFanActive(service: Service): void {
    service
      .getCharacteristic(this.platform.Characteristic.Active)
      .onGet(() => this.wrap(async () => ((await this.client.isPoweredOn()) ? 1 : 0)))
      .onSet((value: CharacteristicValue) =>
        this.wrap(async () => {
          if (value) {
            await this.client.powerOn()
          } else {
            await this.client.powerOff()
          }
          void this.pollOnce()
        }),
      )
  }

  private setupFan(): Service {
    const service = this.getOrAddService(this.accessory, this.platform.Service.Fanv2, 'Vallox Fan', 'fan')

    this.wireFanActive(service)

    // Standard optional HAP characteristic for reporting a general problem on this service —
    // driven by client.getCriticalFaultActive() during polling (see pollOnce).
    service.getCharacteristic(this.platform.Characteristic.StatusFault)

    service
      .getCharacteristic(this.platform.Characteristic.RotationSpeed)
      .setProps({ minStep: 1 })
      .onGet(() => this.lastKnownFanPct)
      .onSet((value: CharacteristicValue) =>
        this.wrap(async () => {
          const pct = Math.round(value as number)
          switch (this.lastKnownProfile) {
            case Profile.HOME:
              await this.client.setHomeFanSpeed(pct)
              break
            case Profile.AWAY:
              await this.client.setAwayFanSpeed(pct)
              break
            case Profile.BOOST:
              await this.client.setBoostFanSpeed(pct)
              break
            case Profile.CUSTOM:
              // Custom has independently settable extract/supply speeds; the main fan's
              // RotationSpeed controls the extract side (paired with this accessory's own
              // Extract Air sensor) — see setupCustomSupplyFan() for the supply side.
              await this.client.setCustomExtractFanSpeed(pct)
              break
            default:
              this.platform.log.debug(
                `RotationSpeed set ignored: no fan-speed setter for profile ${this.lastKnownProfile}`,
              )
              return
          }
          void this.pollOnce()
        }),
      )

    return service
  }

  /**
   * A second Fanv2 service exposing Custom mode's independently-settable supply-side fan speed
   * (client.getCustomSupplyFanSpeed/setCustomSupplyFanSpeed) — HomeKit's RotationSpeed is a single
   * number, so Custom's extract/supply split needs two Fanv2 services rather than one. Active
   * mirrors the main fan's power state since both are the same physical unit.
   */
  private setupCustomSupplyFan(): Service {
    const service = this.getOrAddService(
      this.accessory,
      this.platform.Service.Fanv2,
      'Custom Supply Fan',
      'fan-custom-supply',
    )

    this.wireFanActive(service)

    service
      .getCharacteristic(this.platform.Characteristic.RotationSpeed)
      .setProps({ minStep: 1 })
      .onGet(() => this.lastKnownCustomSupplyFanPct)
      .onSet((value: CharacteristicValue) =>
        this.wrap(async () => {
          if (this.lastKnownProfile !== Profile.CUSTOM) {
            this.platform.log.debug('Custom Supply Fan RotationSpeed set ignored: unit is not in Custom profile')
            return
          }
          await this.client.setCustomSupplyFanSpeed(Math.round(value as number))
          void this.pollOnce()
        }),
      )

    return service
  }

  private setupTempSensor(
    accessory: PlatformAccessory<ValloxAccessoryContext>,
    name: string,
    subtype: string,
    field: keyof SensorReadings,
  ): Service {
    const service = this.getOrAddService(accessory, this.platform.Service.TemperatureSensor, name, subtype)

    service
      .getCharacteristic(this.platform.Characteristic.CurrentTemperature)
      .onGet(() => this.wrap(async () => (await this.client.getSensorReadings())[field] as number))

    return service
  }

  private setupHumiditySensor(): Service {
    const service = this.getOrAddService(this.accessory, this.platform.Service.HumiditySensor, 'Humidity', 'humidity')

    service
      .getCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity)
      .onGet(() => this.wrap(async () => (await this.client.getSensorReadings()).humidity))

    return service
  }

  /**
   * `CarbonDioxideDetected` uses the plugin's own `co2AlertPpm` config option, not
   * `client.getCo2Threshold()` — that's the unit's own auto-boost trigger, tuned to kick in
   * proactively well before air quality is actually a problem, and iOS pushes a device
   * notification the moment this characteristic flips to abnormal. Reusing the boost trigger as
   * the HomeKit alert threshold meant a routine, brief boost-level reading (e.g. 800ppm) paged
   * your phone as if it were a real air-quality concern.
   */
  private setupCo2Sensor(): Service {
    const service = this.getOrAddService(this.accessory, this.platform.Service.CarbonDioxideSensor, 'CO2', 'co2')

    service
      .getCharacteristic(this.platform.Characteristic.CarbonDioxideLevel)
      .onGet(() => this.wrap(async () => (await this.client.getSensorReadings()).co2))

    service
      .getCharacteristic(this.platform.Characteristic.CarbonDioxideDetected)
      .onGet(() =>
        this.wrap(async () => {
          const reading = await this.client.getSensorReadings()
          const alertPpm = this.platform.configOption('co2AlertPpm', DEFAULT_CO2_ALERT_PPM)
          return reading.co2 >= alertPpm
            ? this.platform.Characteristic.CarbonDioxideDetected.CO2_LEVELS_ABNORMAL
            : this.platform.Characteristic.CarbonDioxideDetected.CO2_LEVELS_NORMAL
        }),
      )

    return service
  }

  /**
   * A Thermostat service on the Supply Air satellite accessory, repurposed purely for its
   * TargetTemperature/CurrentTemperature characteristics — HAP has no plain "setpoint" service.
   * TargetHeatingCoolingState is pinned to HEAT (the unit doesn't heat/cool; this just satisfies
   * the service's required characteristics and stops Home offering an Off/Cool/Auto the unit
   * doesn't support). TargetTemperature mirrors whichever profile is currently active, the same
   * way the main fan's RotationSpeed already does.
   */
  private setupSupplyTempSetpoint(satAccessory: PlatformAccessory<ValloxAccessoryContext>): Service {
    const service = this.getOrAddService(
      satAccessory,
      this.platform.Service.Thermostat,
      'Supply Air Setpoint',
      'supply-setpoint',
    )

    service
      .getCharacteristic(this.platform.Characteristic.CurrentTemperature)
      .onGet(() => this.wrap(async () => (await this.client.getSensorReadings()).supplyAirTemp))

    service
      .getCharacteristic(this.platform.Characteristic.TargetTemperature)
      .onGet(() => this.lastKnownSupplyTempSetpoint)
      .onSet((value: CharacteristicValue) =>
        this.wrap(async () => {
          const celsius = value as number
          switch (this.lastKnownProfile) {
            case Profile.HOME:
              await this.client.setHomeSupplyTemp(celsius)
              break
            case Profile.AWAY:
              await this.client.setAwaySupplyTemp(celsius)
              break
            case Profile.BOOST:
              await this.client.setBoostSupplyTemp(celsius)
              break
            case Profile.CUSTOM:
              await this.client.setCustomSupplyTemp(celsius)
              break
            default:
              this.platform.log.debug(
                `TargetTemperature set ignored: no supply-temp setter for profile ${this.lastKnownProfile}`,
              )
              return
          }
          void this.pollOnce()
        }),
      )

    service
      .getCharacteristic(this.platform.Characteristic.TargetHeatingCoolingState)
      .setProps({ validValues: [this.platform.Characteristic.TargetHeatingCoolingState.HEAT] })
      .onGet(() => this.platform.Characteristic.TargetHeatingCoolingState.HEAT)

    service
      .getCharacteristic(this.platform.Characteristic.CurrentHeatingCoolingState)
      .onGet(() => this.platform.Characteristic.CurrentHeatingCoolingState.HEAT)

    service
      .getCharacteristic(this.platform.Characteristic.TemperatureDisplayUnits)
      .onGet(() => this.platform.Characteristic.TemperatureDisplayUnits.CELSIUS)

    return service
  }

  private setupFilterMaintenance(): Service {
    const service = this.getOrAddService(this.accessory, this.platform.Service.FilterMaintenance, 'Filter', 'filter')

    service
      .getCharacteristic(this.platform.Characteristic.FilterChangeIndication)
      .onGet(() =>
        this.wrap(async () => {
          const days = await this.client.getFilterDaysRemaining()
          const threshold = this.platform.configOption('filterAlertDays', DEFAULT_FILTER_ALERT_DAYS)
          return days <= threshold
            ? this.platform.Characteristic.FilterChangeIndication.CHANGE_FILTER
            : this.platform.Characteristic.FilterChangeIndication.FILTER_OK
        }),
      )

    return service
  }

  /**
   * Eve app history graphs (Eve-only — invisible in the stock Home app; see
   * https://github.com/simont77/fakegato-history). Always 'room' type: Eve's 'weather' type
   * expects temp+humidity+pressure together (mirroring real Eve Weather hardware) and appears to
   * refuse to render when only temp is ever populated, which is all any satellite has. 'room'
   * with humidity/ppm simply never set renders fine. See groupHistorySamples' doc comment for why
   * CO2 is deliberately excluded from the main accessory's history rather than fed in as `ppm`.
   *
   * The FakeGatoHistory constructor registers its own History service on the accessory
   * internally (get-or-add by UUID+subtype, called unconditionally from its constructor) — do
   * not also call `accessory.addService()` on the returned object, or the accessory ends up with
   * two services sharing that UUID and HAP-NodeJS throws.
   */
  private setupEveHistoryService(
    accessory: PlatformAccessory<ValloxAccessoryContext>,
    type: 'room',
  ): FakeGatoHistoryService {
    removeEmptyFakeGatoPersistFile(this.platform.api.user.storagePath(), accessory.displayName, this.platform.log)
    const FakeGatoHistory = fakegatoHistory(this.platform.api)
    return new FakeGatoHistory(type, accessory, {
      storage: 'fs',
      log: this.platform.log,
    })
  }

  /**
   * Seeds every Eve history graph from the unit's own on-device log, so they don't start empty
   * on every Homebridge restart. Uses `_addEntry` (undocumented) rather than `addEntry`, because
   * `addEntry` routes entries through fakegato's averaging timer, which stamps entries with
   * wall-clock "now" rather than the historical timestamp we're supplying.
   */
  private async backfillEveHistory(): Promise<void> {
    try {
      const samples = await this.transport.getHistory()

      for (const entry of groupHistorySamples(samples)) {
        this.history?._addEntry(entry)
      }
      for (const satellite of this.satellites) {
        for (const entry of groupSingleTempHistorySamples(samples, satellite.spec.historyChannel)) {
          satellite.history?._addEntry(entry)
        }
      }
    } catch (err) {
      this.platform.log.warn(
        "Could not backfill Eve history from the unit's own log (continuing with live logging only):",
        (err as Error).message,
      )
    }
  }

  // ---------------------------------------------------------------------
  // Polling
  // ---------------------------------------------------------------------

  private startPolling(): void {
    const seconds = this.platform.configOption('pollingIntervalSeconds', DEFAULT_POLL_SECONDS)
    this.pollHandle = setInterval(() => void this.pollOnce(), seconds * 1000)
    void this.pollOnce()
  }

  private async pollOnce(): Promise<void> {
    try {
      const [powered, profile, readings, filterDays, criticalFault] = await Promise.all([
        this.client.isPoweredOn(),
        this.client.getProfile(),
        this.client.getSensorReadings(),
        this.client.getFilterDaysRemaining(),
        this.client.getCriticalFaultActive(),
      ])

      this.lastKnownProfile = profile
      if (profile === Profile.HOME || profile === Profile.AWAY || profile === Profile.BOOST || profile === Profile.CUSTOM) {
        this.lastKnownFanPct = await this.fanSpeedForProfile(profile)
        this.lastKnownSupplyTempSetpoint = await this.supplyTempForProfile(profile)
      }
      // EXTRA/AUTOMATIC/NONE: no fan-speed/supply-temp getter/setter exists — freeze at last known value.

      if (profile === Profile.CUSTOM) {
        this.lastKnownCustomSupplyFanPct = await this.client.getCustomSupplyFanSpeed()
      }
      // Only Custom has an independently-settable supply-side fan speed; freeze otherwise.

      this.fanService.updateCharacteristic(this.platform.Characteristic.Active, powered ? 1 : 0)
      this.fanService.updateCharacteristic(this.platform.Characteristic.RotationSpeed, this.lastKnownFanPct)
      this.fanService.updateCharacteristic(
        this.platform.Characteristic.StatusFault,
        criticalFault
          ? this.platform.Characteristic.StatusFault.GENERAL_FAULT
          : this.platform.Characteristic.StatusFault.NO_FAULT,
      )

      this.customSupplyFanService.updateCharacteristic(this.platform.Characteristic.Active, powered ? 1 : 0)
      this.customSupplyFanService.updateCharacteristic(
        this.platform.Characteristic.RotationSpeed,
        this.lastKnownCustomSupplyFanPct,
      )

      this.supplyThermostatService.updateCharacteristic(
        this.platform.Characteristic.CurrentTemperature,
        readings.supplyAirTemp,
      )
      this.supplyThermostatService.updateCharacteristic(
        this.platform.Characteristic.TargetTemperature,
        this.lastKnownSupplyTempSetpoint,
      )

      this.extractTempService.updateCharacteristic(
        this.platform.Characteristic.CurrentTemperature,
        readings.extractAirTemp,
      )

      for (const satellite of this.satellites) {
        satellite.tempService.updateCharacteristic(
          this.platform.Characteristic.CurrentTemperature,
          readings[satellite.spec.field] as number,
        )
        satellite.history?.addEntry({
          time: Math.round(Date.now() / 1000),
          temp: readings[satellite.spec.field] as number,
        })
      }

      this.humidityService?.updateCharacteristic(
        this.platform.Characteristic.CurrentRelativeHumidity,
        readings.humidity,
      )

      if (this.co2Service) {
        const alertPpm = this.platform.configOption('co2AlertPpm', DEFAULT_CO2_ALERT_PPM)
        this.co2Service.updateCharacteristic(this.platform.Characteristic.CarbonDioxideLevel, readings.co2)
        this.co2Service.updateCharacteristic(
          this.platform.Characteristic.CarbonDioxideDetected,
          readings.co2 >= alertPpm
            ? this.platform.Characteristic.CarbonDioxideDetected.CO2_LEVELS_ABNORMAL
            : this.platform.Characteristic.CarbonDioxideDetected.CO2_LEVELS_NORMAL,
        )
      }

      const filterAlertDays = this.platform.configOption('filterAlertDays', DEFAULT_FILTER_ALERT_DAYS)
      this.filterService.updateCharacteristic(
        this.platform.Characteristic.FilterChangeIndication,
        filterDays <= filterAlertDays
          ? this.platform.Characteristic.FilterChangeIndication.CHANGE_FILTER
          : this.platform.Characteristic.FilterChangeIndication.FILTER_OK,
      )

      this.profileSwitches.updateFromPoll(profile)

      this.history?.addEntry({
        time: Math.round(Date.now() / 1000),
        temp: readings.extractAirTemp,
        humidity: readings.humidity,
      })

      if (criticalFault) {
        const faults = await this.client.getFaults()
        this.platform.log.warn('Vallox reports a critical fault active:', faults.filter((f) => f.isActive))
      }
    } catch (err) {
      if (err instanceof ValidationError) {
        this.platform.log.warn(
          'Vallox poll got implausible data from the unit (possible firmware/protocol issue), will retry next interval:',
          err.message,
        )
      } else {
        this.platform.log.warn('Vallox poll failed (will retry next interval):', (err as Error).message)
      }
    }
  }

  // ---------------------------------------------------------------------
  // Daily clock sync
  // ---------------------------------------------------------------------

  /**
   * The unit has no RTC or NTP client — its internal clock free-runs off its own oscillator and
   * drifts over time, which throws off the weekly schedule (it fires by the unit's own idea of
   * the current hour). Syncs once at startup and once every 24h after that, to this computer's
   * clock (itself assumed to be NTP-synced, which is true for virtually every modern OS).
   */
  private startDailyTimeSync(): void {
    const ONE_DAY_MS = 24 * 60 * 60 * 1000
    this.timeSyncHandle = setInterval(() => void this.syncDeviceTime(), ONE_DAY_MS)
    void this.syncDeviceTime()
  }

  private async syncDeviceTime(): Promise<void> {
    try {
      const before = await this.client.getDeviceTime()
      const now = new Date()
      await this.client.setDeviceTime(now)
      const driftSeconds = Math.round((now.getTime() - before.getTime()) / 1000)
      this.platform.log.info(
        `Synced Vallox unit clock (was ${driftSeconds >= 0 ? 'behind' : 'ahead'} by ${Math.abs(driftSeconds)}s)`,
      )
    } catch (err) {
      if (err instanceof ValidationError) {
        this.platform.log.warn(
          'Vallox clock sync got implausible data from the unit (possible firmware/protocol issue), will retry next interval:',
          err.message,
        )
      } else {
        this.platform.log.warn('Vallox clock sync failed (will retry next interval):', (err as Error).message)
      }
    }
  }

  private fanSpeedForProfile(
    profile: typeof Profile.HOME | typeof Profile.AWAY | typeof Profile.BOOST | typeof Profile.CUSTOM,
  ): Promise<number> {
    switch (profile) {
      case Profile.HOME:
        return this.client.getHomeFanSpeed()
      case Profile.AWAY:
        return this.client.getAwayFanSpeed()
      case Profile.BOOST:
        return this.client.getBoostFanSpeed()
      default:
        // Custom's main (extract-side) speed — see setupFan()'s RotationSpeed handler.
        return this.client.getCustomExtractFanSpeed()
    }
  }

  private supplyTempForProfile(
    profile: typeof Profile.HOME | typeof Profile.AWAY | typeof Profile.BOOST | typeof Profile.CUSTOM,
  ): Promise<number> {
    switch (profile) {
      case Profile.HOME:
        return this.client.getHomeSupplyTemp()
      case Profile.AWAY:
        return this.client.getAwaySupplyTemp()
      case Profile.BOOST:
        return this.client.getBoostSupplyTemp()
      default:
        return this.client.getCustomSupplyTemp()
    }
  }

  // ---------------------------------------------------------------------
  // Error handling
  // ---------------------------------------------------------------------

  private async wrap<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (err) {
      if (err instanceof ValidationError) {
        this.platform.log.error('Vallox command got implausible data from the unit:', err.message)
      } else {
        this.platform.log.error('Vallox command failed:', (err as Error).message)
      }
      throw new this.platform.api.hap.HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE)
    }
  }
}
