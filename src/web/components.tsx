import { useEffect, useId, useRef, type ReactNode } from 'react';
import { ArrowLeft, ChevronRight, X, type LucideIcon } from 'lucide-react';

export function Avatar({ name, large = false }: { name: string; large?: boolean }) {
  let hash = 0;
  for (const c of name) hash = (hash * 31 + c.charCodeAt(0)) | 0;
  return (
    <span
      aria-hidden="true"
      className={`avatar ${large ? 'large' : ''}`}
      style={{ background: `hsl(${(Math.abs(hash) % 60) + 210} 20% 41%)` }}
    >
      {name.trim().charAt(0).toUpperCase() || '•'}
    </span>
  );
}
const modalStack: HTMLDivElement[] = [];
let previousBodyOverflow = '';
export function Modal({
  title,
  onClose,
  children,
  closeLabel,
  wide = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  closeLabel: string;
  wide?: boolean;
}) {
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const dialog = ref.current;
    if (!dialog) return;
    if (!modalStack.length) previousBodyOverflow = document.body.style.overflow;
    const underneath = modalStack.at(-1);
    if (underneath) {
      underneath.inert = true;
      underneath.setAttribute('aria-hidden', 'true');
    }
    modalStack.push(dialog);
    const first = dialog.querySelector<HTMLElement>('input,select,textarea,button,[tabindex="0"]');
    first?.focus();
    const listener = (e: KeyboardEvent) => {
      if (modalStack.at(-1) !== dialog) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        closeRef.current();
      }
      if (e.key === 'Tab') {
        const items = [
          ...dialog.querySelectorAll<HTMLElement>(
            'button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],[tabindex="0"]',
          ),
        ].filter((x) => !x.hidden && x.getClientRects().length);
        const first = items[0],
          last = items.at(-1);
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener('keydown', listener);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', listener);
      const wasTop = modalStack.at(-1) === dialog;
      const index = modalStack.indexOf(dialog);
      if (index >= 0) modalStack.splice(index, 1);
      const next = modalStack.at(-1);
      if (next) {
        next.inert = false;
        next.removeAttribute('aria-hidden');
      } else document.body.style.overflow = previousBodyOverflow;
      if (wasTop && previous?.isConnected) previous.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        className={`modal ${wide ? 'wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="sheet-handle" />
        <header className="modal-header">
          <h2 id={titleId}>{title}</h2>
          <button className="close-button" aria-label={closeLabel} onClick={onClose}>
            <X size={20} />
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}
export function PageHeader({
  title,
  onBack,
  backLabel,
  children,
}: {
  title: string;
  onBack?: () => void;
  backLabel?: string;
  children?: ReactNode;
}) {
  return (
    <header className={`page-header ${onBack ? 'centered' : ''}`}>
      {onBack && (
        <button className="back-button" onClick={onBack}>
          <ArrowLeft size={21} />
          <span>{backLabel}</span>
        </button>
      )}
      <h1>{title}</h1>
      {children && <div className="header-tools">{children}</div>}
    </header>
  );
}
export function Row({
  label,
  value,
  icon: Icon,
  onClick,
  danger = false,
  children,
}: {
  label: string;
  value?: string;
  icon?: LucideIcon;
  onClick?: () => void;
  danger?: boolean;
  children?: ReactNode;
}) {
  const content = (
    <>
      {Icon && <Icon className="row-icon" size={23} />}
      <span className="row-label">{label}</span>
      {value && <span className="row-value">{value}</span>}
      {children}
      {onClick && <ChevronRight className="chevron" size={19} />}
    </>
  );
  return onClick ? (
    <button className={`settings-row ${danger ? 'danger' : ''}`} onClick={onClick}>
      {content}
    </button>
  ) : (
    <div className={`settings-row ${danger ? 'danger' : ''}`}>{content}</div>
  );
}
export function Toggle({
  label,
  checked,
  onChange,
  disabled = false,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={`toggle ${checked ? 'on' : ''}`}
      role="switch"
      aria-label={label}
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      disabled={disabled}
    >
      <span />
    </button>
  );
}
export function Empty({
  icon: Icon,
  title,
  note,
  children,
}: {
  icon: LucideIcon;
  title: string;
  note?: string;
  children?: ReactNode;
}) {
  return (
    <section className="empty-state">
      <div className="empty-icon">
        <Icon size={31} />
      </div>
      <h2>{title}</h2>
      {note && <p>{note}</p>}
      {children}
    </section>
  );
}
