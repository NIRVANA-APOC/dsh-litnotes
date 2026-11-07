/**
 * Design primitives for the reading desk.
 *
 * Small, unstyled-by-default React controls that match the Harness host
 * instead of importing its UI packages (which are not module-table entries).
 * Every control follows the quality floor in `DESIGN-V2.md` §10: visible focus,
 * keyboard operation, `aria-*` state and theme-token colors only.
 */

import {
  autoUpdate,
  flip,
  offset,
  shift,
  useClick,
  useDismiss,
  useFloating,
  useInteractions,
  useRole,
  type Placement,
} from '@floating-ui/react'
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactElement, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react'
import { forwardRef, useEffect, useId, useRef, useState } from 'react'
import { Icon, type IconName } from './icons.tsx'

/** Join class names, dropping falsy entries. */
export function cx(...values: Array<string | false | null | undefined>): string {
  return values.filter((value): value is string => typeof value === 'string' && value !== '').join(' ')
}

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

export type ButtonVariant = 'default' | 'primary' | 'ghost' | 'quiet' | 'danger'

/** Props shared by the two button shapes. */
interface ButtonBase extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  variant?: ButtonVariant
  size?: 'sm' | 'md'
  icon?: IconName
  children?: ReactNode
}

/** One labelled button (ref-forwarding so anchored menus can target it). */
export const Button = forwardRef<HTMLButtonElement, ButtonBase>(function Button(
  { variant = 'default', size = 'md', icon, children, className, ...rest },
  ref,
): ReactElement {
  return (
    <button
      ref={ref}
      type="button"
      className={cx('ln-btn', `ln-btn--${variant}`, size === 'sm' && 'ln-btn--sm', className)}
      {...rest}
    >
      {icon === undefined ? null : <Icon name={icon} size={size === 'sm' ? 15 : 16} />}
      {children === undefined ? null : <span className="ln-btn__label">{children}</span>}
    </button>
  )
})

/** Props of the square icon button. */
export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  icon: IconName
  /** Accessible name; also used as the native tooltip. */
  label: string
  size?: number
  pressed?: boolean
  tone?: 'default' | 'signal' | 'danger'
}

/** One square icon-only button with a mandatory accessible name. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon, label, size = 18, pressed, tone = 'default', className, ...rest },
  ref,
): ReactElement {
  return (
    <button
      ref={ref}
      type="button"
      className={cx('ln-iconbtn', tone !== 'default' && `ln-iconbtn--${tone}`, pressed && 'is-pressed', className)}
      aria-label={label}
      title={label}
      aria-pressed={pressed === undefined ? undefined : pressed}
      {...rest}
    >
      <Icon name={icon} size={size} />
    </button>
  )
})

// ---------------------------------------------------------------------------
// Segmented control
// ---------------------------------------------------------------------------

/** One option of a segmented control. */
export interface SegmentOption<T extends string> {
  value: T
  label: string
  icon?: IconName
  disabled?: boolean
}

/** Props of a two-to-four way segmented control. */
export interface SegmentedProps<T extends string> {
  value: T
  options: ReadonlyArray<SegmentOption<T>>
  onChange: (value: T) => void
  ariaLabel: string
  size?: 'sm' | 'md'
  className?: string
}

/** A radio-group styled as a segmented control. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  size = 'md',
  className,
}: SegmentedProps<T>): ReactElement {
  return (
    <div role="radiogroup" aria-label={ariaLabel} className={cx('ln-seg', size === 'sm' && 'ln-seg--sm', className)}>
      {options.map((option) => {
        const selected = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            className={cx('ln-seg__item', selected && 'is-selected')}
            disabled={option.disabled}
            onClick={() => {
              if (!selected) onChange(option.value)
            }}
          >
            {option.icon === undefined ? null : <Icon name={option.icon} size={14} />}
            <span>{option.label}</span>
          </button>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Chips, badges, dots
// ---------------------------------------------------------------------------

/** Props of a toggle chip. */
export interface ChipProps {
  children: ReactNode
  pressed?: boolean
  onClick?: () => void
  title?: string
  count?: number
  className?: string
}

