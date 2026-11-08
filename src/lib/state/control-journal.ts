/* What happened, from the box's own control journal.
 *
 * Asked while a sheet that shows it is open, and by nothing else: none of it
 * reaches lane 0. A box from before the journal answers E_UNKNOWN_OP or 404,
 * and then the list stays away for good.
 */

import { BoxApiError, callBox } from './box-api'
import { CAP_API_PASSTHROUGH } from '$lib/protocol/contract'
import { journalAnswer, type JournalAnswer } from '$lib/format/control-journal'
import type { SiteStore } from './site.svelte'

const READ_EVERY_MS = 30_000
const RETRY_MS = 3_000

/** Warnings and alarms of the box's default window, the last 24 hours. */
export const JOURNAL_QUERY = { severity: 'warning', limit: '50' }

export interface JournalView {
  answer: JournalAnswer | null
  /** Set while the box has not answered; the app is already asking again. */
  problem: string | null
}

const OUT_OF_DATE = 'Waiting for your box. This list may be out of date.'
const NO_ANSWER = "Your box didn't answer. Still trying."

/** Read the journal until stopped. Calls `onView` with each change. */
export function watchJournal(site: SiteStore, onView: (view: JournalView) => void): () => void {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let answer: JournalAnswer | null = null

  const tick = async () => {
    let wait = RETRY_MS
    if (site.session.phase === 'streaming' && site.session.caps.has(CAP_API_PASSTHROUGH)) {
      try {
        const wire = await callBox<unknown>(site, { method: 'GET', path: '/api/control/journal', query: JOURNAL_QUERY })
        if (stopped) return
        answer = journalAnswer(wire)
        onView({ answer, problem: null })
        wait = READ_EVERY_MS
      } catch (err) {
        if (stopped) return
        if (err instanceof BoxApiError && (err.status === 404 || err.code === 'E_UNKNOWN_OP')) {
          onView({ answer: null, problem: null })
          return
        }
        onView({ answer, problem: answer ? OUT_OF_DATE : NO_ANSWER })
      }
    } else if (answer) {
      onView({ answer, problem: OUT_OF_DATE })
    }
    timer = setTimeout(() => void tick(), wait)
  }

  void tick()
  return () => {
    stopped = true
    clearTimeout(timer)
  }
}
