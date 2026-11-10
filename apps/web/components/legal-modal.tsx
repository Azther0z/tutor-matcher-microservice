"use client";

import { useEffect, useRef } from "react";

/** Modal built on the native dialog element: Esc, focus trapping and the backdrop come from the browser. */
export function LegalModal({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className="legal-modal"
      aria-label={title}
      onClose={onClose}
      onClick={(event) => { if (event.target === ref.current) onClose(); }}
    >
      <div className="legal-modal-head">
        <h2>{title}</h2>
        <button type="button" className="legal-modal-close" aria-label="Close" onClick={onClose}>×</button>
      </div>
      <div className="legal-modal-body legal-copy">{children}</div>
      <div className="legal-modal-foot"><button type="button" className="button" onClick={onClose}>Close</button></div>
    </dialog>
  );
}
