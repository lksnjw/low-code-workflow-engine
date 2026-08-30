import { useState } from "react";
import { authService } from "../../services/auth.service";
import AuthLayout from "../../layouts/AuthLayout";
import { Icon } from "@iconify/react";

/*******************************************************************************
 * Function: ForgotPasswordPage
 *
 * Performs the Forgot Password Page operation on password page for the ForgotPasswordPage module.
 ******************************************************************************/
function ForgotPasswordPage({ onNavigate }) {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);

/*******************************************************************************
 * Function: handleSubmit
 *
 * Handles submit for the ForgotPasswordPage module.
 ******************************************************************************/
  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await authService.forgotPassword(email);
      setSent(true);
    } catch (err) {
      setError(err?.response?.data?.message ?? "Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthLayout
      title="Reset your password"
      subtitle="Enter your email and we'll send reset instructions"
    >
      {sent ? (
        <div className="space-y-4 text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-green-500/20">
            <Icon icon="mdi:email-check-outline" className="h-7 w-7 text-green-400" />
          </div>
          <p className="text-sm text-white/60">
            If an account exists for <span className="font-semibold text-white">{email}</span>, you
            will receive a password reset link shortly.
          </p>
          <button
            type="button"
            onClick={() => onNavigate?.("login")}
            className="w-full rounded-xl border border-white/10 py-3 text-sm font-medium text-white/70 transition hover:bg-white/5"
          >
            Back to sign in
          </button>
        </div>
      ) : (
        <form className="space-y-4" onSubmit={handleSubmit} noValidate>
          <div>
            <label htmlFor="fp-email" className="mb-1.5 block text-xs font-medium text-white/60">
              Email address
            </label>
            <input
              id="fp-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com"
              autoComplete="email"
              required
              className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white placeholder-white/30 outline-none ring-indigo-500 transition focus:border-indigo-500/60 focus:ring-1"
            />
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
                Sending…
              </span>
            ) : (
              "Send reset link"
            )}
          </button>

          <p className="pt-2 text-center text-xs text-white/40">
            Remembered it?{" "}
            <button
              type="button"
              onClick={() => onNavigate?.("login")}
              className="font-semibold text-indigo-400 hover:text-indigo-300 transition"
            >
              Back to sign in
            </button>
          </p>
        </form>
      )}
    </AuthLayout>
  );
}

export default ForgotPasswordPage;
