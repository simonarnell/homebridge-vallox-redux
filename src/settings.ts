export const PLATFORM_NAME = 'ValloxRedux'
export const PLUGIN_NAME = 'homebridge-vallox-redux'

export const DEFAULT_PORT = 80
export const DEFAULT_POLL_SECONDS = 30
export const DEFAULT_FILTER_ALERT_DAYS = 14
export const DEFAULT_CO2_ALERT_PPM = 1000

export interface ValloxPlatformConfig {
  platform: typeof PLATFORM_NAME
  name?: string
  host: string
  port?: number
  pollingIntervalSeconds?: number
  filterAlertDays?: number
  co2AlertPpm?: number
  enableCo2Sensor?: boolean
  enableHumiditySensor?: boolean
  enableEveHistory?: boolean
  enableDailyTimeSync?: boolean
}

/** Custom data persisted on the Homebridge-managed {@link PlatformAccessory} between restarts. */
export interface ValloxAccessoryContext {
  host: string
  port: number
  serial?: string
}
