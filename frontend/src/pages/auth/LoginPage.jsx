import { useState } from "react";
import { useAuthContext } from "../../context/AuthContext";
import AuthLayout from "../../layouts/AuthLayout";

/*******************************************************************************
 * Function: InputField
 *
 * Performs the Input Field operation on field for the LoginPage module.
 ******************************************************************************/
function InputField({ label, id, type = "text", value, onChange, placeholder, autoComplete }) {
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-xs font-medium text-white/60">
        {label}
      </label>
      <input
        id={id}
        type={type}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        autoComplete={autoComplete}
        required
        className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white placeholder-white/30 outline-none ring-indigo-500 transition focus:border-indigo-500/60 focus:ring-1"
      />
    </div>
  );
}

/*******************************************************************************
 * Function: LoginPage
 *
 * Performs the Login Page operation on page for the LoginPage module.
 ******************************************************************************/
function LoginPage({ onNavigate }) {
  const { login, loading, authError } = useAuthContext();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [localError, setLocalError] = useState("");

/*******************************************************************************
 * Function: handleSubmit
 *
 * Handles submit for the LoginPage module.
 ******************************************************************************/
  const handleSubmit = async (e) => {
    e.preventDefault();
    setLocalError("");
    try {
      await login({ email, password });
      // On success, AuthContext sets user → App re-renders the main app automatically
    } catch {
      // authError from context is already set
    }
  };

  const error = localError || authError;

  return (
    <AuthLayout
      title="Welcome back"
      subtitle="Sign in to your Agentic Workflow account"
    >
      <form className="space-y-4" onSubmit={handleSubmit} noValidate>
        <InputField
          label="Email address"
          id="login-email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@company.com"
          autoComplete="email"
        />
        <InputField
          label="Password"
          id="login-password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="••••••••"
          autoComplete="current-password"
        />

        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => onNavigate?.("forgot-password")}
            className="text-xs text-indigo-400 hover:text-indigo-300 transition"
          >
            Forgot password?
          </button>
        </div>

        {error && (
          <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-xs font-medium text-red-400">
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-xl bg-gradient-to-r from-indigo-600 to-violet-600 py-3 text-sm font-semibold text-white shadow-lg shadow-indigo-500/30 transition hover:from-indigo-500 hover:to-violet-500 disabled:opacity-60"
        >
          {loading ? (
            <span className="flex items-center justify-center gap-2">
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
              Signing in…
            </span>
          ) : (
            "Sign in"
          )}
        </button>

        <p className="pt-2 text-center text-xs text-white/40">
          Don&apos;t have an account?{" "}
          <button
            type="button"
            onClick={() => onNavigate?.("register")}
            className="font-semibold text-indigo-400 hover:text-indigo-300 transition"
          >
            Create one free
          </button>
        </p>
      </form>
    </AuthLayout>
  );
}

export default LoginPage;