/** A compact filter/status chip; `pressed` makes it a toggle. */
export function Chip({ children, pressed, onClick, title, count, className }: ChipProps): ReactElement {
  const interactive = onClick !== undefined
  return (
    <button
      type="button"
      className={cx('ln-chip', pressed && 'is-pressed', !interactive && 'ln-chip--static', className)}
      aria-pressed={interactive ? Boolean(pressed) : undefined}
      title={title}
      onClick={onClick}
      tabIndex={interactive ? 0 : -1}
    >
      {children}
      {count === undefined ? null : <span className="ln-chip__count ln-tabular">{count}</span>}
    </button>
  )
}

/** Tone of a badge. */
export type BadgeTone = 'neutral' | 'signal' | 'success' | 'warn' | 'error'

/** A small state badge. */
export function Badge({ tone = 'neutral', children }: { tone?: BadgeTone; children: ReactNode }): ReactElement {
  return <span className={cx('ln-badge', `ln-badge--${tone}`)}>{children}</span>
}

/** One aspect-ink dot (decorative; the label is always present as text). */
export function AspectDot({ aspect, size = 8 }: { aspect: string; size?: number }): ReactElement {
  return <span className="ln-aspectdot" data-aspect={aspect} style={{ width: size, height: size }} aria-hidden="true" />
}

/** A row of aspect ink swatches; the legend doubles as a filter when pressable. */
export function AspectLegend({
  aspects,
  active,
  counts,
  onToggle,
  labelOf,
}: {
  aspects: ReadonlyArray<string>
  active?: string | null
  counts?: Record<string, number>
  onToggle?: (aspect: string) => void
  labelOf: (aspect: string) => string
}): ReactElement {
  return (
    <div className="ln-legend" role="group" aria-label={labelOf('legend')}>
      {aspects.map((aspect) => {
        const pressed = active === aspect
        return (
          <button
            key={aspect}
            type="button"
            className={cx('ln-legend__item', pressed && 'is-pressed')}
            data-aspect={aspect}
            aria-pressed={onToggle === undefined ? undefined : pressed}
            onClick={onToggle === undefined ? undefined : () => onToggle(aspect)}
            title={labelOf(aspect)}
          >
            <span className="ln-legend__dot" aria-hidden="true" />
            <span>{labelOf(aspect)}</span>
            {counts !== undefined && counts[aspect] !== undefined ? (
              <span className="ln-legend__count ln-tabular">{counts[aspect]}</span>
            ) : null}
          </button>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Form controls
// ---------------------------------------------------------------------------

/** Labelled form row. */
export function Field({
  label,
  description,
  htmlFor,
  children,
}: {
  label: string
  description?: string
  htmlFor?: string
  children: ReactNode
}): ReactElement {
  return (
    <div className="ln-field">
      <label className="ln-field__label" htmlFor={htmlFor}>
        {label}
      </label>
      <div className="ln-field__control">{children}</div>
      {description === undefined ? null : <p className="ln-field__hint">{description}</p>}
    </div>
  )
}

/** Text input. */
export function TextInput({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>): ReactElement {
  return <input type="text" className={cx('ln-input', className)} {...rest} />
}

/** Multiline text input. */
export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>): ReactElement {
  return <textarea className={cx('ln-input', 'ln-input--area', className)} {...rest} />
}

/** Native select with the plugin chrome. */
export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>): ReactElement {
  return (
    <select className={cx('ln-input', 'ln-input--select', className)} {...rest}>
      {children}
    </select>
  )
}

/** An accessible switch row. */
export function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
  disabled?: boolean
}): ReactElement {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={cx('ln-switch', checked && 'is-on')}
      onClick={() => onChange(!checked)}
    >
      <span className="ln-switch__track" aria-hidden="true">
        <span className="ln-switch__thumb" />
      </span>
    </button>
  )
}

// ---------------------------------------------------------------------------
// Anchored overlays (no portal: the plugin owns its panel; strategy=fixed)
// ---------------------------------------------------------------------------

/** Options of {@link useAnchored}. */
export interface AnchoredOptions {
  open: boolean
  onOpenChange: (open: boolean) => void
  placement?: Placement
  /** Gap between reference and floating element. */
  gap?: number
}

/** Floating-ui plumbing shared by popovers and menus. */
export function useAnchored({ open, onOpenChange, placement = 'bottom-start', gap = 6 }: AnchoredOptions) {
  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange,
    placement,
    strategy: 'fixed',
    whileElementsMounted: autoUpdate,
    middleware: [offset(gap), flip({ padding: 8 }), shift({ padding: 8 })],
  })
  const click = useClick(context)
  const dismiss = useDismiss(context)
  const role = useRole(context, { role: 'dialog' })
  const { getReferenceProps, getFloatingProps } = useInteractions([click, dismiss, role])
  return { refs, floatingStyles, getReferenceProps, getFloatingProps }
}

