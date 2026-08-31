import { Ajv, type JSONSchemaType } from 'ajv'
import { PLATFORM_NAME, type ValloxPlatformConfig } from './settings.js'

// JSONSchemaType<ValloxPlatformConfig> ties this schema to the interface at compile time:
// adding/removing/retyping a field on ValloxPlatformConfig without updating this schema is a
// type error, so the two can't silently drift apart.
const configSchema: JSONSchemaType<ValloxPlatformConfig> = {
  type: 'object',
  properties: {
    platform: { type: 'string', const: PLATFORM_NAME },
    name: { type: 'string', nullable: true },
    host: { type: 'string', minLength: 1 },
    port: { type: 'integer', minimum: 1, maximum: 65535, nullable: true },
    pollingIntervalSeconds: { type: 'integer', minimum: 5, nullable: true },
    filterAlertDays: { type: 'integer', minimum: 0, nullable: true },
    enableCo2Sensor: { type: 'boolean', nullable: true },
    enableHumiditySensor: { type: 'boolean', nullable: true },
    enableEveHistory: { type: 'boolean', nullable: true },
  },
  required: ['platform', 'host'],
  // Homebridge/end users may add unrelated keys (comments, IDs Homebridge itself injects); only
  // the fields we actually read are validated.
  additionalProperties: true,
}

const ajv = new Ajv({ allErrors: true })
const validate = ajv.compile(configSchema)

/**
 * Validates a raw Homebridge platform config against {@link configSchema}. On success, narrows
 * `config` to {@link ValloxPlatformConfig} (Ajv's compiled validator is a TS type predicate).
 * On failure, reports a human-readable summary of every violation via `onError` and returns
 * `undefined` — never throws, so a bad config.json can't crash the Homebridge process.
 */
export function parseConfig(
  config: unknown,
  onError: (message: string) => void,
): ValloxPlatformConfig | undefined {
  if (validate(config)) {
    return config
  }

  const detail = ajv.errorsText(validate.errors, { separator: '; ' })
  onError(`Vallox platform config is invalid, skipping device discovery: ${detail}`)
  return undefined
}
