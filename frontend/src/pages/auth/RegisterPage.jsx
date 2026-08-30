import { useState } from "react";
import { useAuthContext } from "../../context/AuthContext";
import AuthLayout from "../../layouts/AuthLayout";

/*******************************************************************************
 * Function: InputField
 *
 * Performs the Input Field operation on field for the RegisterPage module.
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
 * Function: RegisterPage
 *
 * Performs the Register Page operation on page for the RegisterPage module.
 ******************************************************************************/
function RegisterPage({ onNavigate }) {
  const { register, loading, authError } = useAuthContext();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [organizationName, setOrganizationName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [localError, setLocalError] = useState("");

/*******************************************************************************
 * Function: handleSubmit
 *
 * Handles submit for the RegisterPage module.
 ******************************************************************************/
  const handleSubmit = async (e) => {
    e.preventDefault();
    setLocalError("");
    if (password !== confirm) {
      setLocalError("Passwords do not match.");
      return;
    }
    if (password.length < 8) {
      setLocalError("Password must be at least 8 characters.");
      return;
    }
    try {
      await register({ name, email, password, organizationName });
      // On success, AuthContext sets user → App re-renders main app
    } catch {
      // authError from context is already set
    }
  };

  const error = localError || authError;

  return (
    <AuthLayout
      title="Create your account"
      subtitle="Start building intelligent workflows today"
    >
      <form className="space-y-4" onSubmit={handleSubmit} noValidate>
        <InputField
          label="Full name"
          id="reg-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Jane Smith"
          autoComplete="name"
        />
        <InputField
          label="Work email"
          id="reg-email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@company.com"
          autoComplete="email"
        />
        <InputField
          label="Organization (optional)"
          id="reg-org"
          value={organizationName}
          onChange={(e) => setOrganizationName(e.target.value)}
          placeholder="Acme Corp"
          autoComplete="organization"
        />
        <InputField
          label="Password"
          id="reg-password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Min. 8 characters"
          autoComplete="new-password"
        />
        <InputField
          label="Confirm password"
          id="reg-confirm"
          type="password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          placeholder="••••••••"
          autoComplete="new-password"
        />

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
              Creating account…
            </span>
          ) : (
            "Create account"
          )}
        </button>

        <p className="pt-2 text-center text-xs text-white/40">
          Already have an account?{" "}
          <button
            type="button"
            onClick={() => onNavigate?.("login")}
            className="font-semibold text-indigo-400 hover:text-indigo-300 transition"
          >
            Sign in
          </button>
        </p>
      </form>
    </AuthLayout>
  );
}

export default RegisterPage;