/** One item of a menu. */
export type MenuItem =
  | {
      type?: 'item'
      id: string
      label: string
      icon?: IconName
      shortcut?: string
      danger?: boolean
      disabled?: boolean
      checked?: boolean
      onSelect: () => void
    }
  | { type: 'separator'; id: string }

/** Props of {@link Menu}. */
export interface MenuProps {
  button: (props: { ref: (node: HTMLElement | null) => void; 'aria-haspopup': 'menu'; 'aria-expanded': boolean; onClick: () => void }) => ReactElement
  items: ReadonlyArray<MenuItem>
  placement?: Placement
  ariaLabel: string
}

/** A menu button with keyboard-dismiss and theme-token chrome. */
export function Menu({ button, items, placement = 'bottom-end', ariaLabel }: MenuProps): ReactElement {
  const [open, setOpen] = useState(false)
  const { refs, floatingStyles, getReferenceProps, getFloatingProps } = useAnchored({
    open,
    onOpenChange: setOpen,
    placement,
  })
  const menuId = useId()
  return (
    <>
      {button({
        ref: refs.setReference,
        'aria-haspopup': 'menu',
        'aria-expanded': open,
        onClick: () => setOpen((value) => !value),
        ...getReferenceProps({ 'aria-controls': open ? menuId : undefined }),
      })}
      {open ? (
        <div
          id={menuId}
          ref={refs.setFloating}
          style={floatingStyles}
          className="ln-menu"
          role="menu"
          aria-label={ariaLabel}
          {...getFloatingProps()}
        >
          {items.map((item) =>
            item.type === 'separator' ? (
              <div key={item.id} role="separator" className="ln-menu__separator" />
            ) : (
              <button
                key={item.id}
                type="button"
                role="menuitem"
                className={cx('ln-menu__item', item.danger && 'ln-menu__item--danger')}
                disabled={item.disabled}
                aria-checked={item.checked === undefined ? undefined : item.checked}
                onClick={() => {
                  setOpen(false)
                  item.onSelect()
                }}
              >
                {item.icon === undefined ? null : <Icon name={item.icon} size={15} />}
                <span className="ln-menu__label">{item.label}</span>
                {item.checked === true ? <Icon name="check" size={14} /> : null}
                {item.shortcut === undefined ? null : <span className="ln-menu__shortcut">{item.shortcut}</span>}
              </button>
            ),
          )}
        </div>
      ) : null}
    </>
  )
}

// ---------------------------------------------------------------------------
// Dialog (native <dialog> gives top layer + focus trap + Escape)
// ---------------------------------------------------------------------------

/** Props of {@link Dialog}. */
export interface DialogProps {
  open: boolean
  onClose: () => void
  title: string
  description?: string
  width?: number
  children: ReactNode
  footer?: ReactNode
}

/** One modal dialog rendered with the native `<dialog>` element. */
export function Dialog({ open, onClose, title, description, width, children, footer }: DialogProps): ReactElement {
  const ref = useRef<HTMLDialogElement | null>(null)
  useEffect(() => {
    const dialog = ref.current
    if (dialog === null) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])
  return (
    <dialog
      ref={ref}
      className="ln-dialog"
      style={{ width: width ?? 'min(560px, calc(100vw - 48px))' }}
      onClose={onClose}
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      onClick={(event) => {
        // Click on the backdrop (the dialog element itself) closes.
        if (event.target === ref.current) onClose()
      }}
    >
      {open ? (
        <div className="ln-dialog__surface">
          <header className="ln-dialog__head">
            <h2 className="ln-dialog__title">{title}</h2>
            <IconButton icon="close" label="关闭" onClick={onClose} />
          </header>
          {description === undefined ? null : <p className="ln-dialog__description">{description}</p>}
          <div className="ln-dialog__body">{children}</div>
          {footer === undefined ? null : <footer className="ln-dialog__foot">{footer}</footer>}
        </div>
      ) : null}
    </dialog>
  )
}

