/* What happened, in words.
 *
 * GET /api/control/journal is the box's record: each stretch one device, one
 * source or the site's dispatch held one verdict, and the notices the box sent.
 * Core owns every field. This only puts words to it, and the words for a
 * device line are the ones its live row uses. Missing numbers stay missing.
 */

import {
  controlFlow,
  controlPower,
  controlRows,
  controlStatus,
  type ControlFeedback,
} from '$vendor/ftw/control-feedback.js'
import { energyLabel } from './energy'

type Wire = Record<string, unknown>

export interface JournalPower {
  min: number
  max: number
  mean: number
  n: number
}

export interface JournalSpan {
  id: number
  subject: string
  driver: string
  kind: string
  status: string
  reason: string
  severity: string
  mode: string
  startMs: number
  /** Null while the verdict still holds. */
  endMs: number | null
  requested: JournalPower | null
  actual: JournalPower | null
  first: Wire | null
  last: Wire | null
}

export interface JournalNotice {
  id: number
  tsMs: number
  eventType: string
  title: string
  body: string
  status: string
}

export interface JournalAnswer {
  spans: JournalSpan[]
  more: boolean
  notices: JournalNotice[]
  noticesMore: boolean
}

export interface JournalEntry {
  id: string
  mark: 'warning' | 'alarm' | 'notice' | 'notice_failed'
  title: string
  /** What it was about: "sungrow · battery". Null for the home as a whole. */
  name: string | null
  text: string
  /** "06:14–06:29", "Since 06:14", "05:52 · 3 s". */
  when: string
  atMs: number
  /** Still holds. Only this takes the alarm colour; the past does not. */
  ongoing: boolean
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const obj = (v: unknown): Wire | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Wire) : null)

function toPower(v: unknown): JournalPower | null {
  const o = obj(v)
  const mean = num(o?.['mean'])
  if (!o || mean === null) return null
  return { min: num(o['min']) ?? mean, max: num(o['max']) ?? mean, mean, n: num(o['n']) ?? 1 }
}

function toSpan(v: unknown): JournalSpan | null {
  const o = obj(v)
  const id = num(o?.['id'])
  const startMs = num(o?.['start_ms'])
  if (!o || id === null || startMs === null || !str(o['kind'])) return null
  return {
    id,
    subject: str(o['subject']) || str(o['kind']),
    driver: str(o['driver']),
    kind: str(o['kind']),
    status: str(o['status']),
    reason: str(o['reason']),
    severity: str(o['severity']) || 'info',
    mode: str(o['mode']),
    startMs,
    endMs: num(o['end_ms']),
    requested: toPower(o['requested_w']),
    actual: toPower(o['actual_w']),
    first: obj(o['first']),
    last: obj(o['last']),
  }
}

function toNotice(v: unknown): JournalNotice | null {
  const o = obj(v)
  const id = num(o?.['id'])
  const tsMs = num(o?.['ts_ms'])
  if (!o || id === null || tsMs === null) return null
  return { id, tsMs, eventType: str(o['event_type']), title: str(o['title']), body: str(o['body']), status: str(o['status']) }
}

const list = <T>(v: unknown, read: (x: unknown) => T | null): T[] =>
  Array.isArray(v) ? v.map(read).filter((x): x is T => x !== null) : []

export function journalAnswer(wire: unknown): JournalAnswer {
  const o = obj(wire)
  return {
    spans: list(o?.['spans'], toSpan),
    more: o?.['more'] === true,
    notices: list(o?.['notifications'], toNotice),
    noticesMore: o?.['notifications_more'] === true,
  }
}

const needsLook = (span: JournalSpan) => span.severity === 'warning' || span.severity === 'alarm'

/** Reasons a device row shares with the site's dispatch block. */
const DISPATCH_REASONS = new Set(['site_meter_stale', 'site_phase_currents_stale'])
/** How close two stretches of one verdict must lie to read as one. */
const JOIN_MS = 5_000
/** Whether `a` held for all of `b`, give or take the time between two samples. */
const covers = (a: JournalSpan, b: JournalSpan, nowMs: number) =>
  a.startMs <= b.startMs + 2 * JOIN_MS && (a.endMs ?? nowMs) >= (b.endMs ?? nowMs) - 2 * JOIN_MS

