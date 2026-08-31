import { describe, it, expect, beforeAll, afterAll } from '@jest/globals'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers'
import { HttpClient, Characteristic as CharacteristicModel, Service as ServiceModel } from 'hap-controller'

/**
 * End-to-end proof that the *published shape* of this plugin actually works
 * inside a real Homebridge process, talking real HAP over the network to a
 * paired controller — not just that our own TypeScript calls the right
 * mocked functions (that's what the Jest unit tests cover).
 *
 * The Vallox unit itself is simulated by `MockValloxServer` from the sibling
 * vallox.js checkout (`~/git_repos/Vallox.js`) — this repo intentionally does
 * not depend on that package's unpublished `./testing` export (see the repo
 * review that led here), so it's loaded directly from that checkout's built
 * `dist/`. If that checkout isn't present/built, these tests are skipped
 * rather than failing a machine that doesn't have it.
 */

const SIBLING_MOCK_SERVER_PATH = resolve(
  import.meta.dirname,
  '../../../../Vallox.js/dist/testing/mock-server.js',
)
const HAS_MOCK_SERVER = existsSync(SIBLING_MOCK_SERVER_PATH)

const BRIDGE_PIN = '031-45-154'
const BRIDGE_PORT = 51826
const POLLING_INTERVAL_SECONDS = 5

const describeIfAvailable = HAS_MOCK_SERVER ? describe : describe.skip

/**
 * Shape of vallox.js's `./testing` export this test relies on — declared
 * locally rather than imported, since this repo's own `vallox.js`
 * dependency is the published registry version, which doesn't have that
 * (still-unpublished) subpath. See {@link SIBLING_MOCK_SERVER_PATH}.
 */
interface MockValloxServerModule {
  MockValloxServer: new (options: { host: string; port: number }) => {
    start(): Promise<void>
    stop(): Promise<void>
    readonly port: number
    getRegister(name: string): number
  }
}

