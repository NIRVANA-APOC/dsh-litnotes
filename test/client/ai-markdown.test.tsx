// @vitest-environment happy-dom
// @vitest-environment-options {"settings": {"disableCSSFileLoading": true, "disableJavaScriptFileLoading": true, "handleDisabledFileLoadingAsSuccess": true}}
/**
 * Answer renderer tests: markdown-it block rendering, inline citation chips
 * injected into text runs, math spans (KaTeX source fallback while the lazy
 * runtime is not loaded), links, and the raw-HTML safety guarantee
 * (`html:false`: model HTML is escaped text, never DOM).
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AiMarkdown } from '../../src/client/ai/markdown.tsx'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

/** Render one answer with a `[n]` chip factory. */
function render(text: string): void {
  act(() => {
    root.render(
      <AiMarkdown
        text={text}
        renderCitation={(index) => (
          <button key={`cite-${index}`} type="button" className="chip" data-index={index}>
            [{index}]
          </button>
        )}
      />,
    )
  })
}

describe('AiMarkdown', () => {
  it('renders paragraphs, headings, emphasis, lists and code', () => {
    render(['# Title', '', 'Some **bold** and *italic* text with `code`.', '', '- one', '- two'].join('\n'))
    expect(container.querySelector('.ln-ai__heading[data-level="1"]')?.textContent).toBe('Title')
    expect(container.querySelector('.ln-ai__paragraph')?.textContent).toContain('Some bold and italic text with code.')
    expect(container.querySelector('strong')).not.toBeNull()
    expect(container.querySelector('em')).not.toBeNull()
    expect(container.querySelectorAll('.ln-ai__list-item')).toHaveLength(2)
  })

  it('injects citation chips into text while keeping code spans literal', () => {
    render('See [1] and `[2]`.\n\n```\n[3]\n```')
    const chips = container.querySelectorAll('.chip')
    expect(chips).toHaveLength(1)
    expect(chips[0]?.getAttribute('data-index')).toBe('1')
    expect(container.querySelector('.ln-ai__inline-code')?.textContent).toBe('[2]')
    expect(container.querySelector('pre.ln-ai__code')?.textContent).toContain('[3]')
  })

  it('renders tables and rules', () => {
    render('| a | b |\n| --- | --- |\n| 1 | 2 |\n\n---')
    const table = container.querySelector('.ln-ai__table')
    expect(table).not.toBeNull()
    expect(table?.querySelectorAll('td')).toHaveLength(2)
    expect(container.querySelector('.ln-ai__rule')).not.toBeNull()
  })

  it('renders links with safe external attributes', () => {
    render('Read [the paper](https://example.com/paper).')
    const link = container.querySelector<HTMLAnchorElement>('.ln-ai__link')
    expect(link?.getAttribute('href')).toBe('https://example.com/paper')
    expect(link?.getAttribute('target')).toBe('_blank')
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer')
  })

  it('never executes raw model HTML (html:false)', () => {
    render('<img src=x onerror="alert(1)"> after')
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain('<img src=x onerror="alert(1)"> after')
  })

  it('renders inline and display formulas (KaTeX source fallback)', () => {
    render('Inline $a^2$ math.\n\n$$\\frac{1}{2}$$\n\n\\(b\\)')
    const formulas = container.querySelectorAll('.ln-ai__formula.is-source')
    expect(formulas.length).toBeGreaterThanOrEqual(1)
    const display = container.querySelector('.ln-ai__formula--display')
    expect(display?.textContent).toContain('\\frac{1}{2}')
  })

  it('keeps currency literal instead of treating it as math', () => {
    render('It costs $5 and $10 in total.')
    expect(container.querySelector('.ln-ai__formula')).toBeNull()
    expect(container.textContent).toContain('$5 and $10')
  })
})