/**
 * The journal's warnings and alarms in words, with the notices the box sent
 * or failed to send, newest first. A device line that only repeats a dispatch
 * block or a quiet source in the same time is left out, and back-to-back
 * stretches of one verdict read as one. None of this is a verdict of the app's.
 */
export function happened(answer: JournalAnswer, sources: ReadonlyMap<string, { kind: string }>, nowMs: number): JournalEntry[] {
  const looked = answer.spans.filter((span) => {
    if (!needsLook(span) || span.kind === 'mode') return false
    return span.kind !== 'slot' || span.status === 'under_delivered' || span.status === 'sign_mismatch'
  })
  const blocks = looked.filter((s) => s.kind === 'dispatch')
  const quiet = looked.filter((s) => s.kind === 'source')
  const kept = looked.filter((span) => {
    if (['dispatch', 'source', 'slot'].includes(span.kind)) return true
    if (DISPATCH_REASONS.has(span.reason) && blocks.some((b) => b.reason === span.reason && covers(b, span, nowMs))) return false
    return !(span.reason === 'telemetry_stale' && quiet.some((q) => q.driver === span.driver && covers(q, span, nowMs)))
  })
  const entries = joined(kept).map((span) => spanEntry(span, sources, nowMs))
  for (const notice of answer.notices) {
    if (notice.status === 'sent' || notice.status === 'failed') entries.push(noticeEntry(notice, nowMs))
  }
  return entries.sort((a, b) => b.atMs - a.atMs || (a.id < b.id ? 1 : -1))
}

/** Back-to-back stretches of one subject, status and reason, as one. */
function joined(spans: JournalSpan[]): JournalSpan[] {
  const out: JournalSpan[] = []
  const order = [...spans].sort((a, b) => (a.subject < b.subject ? -1 : a.subject > b.subject ? 1 : a.startMs - b.startMs || a.id - b.id))
  for (const span of order) {
    const prev = out[out.length - 1]
    if (
      !prev || prev.subject !== span.subject || prev.kind === 'slot' || prev.status !== span.status || prev.reason !== span.reason ||
      prev.endMs === null || span.startMs - prev.endMs > JOIN_MS
    ) {
      out.push(span)
      continue
    }
    out[out.length - 1] = {
      ...prev,
      endMs: span.endMs,
      severity: span.severity === 'alarm' ? 'alarm' : prev.severity,
      requested: merged(prev.requested, span.requested),
      actual: merged(prev.actual, span.actual),
      last: span.last ?? prev.last,
    }
  }
  return out
}

