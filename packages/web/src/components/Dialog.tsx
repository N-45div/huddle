import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { describeError } from "../api.ts";

interface ModalProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly title: string;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
}

/** A modal on the native <dialog>, so focus stays inside and Escape closes it. */
export function Modal({ open, onClose, title, children, footer }: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="modal"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        // A click on the dialog element itself (not its contents) is a click on the backdrop.
        if (event.target === ref.current) onClose();
      }}
    >
      {open && (
        <div className="modal-inner">
          <h2 id={titleId} className="modal-title">
            {title}
          </h2>
          <div className="modal-body">{children}</div>
          {footer && <div className="modal-footer">{footer}</div>}
        </div>
      )}
    </dialog>
  );
}

interface ConfirmProps {
  readonly open: boolean;
  readonly title: string;
  readonly children: ReactNode;
  readonly confirmLabel: string;
  readonly danger?: boolean;
  /** May be async; a thrown error is shown in the dialog and it stays open. */
  readonly onConfirm: () => Promise<void> | void;
  readonly onCancel: () => void;
}

export function ConfirmDialog({ open, title, children, confirmLabel, danger = false, onConfirm, onCancel }: ConfirmProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setBusy(false);
      setError(null);
    }
  }, [open]);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={() => {
        if (!busy) onCancel();
      }}
      title={title}
      footer={
        <>
          <button type="button" className="btn" onClick={onCancel} disabled={busy} autoFocus>
            Cancel
          </button>
          <button type="button" className={danger ? "btn btn-danger-solid" : "btn btn-primary"} onClick={() => void confirm()} disabled={busy}>
            {busy ? "Working…" : confirmLabel}
          </button>
        </>
      }
    >
      {children}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </Modal>
  );
}
