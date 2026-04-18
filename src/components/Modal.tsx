import { type ReactNode } from "react";

export function Modal(props: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  return (
    <div className="modal-backdrop" role="presentation" onClick={props.onClose}>
      <div
        className={`modal-card ${props.wide ? "is-wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <h2>{props.title}</h2>
          <button className="ghost-button" type="button" onClick={props.onClose}>Close</button>
        </div>
        {props.children}
      </div>
    </div>
  );
}