function merged(a: JournalPower | null, b: JournalPower | null): JournalPower | null {
  if (!a || !b) return a ?? b
  const n = a.n + b.n
  if (n <= 0) return a
  return { min: Math.min(a.min, b.min), max: Math.max(a.max, b.max), mean: (a.mean * a.n + b.mean * b.n) / n, n }
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
/** The same clock the control feedback beside it prints. */
const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

/** "06:14", or "yesterday 22:10" before local midnight. */
function stamp(ms: number, nowMs: number): string {
  return ms < new Date(nowMs).setHours(0, 0, 0, 0) ? `yesterday ${clock(ms)}` : clock(ms)
}

function when(startMs: number, endMs: number | null, nowMs: number): string {
  const start = stamp(startMs, nowMs)
  if (endMs === null) return `Since ${start}`
  const lasted = endMs - startMs
  if (lasted < 60_000) return capital(`${start} · ${Math.max(1, Math.round(lasted / 1000))} s`)
  return capital(`${start}–${clock(endMs)}`)
}

function kindWord(kind: string): string {
  if (kind === 'battery') return 'battery'
  if (kind === 'ev' || kind === 'v2x_charger') return 'charger'
  if (kind === 'pv') return 'solar'
  return 'device'
}

const SOURCE_KINDS: Record<string, [noun: string, word: string]> = {
  meter: ['the meter', 'meter'],
  inverter: ['the inverter', 'inverter'],
  battery: ['the battery', 'battery'],
  charger: ['the charger', 'charger'],
  ev: ['the charger', 'charger'],
  vehicle: ['the car', 'car'],
}

/** Whether `got` went the way `asked` did, or was too small to say. */
const sameWay = (asked: number, got: number) => Math.abs(got) < 100 || asked >= 0 === got >= 0

function askedDelivered(row: ControlFeedback, asked: number, got: number): string {
  if (row.kind === 'pv') return `Asked for a ${controlPower(asked)} cap, produced ${controlPower(got)} on average.`
  if (Math.abs(asked) < 100) return `Asked to stay idle, delivered ${controlFlow(row, got)} on average.`
  return `Asked for ${controlFlow(row, asked)}, delivered ${sameWay(asked, got) ? controlPower(got) : controlFlow(row, got)} on average.`
}

const energyFlow = (wh: number) => `${energyLabel(Math.abs(wh))} ${wh >= 0 ? 'charge' : 'discharge'}`

/** A row for the words alone, when the stretch kept no row of its own. */
function bareRow(span: JournalSpan, kind = span.kind): ControlFeedback {
  return { driver: span.driver, kind, mode: span.mode, status: span.status, reason: span.reason, severity: span.severity, evidence: 'none' } as ControlFeedback
}

function spanEntry(span: JournalSpan, sources: ReadonlyMap<string, { kind: string }>, nowMs: number): JournalEntry {
  const ongoing = span.endMs === null
  const base = {
    id: `span:${span.id}`,
    mark: span.severity === 'alarm' ? ('alarm' as const) : ('warning' as const),
    when: when(span.startMs, span.endMs, nowMs),
    atMs: span.startMs,
    ongoing,
  }

  if (span.kind === 'dispatch') {
    return { ...base, title: ongoing ? 'FTW is not in control' : 'FTW was not in control', name: null, text: controlStatus(bareRow(span)).text }
  }

  if (span.kind === 'source') {
    const kind = sources.get(span.driver)?.kind
    const [noun, word] = (kind && SOURCE_KINDS[kind]) || ['the device', 'device']
    const name = span.driver ? (kind ? `${span.driver} · ${word}` : span.driver) : null
    if (span.status === 'fault' || span.reason === 'device_fault') {
      const why = str(span.last?.['device_fault_reason']) || str(span.first?.['device_fault_reason'])
      return { ...base, title: 'Device fault', name, text: why ? `${capital(noun)} reported a fault: ${why}.` : `${capital(noun)} reported a fault.` }
    }
    return { ...base, title: 'No fresh readings', name, text: `${capital(noun)} ${ongoing ? 'is' : 'was'} not reporting.` }
  }

  if (span.kind === 'slot') {
    const planned = num(span.first?.['planned_wh'])
    const delivered = num(span.first?.['actual_wh'])
    const title = span.status === 'sign_mismatch' ? 'Battery went the other way' : 'Battery behind the plan'
    let text = 'The plan’s quarter delivered less than planned.'
    if (planned !== null && delivered !== null) {
      text = `Planned ${energyFlow(planned)}, delivered ${sameWay(planned, delivered) ? energyLabel(Math.abs(delivered)) : energyFlow(delivered)}.`
    } else if (span.requested && span.actual) {
      text = askedDelivered(bareRow(span, 'battery'), span.requested.mean, span.actual.mean)
    }
    return { ...base, title, name: null, text }
  }

  const kept = controlRows([span.last])[0] ?? controlRows([span.first])[0] ?? bareRow(span)
  // The stretch's own verdict, whatever its latest row carried.
  const row = { ...kept, driver: span.driver || kept.driver, kind: span.kind, status: span.status, reason: span.reason, severity: span.severity } as ControlFeedback
  const words = controlStatus(row)
  const text = span.requested && span.actual ? askedDelivered(row, span.requested.mean, span.actual.mean) : words.text
  return { ...base, title: words.title, name: `${row.driver} · ${kindWord(row.kind)}`, text }
}

function noticeEntry(notice: JournalNotice, nowMs: number): JournalEntry {
  const failed = notice.status === 'failed'
  return {
    id: `notice:${notice.id}`,
    mark: failed ? 'notice_failed' : 'notice',
    title: notice.title || notice.eventType,
    name: failed ? 'Notice not sent' : 'Notice sent',
    text: notice.body,
    when: capital(stamp(notice.tsMs, nowMs)),
    atMs: notice.tsMs,
    ongoing: false,
  }
}
