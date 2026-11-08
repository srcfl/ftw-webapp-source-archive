import { describe, expect, it } from 'vitest'
import { happened, journalAnswer, type JournalEntry } from './control-journal'
import { simulatedJournal } from '$lib/sim/journal'

const hm = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
const NOW = new Date(2026, 10, 8, 12, 0, 0).getTime()
const at = (h: number, m: number, s = 0) => new Date(2026, 10, 8, h, m, s).getTime()
const NO_SOURCES = new Map<string, { kind: string }>()

const span = (over: Record<string, unknown>) => ({
  id: 1, subject: 'battery:lynx', driver: 'lynx', kind: 'battery', status: 'not_following', reason: 'power_below_target',
  severity: 'warning', start_ms: at(6, 14), end_ms: at(6, 29), requested_w: null, actual_w: null, ...over,
})
const words = (spans: unknown[], notifications: unknown[] = [], sources = NO_SOURCES, now = NOW): JournalEntry[] =>
  happened(journalAnswer({ spans, notifications }), sources, now)
const pw = (mean: number) => ({ min: mean, max: mean, mean, n: 10 })

describe('happened', () => {
  it('says the demo morning newest first, and leaves out what only repeats', () => {
    const list = words((simulatedJournal(NOW, { severity: 'warning' }, 'lynx', 'easee') as { spans: unknown[] }).spans, (simulatedJournal(NOW, {}, 'lynx', 'easee') as { notifications: unknown[] }).notifications, new Map([['easee', { kind: 'charger' }]]))
    expect(list.map((e) => e.title)).toEqual([
      'No fresh readings',
      'lynx is not following FTW',
      'Battery behind the plan',
      'Not following',
      'FTW was not in control',
    ])
    expect(list[0]).toMatchObject({ name: 'easee · charger', text: 'The charger was not reporting.' })
    expect(list[2]).toMatchObject({ text: 'Planned 1.1 kWh charge, delivered 0.3 kWh.', name: null })
    expect(list[3]).toMatchObject({ name: 'lynx · battery', text: 'Asked for 4.2 kW charge, delivered 1.2 kW on average.' })
    expect(list[4]).toMatchObject({ name: null, text: 'FTW stopped control because the grid meter readings are out of date.' })
    expect(list[4]!.when).toMatch(/ · 3 s$/)
  })

  it('keeps a device line that a short block only touches', () => {
    const device = span({ id: 1, status: 'not_controlled', reason: 'site_meter_stale', start_ms: at(6, 14), end_ms: at(6, 29) })
    const block = (start: number, end: number) => span({ id: 2, subject: 'site:dispatch', driver: '', kind: 'dispatch', status: 'blocked', reason: 'site_meter_stale', start_ms: start, end_ms: end })
    expect(words([device, block(at(6, 20), at(6, 20, 3))])).toHaveLength(2)
    expect(words([device, block(at(6, 14, 8), at(6, 28, 55))])).toHaveLength(1)
    const quiet = (start: number, end: number) => span({ id: 3, subject: 'source:lynx', kind: 'source', status: 'offline', reason: 'telemetry_stale', start_ms: start, end_ms: end })
    const stale = span({ id: 1, status: 'not_controlled', reason: 'telemetry_stale' })
    expect(words([stale, quiet(at(6, 20), at(6, 21))])).toHaveLength(2)
    expect(words([stale, quiet(at(6, 13), at(6, 30))])).toHaveLength(1)
  })

  it('gives a time range, and "Since" for what still holds', () => {
    expect(words([span({ requested_w: pw(3000), actual_w: pw(0) })])[0]!.when).toBe(`${hm(at(6, 14))}–${hm(at(6, 29))}`)
    const open = words([span({ end_ms: null })])[0]!
    expect(open.when).toBe(`Since ${hm(at(6, 14))}`)
    expect(open.ongoing).toBe(true)
  })

  it('says yesterday before local midnight', () => {
    expect(words([span({})], [], NO_SOURCES, at(6, 14) + 86_400_000)[0]!.when).toMatch(/^Yesterday /)
  })

  it('uses the live row’s words when the box measured no power', () => {
    const row = { driver: 'easee', kind: 'ev', status: 'limited', reason: 'load_balancer_limit', severity: 'warning', make: 'Easee', limit_a: 7, requested_a: 16, actual_w: 4800, evidence: 'measured' }
    const [e] = words([span({ subject: 'ev:easee', driver: 'easee', kind: 'ev', status: 'limited', reason: 'load_balancer_limit', last: row })])
    expect(e).toMatchObject({ title: 'Limited by the charger’s load balancing', name: 'easee · charger' })
    expect(e!.text).toBe('Easee limits the charger to 7 A (its load balancing). FTW asked for 16 A; the car takes 4.8 kW.')
  })

  it('names the direction when the device went the other way', () => {
    const [e] = words([span({ reason: 'power_wrong_direction', requested_w: pw(3000), actual_w: pw(-1500) })])
    expect(e!.text).toBe('Asked for 3.0 kW charge, delivered 1.5 kW discharge on average.')
  })

  it('reads as one what the box split at an escalation', () => {
    const list = words([
      span({ id: 1, start_ms: at(6, 0), end_ms: at(6, 10), requested_w: pw(1000), actual_w: { min: 0, max: 0, mean: 0, n: 10 } }),
      span({ id: 2, severity: 'alarm', start_ms: at(6, 10, 2), end_ms: at(6, 20), requested_w: pw(3000), actual_w: { min: 0, max: 0, mean: 0, n: 10 } }),
    ])
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ mark: 'alarm', when: `${hm(at(6, 0))}–${hm(at(6, 20))}`, text: 'Asked for 2.0 kW charge, delivered 0 W on average.' })
  })

  it('does not repeat a dispatch block on the device', () => {
    const list = words([
      span({ id: 1, status: 'not_controlled', reason: 'site_meter_stale' }),
      span({ id: 2, subject: 'site:dispatch', driver: '', kind: 'dispatch', status: 'blocked', reason: 'site_meter_stale' }),
    ])
    expect(list.map((e) => e.title)).toEqual(['FTW was not in control'])
  })

  it('never says anything for info spans, modes or a slot on target', () => {
    expect(words([
      span({ id: 1, severity: 'info' }),
      span({ id: 2, kind: 'mode', subject: 'site:mode', status: 'manual' }),
      span({ id: 3, kind: 'slot', subject: 'slot:battery', status: 'on_target' }),
    ])).toEqual([])
  })

  it('states a fault in the words the device used, and only those', () => {
    const [named] = words([span({ subject: 'source:lynx', kind: 'source', status: 'fault', reason: 'device_fault', last: { device_fault_reason: 'E042' } })])
    expect(named!.text).toBe('The device reported a fault: E042.')
    const [bare] = words([span({ subject: 'source:lynx', kind: 'source', status: 'fault', reason: 'device_fault' })])
    expect(bare!.text).toBe('The device reported a fault.')
  })

  it('shows notices the box sent or failed to send, not queued ones', () => {
    const list = words([], [
      { id: 1, ts_ms: at(7, 0), event_type: 'control.not_following', title: 'lynx is not following FTW', body: 'Asked for 4.2 kW.', status: 'sent' },
      { id: 2, ts_ms: at(8, 0), event_type: 'control.not_following', title: '', body: '', status: 'failed', error: 'ntfy: 401' },
      { id: 3, ts_ms: at(9, 0), event_type: 'x', title: 'Queued', body: '', status: 'queued' },
    ])
    expect(list.map((e) => [e.mark, e.title, e.name])).toEqual([
      ['notice_failed', 'control.not_following', 'Notice not sent'],
      ['notice', 'lynx is not following FTW', 'Notice sent'],
    ])
    expect(JSON.stringify(list)).not.toContain('401')
  })

  it('keeps a reason this version does not know honest', () => {
    const [e] = words([span({ status: 'limited', reason: 'brand_new_reason' })])
    expect(e!.title).toBe('Limited')
    expect(e!.text).toBe('The box reports “brand_new_reason”, which this version cannot describe.')
  })

  it('leaves out what is not a span', () => {
    expect(journalAnswer({ spans: [null, { id: 'x' }, span({})], notifications: 'no' })).toMatchObject({ spans: [{ id: 1 }], notices: [], more: false })
    expect(journalAnswer(null)).toEqual({ spans: [], more: false, notices: [], noticesMore: false })
  })
})
