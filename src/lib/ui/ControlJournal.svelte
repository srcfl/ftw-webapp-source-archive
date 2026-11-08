<!--
  What happened: the box's warnings and alarms of the last day and the notices
  it sent, newest first, in the words of the live rows. A box without the
  journal shows nothing here.
-->
<script lang="ts">
  import { untrack } from 'svelte'
  import { happened } from '$lib/format/control-journal'
  import { watchJournal, type JournalView } from '$lib/state/control-journal'
  import type { SiteStore } from '$lib/state/site.svelte'

  let { site }: { site: SiteStore } = $props()

  const FIRST = 6
  const ICONS = { warning: '▲', alarm: '!', notice: '•', notice_failed: '×' }

  let view = $state.raw<JournalView>({ answer: null, problem: null })
  let all = $state(false)

  // Untracked: the session changes every frame, and the watcher checks it for
  // itself each time it asks.
  $effect(() => untrack(() => watchJournal(site, (next) => (view = next))))

  const entries = $derived(view.answer ? happened(view.answer, untrack(() => site.session.sources), Date.now()) : [])
  const shown = $derived(all ? entries : entries.slice(0, FIRST))
  const cut = $derived(view.answer?.more === true || view.answer?.noticesMore === true)
</script>

{#if view.answer || view.problem}
  <section class="journal" aria-label="What happened">
    <p class="kicker">What happened</p>
    {#if view.problem}<p class="note" role="status">{view.problem}</p>{/if}
    {#if view.answer}
      {#if entries.length === 0}
        <p class="note">Nothing needed a look in the last 24 hours.</p>
      {:else}
        <ul>
          {#each shown as entry (entry.id)}
            <li data-mark={entry.mark} data-ongoing={entry.ongoing}>
              <span class="icon" aria-hidden="true">{ICONS[entry.mark]}</span>
              <div class="body">
                <p class="when">{entry.when}{entry.name ? ` · ${entry.name}` : ''}</p>
                <p class="title">{entry.title}</p>
                {#if entry.text}<p class="text">{entry.text}</p>{/if}
              </div>
            </li>
          {/each}
        </ul>
        {#if entries.length > shown.length}
          <button class="more" onclick={() => (all = true)}>Show {entries.length - shown.length} more</button>
        {/if}
      {/if}
      <p class="foot">From your box’s record of the last 24 hours.{cut ? ' Only the newest are shown.' : ''}</p>
    {/if}
  </section>
{/if}

<style>
  .journal { margin: var(--space-4, 16px) 0 0; }
  .kicker {
    font-family: var(--mono);
    font-size: 0.7rem;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--fg-muted);
    margin: 0 0 8px;
  }
  ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 12px; }
  li { display: grid; grid-template-columns: 20px 1fr; gap: 10px; align-items: start; }
  .icon {
    display: inline-grid;
    place-items: center;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    font-size: 12px;
    font-weight: 700;
    line-height: 1;
    background: var(--line);
    color: var(--fg-dim);
  }
  li[data-mark='warning'][data-ongoing='true'] .icon { background: color-mix(in srgb, var(--alarm) 22%, transparent); color: var(--alarm); }
  li[data-mark='alarm'][data-ongoing='true'] .icon { background: var(--alarm); color: var(--on-accent); }
  li[data-mark='notice_failed'] .icon { color: var(--alarm); }
  .body { min-width: 0; overflow-wrap: anywhere; }
  p { margin: 0; }
  .when { font-family: var(--mono); font-size: 0.72rem; color: var(--fg-dim); }
  .title { font-size: 0.95rem; font-weight: 600; margin-top: 2px; }
  .text { font-size: 0.88rem; line-height: 1.4; margin-top: 1px; }
  .note { font-size: 0.88rem; color: var(--fg-dim); }
  .more { margin-top: 10px; font-size: 0.85rem; color: var(--fg-dim); text-decoration: underline; }
  .foot { font-size: 0.75rem; color: var(--fg-muted); margin-top: 10px; }
</style>
