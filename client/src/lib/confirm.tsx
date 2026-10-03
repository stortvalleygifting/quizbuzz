import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';

export interface ConfirmOptions {
  title: string;
  message?: string;
  /** The button that goes ahead, e.g. "Remove". */
  confirmLabel: string;
  /** Red when going ahead loses something. */
  danger?: boolean;
}

type Ask = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<Ask | null>(null);

/**
 * An "are you sure?" pop-up for the buttons that remove someone or drop you
 * out of something. Drawn by the app rather than the browser's own confirm(),
 * which looks like a system warning and is easy to dismiss without reading.
 */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState<ConfirmOptions | null>(null);
  const resolver = useRef<(ok: boolean) => void>();

  const ask = useCallback<Ask>((options) => {
    resolver.current?.(false);
    setOpen(options);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const answer = (ok: boolean) => {
    resolver.current?.(ok);
    resolver.current = undefined;
    setOpen(null);
  };

  return (
    <ConfirmContext.Provider value={ask}>
      {children}
      {open && (
        <div className="modal-backdrop" onClick={() => answer(false)}>
          <div className="modal" role="alertdialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <h2>{open.title}</h2>
            {open.message && <p className="sub">{open.message}</p>}
            <div className="modal-actions">
              <button className="block" onClick={() => answer(false)}>
                Cancel
              </button>
              <button className={`block ${open.danger ? 'danger' : 'primary'}`} onClick={() => answer(true)}>
                {open.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): Ask {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error('useConfirm must be used inside ConfirmProvider');
  return ctx;
}
