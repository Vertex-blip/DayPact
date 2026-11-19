import { StrictMode, Component, type ErrorInfo, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';

class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(_error: Error, _info: ErrorInfo) {
    /* Do not send private state to third-party analytics. */
  }
  render() {
    if (this.state.failed)
      return (
        <main className="splash">
          <h1>DayPact</h1>
          <p>Бетті қайта ашып көріңіз · Попробуйте обновить страницу.</p>
          <button className="primary" onClick={() => location.reload()}>
            Қайта ашу · Обновить
          </button>
        </main>
      );
    return this.props.children;
  }
}
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch(() => {
      /* App remains usable online. */
    });
  });
}
