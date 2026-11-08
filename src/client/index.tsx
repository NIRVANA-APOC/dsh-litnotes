/**
 * Client half entry: registers the sidebar panel and the keyed `main` panel,
 * injects the compiled design-system stylesheet once, and mounts the reading
 * desk behind the slot's locale seat.
 *
 * The generated bundle (`lib/client.js`) exposes this module's `clientMain()`
 * result as the plugin module: `{ inject, apply }`. The Harness module table
 * provides `react`; every other runtime import is bundled.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'

import { PANEL_ID, NS } from '../shared/constants.ts'
import { PANEL_ICON_SVG } from './icons.ts'
import { en, zh } from './i18n/index.ts'
import { CSS } from './styles/index.ts'
import { App } from './shell/App.tsx'
import { provideLocale } from './shell/locale-context.ts'

/** Services this client half requires before it activates. */
export const inject: string[] = ['slots', 'locale', 'layout']

/** Sidebar icon: inline artwork, sized by the sidebar row. */
function PanelIcon(props: { size?: number; active?: boolean }): JSX.Element {
  const edge = Number(props.size) || 18
  return (
    <span
      className="ln-host-icon"
      style={{
        display: 'inline-flex',
        width: edge,
        height: edge,
        alignItems: 'center',
        justifyContent: 'center',
        color: 'currentColor',
        opacity: props.active ? 1 : 0.82,
      }}
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: PANEL_ICON_SVG }}
    />
  )
}

/** Inject the plugin stylesheet once per client run. */
function installStyles(): () => void {
  if (typeof document === 'undefined') return () => {}
  const existing = document.querySelector('style[data-dsh-litnotes]')
  if (existing instanceof HTMLStyleElement) return () => {}
  const style = document.createElement('style')
  style.dataset.dshLitnotes = ''
  style.textContent = CSS
  document.head.appendChild(style)
  return () => style.remove()
}

/**
 * Mount the plugin on the Harness client tree.
 *
 * @param ctx - the Cordis client context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-litnotes: dictionaries')
  ctx.effect(installStyles, 'dsh-litnotes: stylesheet')
  // Feature stores read the active locale outside React (the deep-read run
  // sends it to the Host for notes/report language); a missing locale service
  // must never break the panel, so the fallback reader is `en`.
  ctx.effect(() => {
    try {
      provideLocale(() => ctx.locale.getLocale().active)
    } catch {
      provideLocale(() => 'en')
    }
    return () => provideLocale(() => 'en')
  }, 'dsh-litnotes: active locale')
  const t = ctx.locale.bind(NS)
  ctx.effect(
    () =>
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          { name: 'sidebar.panellist', id: PANEL_ID, order: 35, locale: NS, label: () => t('rail.title') },
          PanelIcon,
        ),
      ),
    'dsh-litnotes: sidebar entry',
  )
  ctx.effect(
    () =>
      ctx.slots.inject('main', () =>
        ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS }, function LitnotesPanel(props) {
          return <App t={props.t} />
        }),
      ),
    'dsh-litnotes: main panel',
  )
}

/**
 * Module entry consumed by the generated bundle factory.
 *
 * @returns the client plugin object.
 */
export function clientMain(): { inject: string[]; apply: (ctx: ClientContext) => void } {
  return { inject, apply }
}