// ---------------------------------------------------------------------------
// Feedback
// ---------------------------------------------------------------------------

/** A small spinner (keeps turning under reduced motion as feedback). */
export function Spinner({ size = 16, label }: { size?: number; label?: string }): ReactElement {
  return <span className="ln-spinner" style={{ width: size, height: size }} role="status" aria-label={label ?? '加载中'} />
}

/** Bounded progress bar. */
export function ProgressBar({
  value,
  total,
  indeterminate,
  label,
}: {
  value?: number
  total?: number
  indeterminate?: boolean
  label: string
}): ReactElement {
  const ratio =
    indeterminate === true || value === undefined || total === undefined || total <= 0
      ? null
      : Math.min(1, Math.max(0, value / total))
  return (
    <div
      className={cx('ln-progress', ratio === null && 'is-indeterminate')}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={total ?? 100}
      aria-valuenow={ratio === null ? undefined : (value ?? 0)}
    >
      <span className="ln-progress__bar" style={ratio === null ? undefined : { width: `${ratio * 100}%` }} />
    </div>
  )
}

/** One empty state: an invitation to act, never mood copy. */
export function EmptyState({
  icon = 'book',
  title,
  body,
  actions,
  compact,
}: {
  icon?: IconName
  title: string
  body?: string
  actions?: ReactNode
  compact?: boolean
}): ReactElement {
  return (
    <div className={cx('ln-empty', compact && 'ln-empty--compact')}>
      <span className="ln-empty__icon" aria-hidden="true">
        <Icon name={icon} size={26} strokeWidth={1.4} />
      </span>
      <h3 className="ln-empty__title">{title}</h3>
      {body === undefined ? null : <p className="ln-empty__body">{body}</p>}
      {actions === undefined ? null : <div className="ln-empty__actions">{actions}</div>}
    </div>
  )
}

/** A keyboard hint. */
export function Kbd({ children }: { children: ReactNode }): ReactElement {
  return <kbd className="ln-kbd">{children}</kbd>
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/** Whether a media query currently matches (SSR-safe default false). */
export function useMediaQuery(query: string): boolean {
  const getMatch = (): boolean => (typeof window === 'undefined' ? false : window.matchMedia(query).matches)
  const [matches, setMatches] = useState<boolean>(getMatch)
  useEffect(() => {
    if (typeof window === 'undefined') return
    const list = window.matchMedia(query)
    const onChange = (): void => setMatches(list.matches)
    setMatches(list.matches)
    list.addEventListener('change', onChange)
    return () => list.removeEventListener('change', onChange)
  }, [query])
  return matches
}

/**
 * Register a window-level keydown handler. Ignored while typing in a field
 * unless `force` is set.
 */
export function useHotkey(
  combo: string,
  handler: (event: KeyboardEvent) => void,
  options: { force?: boolean; enabled?: boolean } = {},
): void {
  const handlerRef = useRef(handler)
  handlerRef.current = handler
  const { force = false, enabled = true } = options
  useEffect(() => {
    if (!enabled) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!force) {
        const target = event.target
        const tag = target instanceof HTMLElement ? target.tagName : ''
        const editable =
          tag === 'INPUT' ||
          tag === 'TEXTAREA' ||
          tag === 'SELECT' ||
          (target instanceof HTMLElement && target.isContentEditable)
        if (editable || event.metaKey || event.ctrlKey || event.altKey) return
      }
      const parts = combo.toLowerCase().split('+')
      const key = parts[parts.length - 1] ?? ''
      const needMeta = parts.includes('mod')
      const needShift = parts.includes('shift')
      const meta = event.metaKey || event.ctrlKey
      if (needMeta !== meta) return
      if (needShift !== event.shiftKey) return
      if (event.key.toLowerCase() !== key) return
      event.preventDefault()
      handlerRef.current(event)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [combo, enabled, force])
}
