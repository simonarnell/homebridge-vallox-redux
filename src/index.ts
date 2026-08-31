import type { API } from 'homebridge'
import { PLATFORM_NAME } from './settings.js'
import { ValloxHomebridgePlatform } from './platform.js'

export default (api: API): void => {
  api.registerPlatform(PLATFORM_NAME, ValloxHomebridgePlatform)
}
