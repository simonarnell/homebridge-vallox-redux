/**
 * Hand-rolled fakes standing in for the parts of Homebridge/HAP-NodeJS this
 * plugin touches (Service, Characteristic, PlatformAccessory, the platform's
 * `api`/`log`). Kept deliberately simple — real HAP-level behavior (UUIDs,
 * characteristic perms, actual pairing) is exercised by the testcontainers
 * integration suite instead; these unit tests only need enough fidelity to
 * drive this plugin's own logic (onGet/onSet wiring, updateCharacteristic
 * calls, service/accessory bookkeeping).
 */

export interface CharacteristicDef {
  readonly name: string
  readonly UUID: string
  readonly [staticValue: string]: unknown
}

function characteristicDef(name: string, statics: Record<string, number> = {}): CharacteristicDef {
  return { name, UUID: name, ...statics }
}

export const FakeCharacteristic = {
  Name: characteristicDef('Name'),
  ConfiguredName: characteristicDef('ConfiguredName'),
  Manufacturer: characteristicDef('Manufacturer'),
  Model: characteristicDef('Model'),
  SerialNumber: characteristicDef('SerialNumber'),
  FirmwareRevision: characteristicDef('FirmwareRevision'),
  Active: characteristicDef('Active'),
  RotationSpeed: characteristicDef('RotationSpeed'),
  CurrentTemperature: characteristicDef('CurrentTemperature'),
  CurrentRelativeHumidity: characteristicDef('CurrentRelativeHumidity'),
  CarbonDioxideLevel: characteristicDef('CarbonDioxideLevel'),
  CarbonDioxideDetected: characteristicDef('CarbonDioxideDetected', {
    CO2_LEVELS_NORMAL: 0,
    CO2_LEVELS_ABNORMAL: 1,
  }),
  FilterChangeIndication: characteristicDef('FilterChangeIndication', {
    FILTER_OK: 0,
    CHANGE_FILTER: 1,
  }),
  On: characteristicDef('On'),
  StatusFault: characteristicDef('StatusFault', {
    NO_FAULT: 0,
    GENERAL_FAULT: 1,
  }),
  TargetTemperature: characteristicDef('TargetTemperature'),
  TargetHeatingCoolingState: characteristicDef('TargetHeatingCoolingState', {
    OFF: 0,
    HEAT: 1,
    COOL: 2,
    AUTO: 3,
  }),
  CurrentHeatingCoolingState: characteristicDef('CurrentHeatingCoolingState', {
    OFF: 0,
    HEAT: 1,
    COOL: 2,
  }),
  TemperatureDisplayUnits: characteristicDef('TemperatureDisplayUnits', {
    CELSIUS: 0,
    FAHRENHEIT: 1,
  }),
} as const

export interface ServiceDef {
  readonly name: string
  readonly UUID: string
}

function serviceDef(name: string): ServiceDef {
  return { name, UUID: name }
}

export const FakeServiceType = {
  AccessoryInformation: serviceDef('AccessoryInformation'),
  Fanv2: serviceDef('Fanv2'),
  TemperatureSensor: serviceDef('TemperatureSensor'),
  HumiditySensor: serviceDef('HumiditySensor'),
  CarbonDioxideSensor: serviceDef('CarbonDioxideSensor'),
  FilterMaintenance: serviceDef('FilterMaintenance'),
  Switch: serviceDef('Switch'),
  Thermostat: serviceDef('Thermostat'),
} as const

type GetHandler = () => unknown | Promise<unknown>
type SetHandler = (value: unknown) => unknown | Promise<unknown>

export class FakeCharacteristicInstance {
  value: unknown
  props: Record<string, unknown> = {}
  #getHandler?: GetHandler
  #setHandler?: SetHandler

  constructor(public readonly def: CharacteristicDef) {}

  onGet(fn: GetHandler): this {
    this.#getHandler = fn
    return this
  }

  onSet(fn: SetHandler): this {
    this.#setHandler = fn
    return this
  }

  setProps(props: Record<string, unknown>): this {
    this.props = props
    return this
  }

  updateValue(value: unknown): this {
    this.value = value
    return this
  }

  /** Simulates HomeKit reading this characteristic. */
  async triggerGet(): Promise<unknown> {
    if (!this.#getHandler) throw new Error(`No onGet handler registered for ${this.def.name}`)
    return this.#getHandler()
  }

  /** Simulates HomeKit writing this characteristic. */
  async triggerSet(value: unknown): Promise<unknown> {
    if (!this.#setHandler) throw new Error(`No onSet handler registered for ${this.def.name}`)
    return this.#setHandler(value)
  }
}

export class FakeService {
  displayName: string
  readonly UUID: string
  readonly subtype?: string
  readonly #characteristics = new Map<CharacteristicDef, FakeCharacteristicInstance>()

  constructor(def: ServiceDef, name: string, subtype?: string) {
    this.UUID = def.UUID
    this.displayName = name
    this.subtype = subtype
  }

  getCharacteristic(def: CharacteristicDef): FakeCharacteristicInstance {
    let instance = this.#characteristics.get(def)
    if (!instance) {
      instance = new FakeCharacteristicInstance(def)
      this.#characteristics.set(def, instance)
    }
    return instance
  }

  setCharacteristic(def: CharacteristicDef, value: unknown): this {
    this.getCharacteristic(def).value = value
    return this
  }

  updateCharacteristic(def: CharacteristicDef, value: unknown): this {
    this.getCharacteristic(def).value = value
    return this
  }
}

export class FakeAccessory {
  readonly services: FakeService[] = []
  context: Record<string, unknown> = {}

  constructor(
    public displayName: string,
    public readonly UUID: string,
  ) {
    this.services.push(new FakeService(FakeServiceType.AccessoryInformation, displayName))
  }

  getService(def: ServiceDef): FakeService | undefined {
    return this.services.find((s) => s.UUID === def.UUID && s.subtype === undefined)
  }

  getServiceById(def: ServiceDef, subtype: string): FakeService | undefined {
    return this.services.find((s) => s.UUID === def.UUID && s.subtype === subtype)
  }

  addService(def: ServiceDef, name: string, subtype?: string): FakeService {
    const service = new FakeService(def, name, subtype)
    this.services.push(service)
    return service
  }

  removeService(service: FakeService): void {
    const idx = this.services.indexOf(service)
    if (idx >= 0) this.services.splice(idx, 1)
  }
}

export class FakeHapStatusError extends Error {
  constructor(public readonly hapStatus: number) {
    super(`HAP status error: ${hapStatus}`)
  }
}

export function createFakeLogger() {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    log: () => {},
    success: () => {},
  }
}

export interface FakePlatformOptions {
  configOverrides?: Record<string, unknown>
}

/**
 * A minimal stand-in for `ValloxHomebridgePlatform`, exposing exactly what
 * `ValloxAccessory`/`attachProfileSwitches` read off it: `Service`,
 * `Characteristic`, `log`, `api.hap.HapStatusError`, `api.user.storagePath`,
 * and `configOption`.
 */
export function createFakePlatform(options: FakePlatformOptions = {}) {
  const config = options.configOverrides ?? {}
  return {
    Service: FakeServiceType,
    Characteristic: FakeCharacteristic,
    log: createFakeLogger(),
    api: {
      hap: { HapStatusError: FakeHapStatusError },
      user: { storagePath: () => '/tmp/homebridge-vallox-redux-tests' },
    },
    configOption<T>(key: string, fallback: T): T {
      return (config[key] as T | undefined) ?? fallback
    },
  }
}
