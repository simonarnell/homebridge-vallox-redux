import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge'
import { HAPStatus } from 'homebridge'
import { Profile, ValidationError, type ValloxClient } from 'vallox.js'
import type { ValloxHomebridgePlatform } from './platform.js'

const SWITCHABLE_PROFILES = [
  { profile: Profile.HOME, subtype: 'profile-home', name: 'Home' },
  { profile: Profile.AWAY, subtype: 'profile-away', name: 'Away' },
  { profile: Profile.BOOST, subtype: 'profile-boost', name: 'Boost' },
  { profile: Profile.FIREPLACE, subtype: 'profile-fireplace', name: 'Fireplace' },
] as const

export interface ProfileSwitchesController {
  updateFromPoll(activeProfile: Profile): void
}

export function attachProfileSwitches(
  platform: ValloxHomebridgePlatform,
  accessory: PlatformAccessory,
  client: ValloxClient,
  getLastKnownProfile: () => Profile,
  onMutated: () => void,
): ProfileSwitchesController {
  const services = new Map<Profile, Service>()

  for (const { profile, subtype, name } of SWITCHABLE_PROFILES) {
    const service =
      accessory.getServiceById(platform.Service.Switch, subtype) ??
      accessory.addService(platform.Service.Switch, name, subtype)
    // Force Name (and ConfiguredName — see the matching helper/comment in valloxAccessory.ts for
    // why both are needed) even on a cached service.
    service
      .setCharacteristic(platform.Characteristic.Name, name)
      .setCharacteristic(platform.Characteristic.ConfiguredName, name)

    service
      .getCharacteristic(platform.Characteristic.On)
      .onGet(() => getLastKnownProfile() === profile)
      .onSet((value: CharacteristicValue) =>
        wrap(platform, async () => {
          if (value) {
            await client.setProfile(profile)
          } else if (profile === Profile.HOME) {
            await client.setProfile(Profile.HOME)
          } else {
            await client.clearTimedModes()
          }

          const nowActive = value ? profile : Profile.HOME
          for (const [p, s] of services) {
            s.updateCharacteristic(platform.Characteristic.On, p === nowActive)
          }
          onMutated()
        }),
      )

    services.set(profile, service)
  }

  return {
    updateFromPoll(activeProfile: Profile) {
      for (const [profile, service] of services) {
        service.updateCharacteristic(platform.Characteristic.On, profile === activeProfile)
      }
    },
  }
}

async function wrap<T>(platform: ValloxHomebridgePlatform, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof ValidationError) {
      platform.log.error('Vallox profile switch command got implausible data from the unit:', err.message)
    } else {
      platform.log.error('Vallox profile switch command failed:', (err as Error).message)
    }
    throw new platform.api.hap.HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE)
  }
}
