import { useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useLogin, useMe } from '../api/hooks.js';
import { Logo } from '../components/Icons.js';
import { Alert, describeError, Spinner } from '../components/ui.js';

export function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { data: me, isLoading: meLoading } = useMe();
  const login = useLogin();

  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');

  // Already authenticated: go where the user was heading.
  if (!meLoading && me) {
    const from = (location.state as { from?: string } | null)?.from ?? '/';
    return <Navigate to={from} replace />;
  }

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    login.mutate(
      { username, password },
      {
        onSuccess: () => {
          const from = (location.state as { from?: string } | null)?.from ?? '/';
          navigate(from, { replace: true });
        },
      },
    );
  };

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-card__brand">
          <Logo size={26} />
          <h1>Pagefreeze</h1>
        </div>
        <p className="login-card__sub">Sign in to see what changed on the pages you watch.</p>

        {login.isError ? <Alert kind="error">{describeError(login.error)}</Alert> : null}

        <form onSubmit={onSubmit} noValidate>
          <div className="field">
            <label className="field__label" htmlFor="username">
              Username
            </label>
            <input
              id="username"
              name="username"
              className="input"
              value={username}
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              required
              onChange={(event) => setUsername(event.target.value)}
            />
          </div>

          <div className="field">
            <label className="field__label" htmlFor="password">
              Password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              className="input"
              value={password}
              autoComplete="current-password"
              required
              onChange={(event) => setPassword(event.target.value)}
              aria-invalid={login.isError}
              aria-describedby={login.isError ? 'login-error' : undefined}
            />
            {login.isError ? (
              <span className="field__error" id="login-error">
                {describeError(login.error)}
              </span>
            ) : null}
          </div>

          <button type="submit" className="btn btn--primary" disabled={login.isPending}>
            {login.isPending ? <Spinner label="Signing in" /> : null}
            Sign in
          </button>
        </form>

        <p className="small faint" style={{ marginTop: 18 }}>
          The password comes from <code>PAGEFREEZE_ADMIN_PASSWORD</code>. There is one admin
          account; multi-user access is on the roadmap.
        </p>
      </div>
    </div>
  );
}
