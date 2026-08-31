import type {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
  Service,
} from 'homebridge'
import { ValloxClient, WebSocketTransport } from 'vallox.js'
import { parseConfig } from './config.js'
import {
  DEFAULT_PORT,
  PLATFORM_NAME,
  PLUGIN_NAME,
  type ValloxAccessoryContext,
  type ValloxPlatformConfig,
} from './settings.js'
import { type ValloxDeviceInfo, ValloxAccessory } from './valloxAccessory.js'

export class ValloxHomebridgePlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service
  public readonly Characteristic: typeof Characteristic
  public readonly accessories: PlatformAccessory[] = []
  private readonly valloxConfig: ValloxPlatformConfig | undefined

  constructor(
    public readonly log: Logger,
    config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service
    this.Characteristic = api.hap.Characteristic
    this.valloxConfig = parseConfig(config, (message) => this.log.error(message))

    if (this.valloxConfig) {
      this.api.on('didFinishLaunching', () => {
        void this.discoverDevices()
      })
    }
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.accessories.push(accessory)
  }

  configOption<T>(key: keyof ValloxPlatformConfig, fallback: T): T {
    const value = this.valloxConfig?.[key]
    return (value as T | undefined) ?? fallback
  }

  private async discoverDevices(): Promise<void> {
    const config = this.valloxConfig
    if (!config) {
      return
    }

    const host = config.host
    const port = config.port ?? DEFAULT_PORT

    // The library opens and closes its own WebSocket connection per call, so there is no
    // connect()/dispose() lifecycle to manage here or on Homebridge shutdown.
    const transport = new WebSocketTransport({ host, port })
    const client = new ValloxClient(transport)

    let serial: string | undefined
    try {
      serial = await client.getSerialNumber('decimal')
    } catch (err) {
      this.log.warn(
        `Could not read Vallox serial number (unit offline at startup?) — falling back to host:port for accessory identity: ${(err as Error).message}`,
      )
    }

    // Best-effort — a unit online enough for the serial number above may still be running
    // firmware old enough to be missing from vallox.js's model lookup table, or momentarily
    // fail just this one call. Neither should block accessory creation.
    const [model, firmwareVersion] = await Promise.all([
      client.getModel().catch(() => undefined),
      client.getSoftwareVersion().catch(() => undefined),
    ])
    const deviceInfo: ValloxDeviceInfo = { serial, model, firmwareVersion }

    const uuidSeed = serial ?? `${host}:${port}`
    const uuid = this.api.hap.uuid.generate(uuidSeed)

    const existing = this.findAccessory(uuid)
    // getModel() already returns the full branded name (e.g. "Vallox 110 MV"), not just a bare
    // model code — no "Vallox " prefix needed here, unlike the satellite/external accessory names
    // elsewhere, which use plain sensor names with no brand of their own.
    const defaultName = model ?? 'Vallox Redux'
    const accessory =
      existing ?? new this.api.platformAccessory<ValloxAccessoryContext>(config.name ?? defaultName, uuid)
    accessory.context.host = host
    accessory.context.port = port
    accessory.context.serial = serial

    const newAccessories: PlatformAccessory[] = existing ? [] : [accessory]

    // Separate accessories for Supply/Outdoor/Exhaust (rather than more services on the one
    // above): the Home app groups sibling services from one accessory as a single movable unit
    // when reassigning rooms, and Eve's History service is per-accessory, so sensors sharing an
    // accessory also share one room-reassignment target and one Eve history graph. Splitting
    // each into its own accessory gives each an independently placeable room and its own graph.
    // Always created (not gated behind enableEveHistory) — the room-placement half of this
    // benefits every install, not just history. Extract stays on the main accessory alongside
    // Humidity/CO2 deliberately — same physical measurement point, so one shared graph is correct
    // there, unlike Supply/Outdoor/Exhaust which are genuinely different readings.
    const supply = this.getOrCreateSatelliteAccessory('supply', 'Vallox Supply Air', uuidSeed, host, port, serial)
    const outdoor = this.getOrCreateSatelliteAccessory('outdoor', 'Vallox Outdoor Air', uuidSeed, host, port, serial)
    const exhaust = this.getOrCreateSatelliteAccessory('exhaust', 'Vallox Exhaust Air', uuidSeed, host, port, serial)
    for (const satellite of [supply, outdoor, exhaust]) {
      if (satellite.isNew) {
        newAccessories.push(satellite.accessory)
      }
    }

    new ValloxAccessory(
      this,
      accessory,
      client,
      transport,
      deviceInfo,
      supply.accessory,
      outdoor.accessory,
      exhaust.accessory,
    )

    if (newAccessories.length) {
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, newAccessories)
    }

    const wantedUuids = new Set([uuid, supply.accessory.UUID, outdoor.accessory.UUID, exhaust.accessory.UUID])
    const stale = this.accessories.filter((a) => !wantedUuids.has(a.UUID))
    if (stale.length) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale)
    }
  }

  private getOrCreateSatelliteAccessory(
    key: string,
    displayName: string,
    uuidSeed: string,
    host: string,
    port: number,
    serial: string | undefined,
  ): { accessory: PlatformAccessory<ValloxAccessoryContext>; isNew: boolean } {
    const uuid = this.api.hap.uuid.generate(`${uuidSeed}:${key}`)
    const existing = this.findAccessory(uuid)
    const accessory = existing ?? new this.api.platformAccessory<ValloxAccessoryContext>(displayName, uuid)
    accessory.context.host = host
    accessory.context.port = port
    accessory.context.serial = serial
    return { accessory, isNew: !existing }
  }

  private findAccessory(uuid: string): PlatformAccessory<ValloxAccessoryContext> | undefined {
    return this.accessories.find((a) => a.UUID === uuid) as PlatformAccessory<ValloxAccessoryContext> | undefined
  }
}
