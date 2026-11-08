/* The simulated box's control journal: GET /api/control/journal, one morning.
 *
 * The box restarts at 05:52 and holds dispatch for 3 s until its meter reads
 * again. From 06:14 to 06:29 FTW asks the battery for 4.2 kW of charge and it
 * takes 1.2 kW, so a quarter falls behind the plan and the box sends a notice.
 * At 08:02 the charger goes quiet for seven minutes. The morning is today's
 * once it has passed, else yesterday's.
 */

const power = (min: number, max: number, mean: number, n: number) => ({ min, max, mean, n })

export function simulatedJournal(nowMs: number, query: Record<string, string>, battery: string, charger: string): unknown {
  const day = new Date(nowMs)
  const at = (h: number, m: number, s = 0) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m, s).getTime()
  if (nowMs < at(8, 30)) day.setDate(day.getDate() - 1)

  const restart = at(5, 52, 10)
  const lowStart = at(6, 14, 5)
  const lowEnd = at(6, 29, 40)
  const quiet = at(8, 2, 30)
  const back = at(8, 9, 10)

  const batteryRow = (actual: number, atMs: number) => ({
    driver: battery, kind: 'battery', mode: 'planner_arbitrage', status: 'not_following', reason: 'power_below_target', severity: 'warning',
    evidence: 'measured', readings_fresh: true, requested_w: 4200, sent_w: 4200, readback_w: 4200, actual_w: actual, battery_soc: 0.41,
    command_at_ms: atMs - 4_000, observed_at_ms: atMs - 1_000, site_confirmation: 'no_clear_change',
  })
  const quietDetail = { status: 'offline', consecutive_errors: 40, last_success_ms: quiet - 30_000, last_error: 'no answer from the charger' }
  const span = (id: number, subject: string, kind: string, status: string, severity: string, from: number, to: number | null, extra: Record<string, unknown> = {}) => ({
    id, subject, kind, status, severity, mode: 'planner_arbitrage', start_ms: from, end_ms: to, updated_ms: to ?? nowMs,
    duration_s: ((to ?? nowMs) - from) / 1000, samples: Math.max(1, Math.round(((to ?? nowMs) - from) / 5_000)), requested_w: null, actual_w: null, ...extra,
  })

  const since = Number(query['since'] ?? nowMs - 86_400_000)
  const until = Number(query['until'] ?? nowMs)
  const spans = [
    span(10, `battery:${battery}`, 'battery', 'following', 'info', lowEnd, null, { driver: battery, reason: 'plan', requested_w: power(-1800, 2400, 300, 400), actual_w: power(-1790, 2390, 296, 400) }),
    span(9, `source:${charger}`, 'source', 'offline', 'warning', quiet, back, { driver: charger, reason: 'telemetry_stale', first: quietDetail, last: quietDetail }),
    // The charger's control row says the same in the same minutes.
    span(8, `ev:${charger}`, 'ev', 'no_contact', 'warning', quiet, back, { driver: charger, reason: 'telemetry_stale' }),
    span(7, 'slot:battery', 'slot', 'under_delivered', 'warning', at(6, 15), at(6, 30), {
      requested_w: power(4200, 4200, 4200, 1), actual_w: power(1260, 1260, 1260, 1), first: { planned_wh: 1050, actual_wh: 315, ratio: 0.3, replans: 0 },
    }),
    span(6, `battery:${battery}`, 'battery', 'not_following', 'warning', lowStart, lowEnd, {
      driver: battery, reason: 'power_below_target', requested_w: power(4200, 4200, 4200, 187), actual_w: power(1090, 1350, 1200, 187),
      first: batteryRow(1240, lowStart), last: batteryRow(1160, lowEnd),
    }),
    span(2, `battery:${battery}`, 'battery', 'not_controlled', 'warning', restart, restart + 3_000, { driver: battery, reason: 'site_meter_stale' }),
    span(1, 'site:dispatch', 'dispatch', 'blocked', 'warning', restart, restart + 3_000, { reason: 'site_meter_stale' }),
  ].filter((s) => s.start_ms <= until && (s.end_ms ?? nowMs) >= since && (query['severity'] !== 'warning' || s.severity !== 'info'))

  const noticeAt = lowStart + 600_000
  return {
    since_ms: since,
    until_ms: until,
    spans,
    more: false,
    notifications: noticeAt >= since && noticeAt <= until
      ? [{ id: 31, ts_ms: noticeAt, event_type: 'control.not_following', driver: battery, title: `${battery} is not following FTW`, body: 'Asked for 4.2 kW charge for 10 minutes; it delivers 1.2 kW.', priority: 4, status: 'sent' }]
      : [],
    notifications_more: false,
  }
}
