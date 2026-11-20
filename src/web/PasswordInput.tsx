import { useId, useState, type InputHTMLAttributes } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import type { Locale } from '../shared/contracts';
import { texts } from './i18n';

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & {
  label: string;
  locale: Locale;
  hint?: string;
};

export function PasswordInput({ label, locale, hint, id, ...inputProps }: Props) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const hintId = `${inputId}-hint`;
  const [visible, setVisible] = useState(false);
  const t = texts(locale);
  const description = [inputProps['aria-describedby'], hint ? hintId : undefined]
    .filter(Boolean)
    .join(' ');

  return (
    <div className="form-label password-field">
      <label htmlFor={inputId}>{label}</label>
      <div className="password-control">
        <input
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          {...inputProps}
          id={inputId}
          type={visible ? 'text' : 'password'}
          aria-describedby={description || undefined}
        />
        <button
          className="password-toggle"
          type="button"
          aria-label={visible ? t.hidePassword : t.showPassword}
          aria-controls={inputId}
          disabled={inputProps.disabled}
          onClick={() => setVisible((value) => !value)}
        >
          {visible ? <EyeOff size={20} aria-hidden="true" /> : <Eye size={20} aria-hidden="true" />}
        </button>
      </div>
      {hint && <small id={hintId}>{hint}</small>}
    </div>
  );
}
