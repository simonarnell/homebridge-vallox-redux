import { describe, it, expect, jest, beforeEach } from '@jest/globals'
import { Profile, ValidationError } from 'vallox.js'
import { attachProfileSwitches } from '../profileSwitches.js'
import { createFakePlatform, FakeAccessory, FakeHapStatusError, FakeCharacteristic } from './support/fakeHap.js'

function fakeClient() {
  return {
    setProfile: jest.fn(async (_profile: Profile) => {}),
    clearTimedModes: jest.fn(async () => {}),
  }
}

describe('attachProfileSwitches', () => {
  let platform: ReturnType<typeof createFakePlatform>
  let accessory: FakeAccessory
  let client: ReturnType<typeof fakeClient>
  let onMutated: jest.Mock

  beforeEach(() => {
    platform = createFakePlatform()
    accessory = new FakeAccessory('Vallox', 'uuid-1')
    client = fakeClient()
    onMutated = jest.fn()
  })

  it('creates one Switch service per switchable profile', () => {
    attachProfileSwitches(platform as any, accessory as any, client as any, () => Profile.HOME, onMutated)
    const switches = accessory.services.filter((s) => s.UUID === 'Switch')
    expect(switches).toHaveLength(4)
    expect(switches.map((s) => s.displayName).sort()).toEqual(['Away', 'Boost', 'Fireplace', 'Home'])
  })

  it('reports On for the currently active profile only', async () => {
    attachProfileSwitches(platform as any, accessory as any, client as any, () => Profile.BOOST, onMutated)
    const boost = accessory.getServiceById({ UUID: 'Switch' } as any, 'profile-boost')!
    const home = accessory.getServiceById({ UUID: 'Switch' } as any, 'profile-home')!

    expect(await boost.getCharacteristic(FakeCharacteristic.On).triggerGet()).toBe(true)
    expect(await home.getCharacteristic(FakeCharacteristic.On).triggerGet()).toBe(false)
  })

  it('setting a profile switch on calls client.setProfile with that profile', async () => {
    attachProfileSwitches(platform as any, accessory as any, client as any, () => Profile.HOME, onMutated)
    const away = accessory.getServiceById({ UUID: 'Switch' } as any, 'profile-away')!

    await away.getCharacteristic(FakeCharacteristic.On).triggerSet(true)

    expect(client.setProfile).toHaveBeenCalledWith(Profile.AWAY)
    expect(onMutated).toHaveBeenCalledTimes(1)
  })

  it('turning off the Home switch re-activates Home rather than clearing to nothing', async () => {
    attachProfileSwitches(platform as any, accessory as any, client as any, () => Profile.HOME, onMutated)
    const home = accessory.getServiceById({ UUID: 'Switch' } as any, 'profile-home')!

    await home.getCharacteristic(FakeCharacteristic.On).triggerSet(false)

    expect(client.setProfile).toHaveBeenCalledWith(Profile.HOME)
    expect(client.clearTimedModes).not.toHaveBeenCalled()
  })

  it('turning off a non-Home switch (e.g. Boost) clears timed modes, falling back to Home', async () => {
    attachProfileSwitches(platform as any, accessory as any, client as any, () => Profile.BOOST, onMutated)
    const boost = accessory.getServiceById({ UUID: 'Switch' } as any, 'profile-boost')!
    const home = accessory.getServiceById({ UUID: 'Switch' } as any, 'profile-home')!

    await boost.getCharacteristic(FakeCharacteristic.On).triggerSet(false)

    expect(client.clearTimedModes).toHaveBeenCalledTimes(1)
    expect(client.setProfile).not.toHaveBeenCalled()
    // The switch bank should optimistically reflect Home now active.
    expect(home.getCharacteristic(FakeCharacteristic.On).value).toBe(true)
    expect(boost.getCharacteristic(FakeCharacteristic.On).value).toBe(false)
  })

  it('updateFromPoll() reflects the polled profile across all switches', () => {
    const controller = attachProfileSwitches(platform as any, accessory as any, client as any, () => Profile.NONE, onMutated)
    controller.updateFromPoll(Profile.FIREPLACE)

    const fireplace = accessory.getServiceById({ UUID: 'Switch' } as any, 'profile-fireplace')!
    const away = accessory.getServiceById({ UUID: 'Switch' } as any, 'profile-away')!
    expect(fireplace.getCharacteristic(FakeCharacteristic.On).value).toBe(true)
    expect(away.getCharacteristic(FakeCharacteristic.On).value).toBe(false)
  })

  it('wraps a ValidationError from the client into a HapStatusError', async () => {
    client.setProfile.mockRejectedValueOnce(new ValidationError('profile', 'implausible value'))
    attachProfileSwitches(platform as any, accessory as any, client as any, () => Profile.HOME, onMutated)
    const away = accessory.getServiceById({ UUID: 'Switch' } as any, 'profile-away')!

    await expect(away.getCharacteristic(FakeCharacteristic.On).triggerSet(true)).rejects.toBeInstanceOf(
      FakeHapStatusError,
    )
  })

  it('wraps a generic client failure into a HapStatusError too', async () => {
    client.setProfile.mockRejectedValueOnce(new Error('socket hang up'))
    attachProfileSwitches(platform as any, accessory as any, client as any, () => Profile.HOME, onMutated)
    const away = accessory.getServiceById({ UUID: 'Switch' } as any, 'profile-away')!

    await expect(away.getCharacteristic(FakeCharacteristic.On).triggerSet(true)).rejects.toBeInstanceOf(
      FakeHapStatusError,
    )
  })

  it('reuses an existing cached Switch service instead of creating a duplicate', () => {
    attachProfileSwitches(platform as any, accessory as any, client as any, () => Profile.HOME, onMutated)
    const countAfterFirst = accessory.services.length
    attachProfileSwitches(platform as any, accessory as any, client as any, () => Profile.HOME, onMutated)
    expect(accessory.services.length).toBe(countAfterFirst)
  })
})
