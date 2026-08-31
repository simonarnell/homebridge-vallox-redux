// fakegato-history ships no type declarations. This covers only the surface this plugin
// actually uses — see https://github.com/simont77/fakegato-history for the full (untyped) API.
declare module 'fakegato-history' {
  import type { API, Logger, PlatformAccessory, Service } from 'homebridge'

  type FakeGatoAccessoryType =
    | 'room'
    | 'room2'
    | 'weather'
    | 'energy'
    | 'door'
    | 'motion'
    | 'switch'
    | 'thermo'
    | 'aqua'
    | 'custom'

  interface FakeGatoOptionalParams {
    size?: number
    minutes?: number
    storage?: 'fs' | 'googleDrive'
    path?: string
    filename?: string
    disableTimer?: boolean
    disableRepeatLastData?: boolean
    log?: Logger
  }

  /** Entry shape accepted for the 'room', 'room2', and 'weather' accessory types this plugin uses. */
  interface FakeGatoEntry {
    time: number
    temp?: number
    humidity?: number
    ppm?: number
    voc?: number
    pressure?: number
  }

  export class FakeGatoHistoryService extends Service {
    constructor(accessoryType: FakeGatoAccessoryType, accessory: PlatformAccessory, optionalParams?: FakeGatoOptionalParams)
    addEntry(entry: FakeGatoEntry): void
    /**
     * Undocumented: appends a raw entry to the history buffer, bypassing the timer/averager that
     * `addEntry` normally routes entries through. Used for one-shot backfill of historical
     * samples with their own real timestamps, where the averager (which stamps entries with
     * "now" when its timer fires) would be wrong.
     */
    _addEntry(entry: FakeGatoEntry): void
  }

  function fakegatoHistory(homebridge: API): typeof FakeGatoHistoryService
  export = fakegatoHistory
}
