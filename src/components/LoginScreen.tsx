import { type FormEvent } from "react";
import brandLogo from "../../Branding/Logo.png";

export function LoginScreen(props: {
  loginUsername: string;
  loginPassword: string;
  loginError: string;
  onUsernameChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <div className="login-page">
      <div className="login-card login-layout">
        <section className="login-hero-panel">
          <div className="login-logo-shell">
            <div className="login-logo-frame">
              <img src={brandLogo} alt="BreakPerfect logo" />
            </div>
          </div>
          <div className="login-hero-copy">
            <div className="eyebrow">BreakPerfect Gaming Lounge</div>
            <h1>Game Parlour Management System</h1>
            <p>Billing, live sessions, consumables, and owner visibility from one operational dashboard.</p>
            <div className="login-feature-list">
              <span>Live station control</span>
              <span>Session billing</span>
              <span>Inventory alerts</span>
            </div>
          </div>
        </section>

        <section className="login-form-panel">
          <div className="login-form-copy">
            <h2>Sign In</h2>
            <p>Use your assigned role credentials to access the parlour dashboard.</p>
          </div>
          <form className="form-grid" onSubmit={props.onSubmit}>
            <label>
              <span>Username</span>
              <input value={props.loginUsername} onChange={(event) => props.onUsernameChange(event.target.value)} />
            </label>
            <label>
              <span>Password</span>
              <input type="password" value={props.loginPassword} onChange={(event) => props.onPasswordChange(event.target.value)} />
            </label>
            {props.loginError && <div className="error-text field-span-full">{props.loginError}</div>}
            <button className="primary-button field-span-full" type="submit">Sign In</button>
          </form>
        </section>
      </div>
    </div>
  );
}
