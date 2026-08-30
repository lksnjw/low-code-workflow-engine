/**
 * Function: useAuth
 * that only need user/isAuthenticated without the full context.
 */
import { useAuthContext } from "../context/AuthContext";

/*******************************************************************************
 * Function: useAuth
 *
 * Provides auth for the useAuth module.
 ******************************************************************************/
export function useAuth() {
  return useAuthContext();
}

export default useAuth;