describeIfAvailable('homebridge-vallox-redux inside a real Homebridge container', () => {
  let mockServer: InstanceType<MockValloxServerModule['MockValloxServer']>
  let container: StartedTestContainer
  let client: HttpClient

  beforeAll(async () => {
    const { MockValloxServer } = (await import(SIBLING_MOCK_SERVER_PATH)) as MockValloxServerModule
    mockServer = new MockValloxServer({ host: '0.0.0.0', port: 0 })
    await mockServer.start()

    const tarballDir = mkdtempSync(join(tmpdir(), 'homebridge-vallox-redux-pack-'))
    const packOutput = execFileSync('npm', ['pack', '--json', '--pack-destination', tarballDir], {
      cwd: resolve(import.meta.dirname, '../../..'),
      encoding: 'utf8',
    })
    const [{ filename }] = JSON.parse(packOutput) as [{ filename: string }]
    const tarballPath = join(tarballDir, filename)

    const config = {
      bridge: {
        name: 'Vallox Redux Test Bridge',
        username: '0E:B0:C3:2A:11:01',
        port: BRIDGE_PORT,
        pin: BRIDGE_PIN,
      },
      platforms: [
        {
          platform: 'ValloxRedux',
          name: 'Test Vallox',
          host: 'host.docker.internal',
          port: mockServer.port,
          pollingIntervalSeconds: POLLING_INTERVAL_SECONDS,
          filterAlertDays: 14,
        },
      ],
    }
    const packageJson = {
      dependencies: {
        homebridge: '2.4.0',
        'homebridge-vallox-redux': `file:/homebridge/${filename}`,
      },
    }

    container = await new GenericContainer('homebridge/homebridge:latest')
      .withExtraHosts([{ host: 'host.docker.internal', ipAddress: 'host-gateway' }])
      .withExposedPorts(BRIDGE_PORT)
      .withCopyContentToContainer([
        { content: JSON.stringify(config, null, 2), target: '/homebridge/config.json' },
        { content: JSON.stringify(packageJson, null, 2), target: '/homebridge/package.json' },
      ])
      .withCopyFilesToContainer([{ source: tarballPath, target: `/homebridge/${filename}` }])
      .withWaitStrategy(Wait.forLogMessage(/is running on port/i))
      .withStartupTimeout(180_000)
      .start()

    rmSync(tarballDir, { recursive: true, force: true })

    const host = container.getHost()
    const port = container.getMappedPort(BRIDGE_PORT)
    client = new HttpClient('homebridge-vallox-redux-integration-test', host, port)
    await client.pairSetup(BRIDGE_PIN)

    // Let at least one poll cycle (pollingIntervalSeconds above) run so
    // poll-driven characteristics (e.g. Fanv2 RotationSpeed) have a value.
    await new Promise((r) => setTimeout(r, (POLLING_INTERVAL_SECONDS + 2) * 1000))
  }, 240_000)

  afterAll(async () => {
    await container?.stop()
    await mockServer?.stop()
  })

  function serviceUuid(name: string): string {
    return CharacteristicModel.ensureCharacteristicUuid(ServiceModel.uuidFromService(`public.hap.service.${name}`))
  }
  function charUuid(name: string): string {
    return CharacteristicModel.ensureCharacteristicUuid(
      CharacteristicModel.uuidFromCharacteristic(`public.hap.characteristic.${name}`),
    )
  }

  interface Found {
    aid: number
    iid: number
  }

  async function find(serviceName: string, characteristicName: string): Promise<Found> {
    const accessories = await client.getAccessories()
    const wantService = serviceUuid(serviceName)
    const wantChar = charUuid(characteristicName)

    for (const accessory of accessories.accessories) {
      for (const service of accessory.services) {
        if (CharacteristicModel.ensureCharacteristicUuid(service.type ?? '') !== wantService) continue
        for (const characteristic of service.characteristics) {
          if (CharacteristicModel.ensureCharacteristicUuid(characteristic.type ?? '') === wantChar) {
            return { aid: accessory.aid, iid: characteristic.iid! }
          }
        }
      }
    }
    throw new Error(`Could not find ${serviceName}/${characteristicName} in the accessory database`)
  }

  async function readOne(serviceName: string, characteristicName: string): Promise<unknown> {
    const { aid, iid } = await find(serviceName, characteristicName)
    const result = await client.getCharacteristics([`${aid}.${iid}`])
    return result.characteristics[0]?.value
  }

  it('pairs and exposes the fan, temperature, CO2, and filter accessories', async () => {
    const accessories = await client.getAccessories()
    // Main accessory (fan/extract/humidity/co2/filter/profiles) + 3 satellites.
    expect(accessories.accessories.length).toBeGreaterThanOrEqual(4)
  })

  it('reports the fan as powered on with the Home fan speed from the mock unit', async () => {
    expect(await readOne('fanv2', 'active')).toBe(1)
    expect(await readOne('fanv2', 'rotation.speed')).toBe(50)
  })

  it('reports live sensor readings from the mock unit', async () => {
    expect(await readOne('sensor.carbon-dioxide', 'carbon-dioxide.level')).toBe(650)
    expect(await readOne('sensor.humidity', 'relative-humidity.current')).toBe(42)
  })

  it('reports filter as OK when remaining days are above the configured threshold', async () => {
    // Mock default REMAINING_FILTER_DAYS=100, config filterAlertDays=14 → FILTER_OK (0)
    expect(await readOne('filter-maintenance', 'filter.change-indication')).toBe(0)
  })

  it('a HomeKit write reaches the real mock Vallox unit end-to-end', async () => {
    const { aid, iid } = await find('fanv2', 'active')
    await client.setCharacteristics({ [`${aid}.${iid}`]: { value: 0 } })

    // Give the plugin's onSet → client.powerOff() → WebSocketTransport write time to land.
    await new Promise((r) => setTimeout(r, 2000))

    expect(mockServer.getRegister('ON_OFF')).toBe(5) // POWER_OFF

    // Restore state for any later test in this file.
    await client.setCharacteristics({ [`${aid}.${iid}`]: { value: 1 } })
  })
})
