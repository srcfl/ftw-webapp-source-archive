// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/svelte'
import { fireEvent } from '@testing-library/dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '$lib/protocol/session'
import { CAP_API_PASSTHROUGH } from '$lib/protocol/contract'
import ControlJournal from './ControlJournal.svelte'
import { JOURNAL_QUERY } from '$lib/state/control-journal'
import type { SiteStore } from '$lib/state/site.svelte'

afterEach(() => { cleanup(); vi.useRealTimers() })

const body = (o: unknown) => ({ status: 200, body: new TextEncoder().encode(JSON.stringify(o)) })
const site = (api: unknown, phase = 'streaming') =>
  ({ session: { phase, caps: new Set([CAP_API_PASSTHROUGH]), sources: new Map() }, api }) as unknown as SiteStore
const span = (id: number) => ({
  id, subject: 'battery:lynx', driver: 'lynx', kind: 'battery', status: 'not_following', reason: 'no_power_response', severity: 'warning',
  start_ms: Date.now() - id * 3_600_000, end_ms: Date.now() - id * 3_600_000 + 600_000, requested_w: { min: 3000, max: 3000, mean: 3000, n: 3 }, actual_w: { min: 0, max: 0, mean: 0, n: 3 },
})
const unknownOp = () => { throw new ApiError({ id: 'a', code: 'E_UNKNOWN_OP' } as never) }
const settled = () => new Promise((r) => setTimeout(r, 10))

describe('What happened', () => {
  it('asks the box for its warnings over the session and shows what it says', async () => {
    const api = vi.fn(async () => body({ spans: [span(1)], notifications: [] }))
    render(ControlJournal, { site: site(api) })
    await screen.findByText('What happened')
    expect(api).toHaveBeenCalledWith({ method: 'GET', path: '/api/control/journal', query: JOURNAL_QUERY })
    expect(screen.getByText('Asked for 3.0 kW charge, delivered 0 W on average.')).toBeTruthy()
    expect(screen.getByText(/lynx · battery/)).toBeTruthy()
    expect(screen.getByText('From your box’s record of the last 24 hours.')).toBeTruthy()
  })

  it('says so when nothing needed a look', async () => {
    render(ControlJournal, { site: site(async () => body({ spans: [], notifications: [] })) })
    expect(await screen.findByText('Nothing needed a look in the last 24 hours.')).toBeTruthy()
  })

  it('shows nothing for a box without the journal, and stops asking', async () => {
    const api = vi.fn(unknownOp)
    render(ControlJournal, { site: site(api) })
    await settled()
    expect(screen.queryByText('What happened')).toBeNull()
    expect(api).toHaveBeenCalledTimes(1)
  })

  it('shows nothing for a 404', async () => {
    render(ControlJournal, { site: site(async () => ({ status: 404, body: new Uint8Array() })) })
    await settled()
    expect(screen.queryByText('What happened')).toBeNull()
  })

  it('shows nothing and asks nothing until the session streams', async () => {
    const api = vi.fn()
    render(ControlJournal, { site: site(api, 'connecting') })
    await settled()
    expect(api).not.toHaveBeenCalled()
    expect(screen.queryByText('What happened')).toBeNull()
  })

  it('says it is still trying when the box does not answer, and heals', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    let up = false
    const api = vi.fn(async () => { if (!up) throw new Error('gone'); return body({ spans: [span(1)], notifications: [] }) })
    render(ControlJournal, { site: site(api) })
    expect(await screen.findByText("Your box didn't answer. Still trying.")).toBeTruthy()
    up = true
    await vi.advanceTimersByTimeAsync(3_100)
    await waitFor(() => expect(screen.queryByText("Your box didn't answer. Still trying.")).toBeNull())
    expect(screen.getByText(/lynx · battery/)).toBeTruthy()
  })

  it('keeps the list but marks it out of date when the session goes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const s = site(async () => body({ spans: [span(1)], notifications: [] }))
    render(ControlJournal, { site: s })
    await screen.findByText(/lynx · battery/)
    ;(s.session as { phase: string }).phase = 'connecting'
    await vi.advanceTimersByTimeAsync(30_100)
    expect(await screen.findByText('Waiting for your box. This list may be out of date.')).toBeTruthy()
    expect(screen.getByText(/lynx · battery/)).toBeTruthy()
  })

  it('shows the newest six, with the rest a tap away, and says when the box cut the list', async () => {
    render(ControlJournal, { site: site(async () => body({ spans: Array.from({ length: 8 }, (_, i) => span(i + 1)), more: true, notifications: [] })) })
    await screen.findByText('Show 2 more')
    expect(document.querySelectorAll('li').length).toBe(6)
    expect(screen.getByText(/Only the newest are shown/)).toBeTruthy()
    await fireEvent.click(screen.getByText('Show 2 more'))
    expect(document.querySelectorAll('li').length).toBe(8)
  })

  it('stops asking when it closes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const api = vi.fn(async () => body({ spans: [], notifications: [] }))
    const view = render(ControlJournal, { site: site(api) })
    await screen.findByText('What happened')
    view.unmount()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(api).toHaveBeenCalledTimes(1)
  })

  it('renders device names as text', async () => {
    const bad = { ...span(1), driver: '<img onerror=bad>', requested_w: null, actual_w: null }
    render(ControlJournal, { site: site(async () => body({ spans: [bad], notifications: [] })) })
    await screen.findByText('What happened')
    expect(document.querySelector('img')).toBeNull()
  })
})
