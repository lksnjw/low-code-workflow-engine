import { useTheme } from "../context/ThemeContext";
import { Icon } from "@iconify/react";
import { appConfig } from "../config/app";

/*******************************************************************************
 * Function: AuthLayout
 *
 * Performs the Auth Layout operation on layout for the AuthLayout module.
 ******************************************************************************/
function AuthLayout({ children, title, subtitle }) {
  const { isDarkMode, toggleTheme } = useTheme();

  return (
    <div className="relative flex min-h-screen overflow-hidden bg-gradient-to-br from-slate-950 via-indigo-950 to-slate-900">
      {/* Ambient glow blobs */}
      <div className="pointer-events-none absolute -top-40 -left-40 h-[600px] w-[600px] rounded-full bg-indigo-600 opacity-20 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-40 -right-20 h-[500px] w-[500px] rounded-full bg-violet-600 opacity-20 blur-3xl" />

      {/* Theme toggle */}
      <button
        type="button"
        onClick={toggleTheme}
        className="absolute right-5 top-5 z-20 rounded-lg border border-white/10 bg-white/5 p-2 text-white/70 backdrop-blur-sm transition hover:bg-white/10"
        aria-label="Toggle theme"
      >
        <Icon icon={isDarkMode ? "mdi:weather-sunny" : "mdi:weather-night"} className="h-5 w-5" />
      </button>

      <div className="relative z-10 m-auto w-full max-w-md px-4 py-12">
        {/* Logo */}
        <div className="mb-8 flex flex-col items-center text-center">
          <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-600 shadow-lg shadow-indigo-500/40">
            <Icon icon="tabler:git-branch" className="h-7 w-7 text-white" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-white">{title}</h1>
          {subtitle && <p className="mt-1 text-sm text-white/50">{subtitle}</p>}
        </div>

        {/* Card */}
        <div className="rounded-2xl border border-white/10 bg-white/5 p-8 shadow-2xl backdrop-blur-xl">
          {children}
        </div>

        <p className="mt-6 text-center text-xs text-white/30">
          {appConfig.name} · v{appConfig.version}
        </p>
      </div>
    </div>
  );
}

export default AuthLayout;
