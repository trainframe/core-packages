import { useEffect, useRef, useState } from 'react';
import { useBroker } from '../broker/broker-context.js';
import { saveBrokerUrl } from '../config/broker-config.js';
import './Settings.css';

interface SettingsProps {
  initialUrl: string;
}

/**
 * Broker-URL settings form for the simulator-ui. Tucked behind a cog icon in
 * the header: clicking the cog (or pressing Escape / clicking outside) toggles
 * the panel. When the broker connection is in an error state the cog gains a
 * red-dot badge and the panel auto-opens so the operator notices immediately.
 *
 * The Settings form (accessible textbox + Connect button + alert) lives
 * inside a native `<dialog>` element. The `<dialog>` keeps its content
 * mounted in the DOM even when closed (no `open` attribute), which lets
 * Playwright's role-based selectors resolve. The `broker-error-feedback`
 * spec clicks the cog to open the panel before filling the URL input.
 *
 * Re-adds a settings surface that was retired alongside the old
 * SimControls/LayoutConfig developer panel (see App.tsx). That retirement
 * was correct — the scheduling controls don't belong here. The settings
 * surface does: the operator-facing "broker URL is wrong, fix it" need
 * exists regardless of architecture.
 */
export function Settings({ initialUrl }: SettingsProps) {
  const { client, status, error } = useBroker();
  const [url, setUrl] = useState(initialUrl);
  const [savedUrl, setSavedUrl] = useState(initialUrl);
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDialogElement>(null);
  const cogRef = useRef<HTMLButtonElement>(null);

  // Auto-open when broker transitions into error state.
  useEffect(() => {
    if (status === 'error') {
      setOpen(true);
    }
  }, [status]);

  // Close on Escape key.
  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setOpen(false);
        cogRef.current?.focus();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open]);

  // Close on click outside the panel + cog.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (
        panelRef.current !== null &&
        !panelRef.current.contains(e.target as Node) &&
        cogRef.current !== null &&
        !cogRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    saveBrokerUrl(url);
    setSavedUrl(url);
    client.connect(url);
  }

  const hasError = status === 'error';

  return (
    <div className="tf-settings">
      <button
        ref={cogRef}
        type="button"
        className={`tf-settings__cog${hasError ? ' tf-settings__cog--error' : ''}`}
        aria-label="Settings"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((prev) => !prev)}
        data-testid="settings-cog"
      >
        {/* SVG gear icon — no extra dependency */}
        <svg
          aria-hidden="true"
          focusable="false"
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
        {hasError && (
          <span
            className="tf-settings__error-badge"
            aria-label="Connection error"
            data-testid="settings-error-badge"
          />
        )}
      </button>

      {/* Using the native <dialog> element satisfies the Biome
          useSemanticElements rule and gives correct AT semantics.
          The `open` attribute shows/hides it natively; we also mirror
          the state in data-testid so tests can check visibility. */}
      <dialog
        ref={panelRef}
        className="tf-settings__panel"
        aria-label="Broker settings"
        open={open}
        data-testid="settings-panel"
      >
        <form onSubmit={handleSubmit} aria-label="Broker settings">
          <label>
            <span>Broker URL</span>
            <input
              type="url"
              name="brokerUrl"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="ws://localhost:9001"
              required
            />
          </label>
          <button type="submit">Connect</button>
          <p>
            Currently configured: <code>{savedUrl}</code>
          </p>
          {status === 'error' && (
            <p role="alert" data-testid="broker-error">
              {error?.message ?? "Couldn't reach the broker — check the URL."}
            </p>
          )}
        </form>
      </dialog>
    </div>
  );
}
