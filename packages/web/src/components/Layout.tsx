import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useLogout, useMe } from '../api/hooks.js';
import {
  Logo,
  IconDashboard,
  IconPlus,
  IconSettings,
  IconLogout,
  IconMoon,
  IconSun,
} from './Icons.js';

type Theme = 'auto' | 'light' | 'dark';

const THEME_KEY = 'pagefreeze-theme';

function readStoredTheme(): Theme {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === 'light' || stored === 'dark' || stored === 'auto') return stored;
  } catch {
    // Storage can be unavailable (private mode); fall back to the OS preference.
  }
  return 'auto';
}

export function useTheme(): [Theme, (theme: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(() => readStoredTheme());

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'auto') {
      root.removeAttribute('data-theme');
    } else {
      root.setAttribute('data-theme', theme);
    }
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      // non-fatal
    }
  }, [theme]);

  return [theme, setTheme];
}

export function Layout({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const { data: me } = useMe();
  const logout = useLogout();
  const [theme, setTheme] = useTheme();

  const onLogout = (): void => {
    logout.mutate(undefined, {
      onSettled: () => {
        navigate('/login', { replace: true });
      },
    });
  };

  const cycleTheme = (): void => {
    const order: Theme[] = ['auto', 'light', 'dark'];
    const next = order[(order.indexOf(theme) + 1) % order.length] ?? 'auto';
    setTheme(next);
  };

  const themeLabel =
    theme === 'auto' ? 'Theme: follow system' : theme === 'light' ? 'Theme: light' : 'Theme: dark';

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>

      <header className="topbar">
        <NavLink to="/" className="topbar__brand" aria-label="Pagefreeze home">
          <Logo />
          <span>Pagefreeze</span>
        </NavLink>

        <nav className="topbar__nav" aria-label="Main">
          <NavLink to="/" end className="topbar__link">
            <span className="row" style={{ gap: 6 }}>
              <IconDashboard size={14} />
              Dashboard
            </span>
          </NavLink>
          <NavLink to="/monitors/new" className="topbar__link">
            <span className="row" style={{ gap: 6 }}>
              <IconPlus size={14} />
              New monitor
            </span>
          </NavLink>
          <NavLink to="/settings" className="topbar__link">
            <span className="row" style={{ gap: 6 }}>
              <IconSettings size={14} />
              Settings
            </span>
          </NavLink>
        </nav>

        <div className="topbar__spacer" />

        <button
          type="button"
          className="btn btn--ghost btn--icon"
          onClick={cycleTheme}
          title={themeLabel}
          aria-label={themeLabel}
        >
          {theme === 'dark' ? <IconMoon size={15} /> : <IconSun size={15} />}
        </button>

        {me ? (
          <>
            <span className="small muted nowrap" aria-label={`Signed in as ${me.username}`}>
              {me.username}
            </span>
            <button
              type="button"
              className="btn btn--ghost btn--icon"
              onClick={onLogout}
              title="Sign out"
              aria-label="Sign out"
              disabled={logout.isPending}
            >
              <IconLogout size={15} />
            </button>
          </>
        ) : null}
      </header>

      <main className="main" id="main">
        {children}
      </main>
    </div>
  );
}
