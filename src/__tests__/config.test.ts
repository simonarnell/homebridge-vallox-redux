import { describe, it, expect, jest } from '@jest/globals'
import { parseConfig } from '../config.js'
import { PLATFORM_NAME } from '../settings.js'

describe('parseConfig', () => {
  const validBase = { platform: PLATFORM_NAME, host: '192.168.1.100' }

  it('accepts a minimal valid config', () => {
    const onError = jest.fn()
    const result = parseConfig(validBase, onError)
    expect(result).toEqual(validBase)
    expect(onError).not.toHaveBeenCalled()
  })

  it('accepts a fully populated valid config', () => {
    const onError = jest.fn()
    const full = {
      platform: PLATFORM_NAME,
      name: 'My Vallox',
      host: '192.168.1.100',
      port: 8080,
      pollingIntervalSeconds: 60,
      filterAlertDays: 30,
      enableCo2Sensor: false,
      enableHumiditySensor: false,
      enableEveHistory: true,
    }
    const result = parseConfig(full, onError)
    expect(result).toEqual(full)
    expect(onError).not.toHaveBeenCalled()
  })

  it('allows unrelated extra properties (Homebridge UI metadata, comments, etc.)', () => {
    const onError = jest.fn()
    const result = parseConfig({ ...validBase, _bridge: {}, someUnknownKey: 'x' }, onError)
    expect(result).toBeDefined()
    expect(onError).not.toHaveBeenCalled()
  })

  it('rejects a missing host', () => {
    const onError = jest.fn()
    const result = parseConfig({ platform: PLATFORM_NAME }, onError)
    expect(result).toBeUndefined()
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0]?.[0]).toMatch(/host/)
  })

  it('rejects an empty host string', () => {
    const onError = jest.fn()
    const result = parseConfig({ ...validBase, host: '' }, onError)
    expect(result).toBeUndefined()
    expect(onError).toHaveBeenCalledTimes(1)
  })

  it('rejects a wrong platform name', () => {
    const onError = jest.fn()
    const result = parseConfig({ ...validBase, platform: 'SomethingElse' }, onError)
    expect(result).toBeUndefined()
  })

  it('rejects a non-integer port', () => {
    const onError = jest.fn()
    const result = parseConfig({ ...validBase, port: 80.5 }, onError)
    expect(result).toBeUndefined()
  })

  it('rejects a port out of range', () => {
    const onError = jest.fn()
    expect(parseConfig({ ...validBase, port: 0 }, onError)).toBeUndefined()
    expect(parseConfig({ ...validBase, port: 70000 }, onError)).toBeUndefined()
  })

  it('rejects pollingIntervalSeconds below the 5s minimum', () => {
    const onError = jest.fn()
    const result = parseConfig({ ...validBase, pollingIntervalSeconds: 4 }, onError)
    expect(result).toBeUndefined()
  })

  it('rejects a negative filterAlertDays', () => {
    const onError = jest.fn()
    const result = parseConfig({ ...validBase, filterAlertDays: -1 }, onError)
    expect(result).toBeUndefined()
  })

  it('rejects wrong types for boolean toggles', () => {
    const onError = jest.fn()
    const result = parseConfig({ ...validBase, enableCo2Sensor: 'yes' }, onError)
    expect(result).toBeUndefined()
  })

  it('reports every violation in one pass, not just the first', () => {
    const onError = jest.fn()
    parseConfig({ platform: 'Wrong', host: '', port: -1 }, onError)
    expect(onError).toHaveBeenCalledTimes(1)
    const message = onError.mock.calls[0]?.[0] as string
    // ajv's allErrors:true summary should mention more than one distinct field
    expect(message.split(';').length).toBeGreaterThan(1)
  })

  it('never throws for garbage input', () => {
    const onError = jest.fn()
    expect(() => parseConfig(null, onError)).not.toThrow()
    expect(() => parseConfig('a string', onError)).not.toThrow()
    expect(() => parseConfig(42, onError)).not.toThrow()
    expect(() => parseConfig([], onError)).not.toThrow()
  })
})
