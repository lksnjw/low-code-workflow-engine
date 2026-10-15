import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "react-router-dom";
import ErrorBoundary from "./components/shared/ui/ErrorBoundary";
import { appRouter } from "./config/router";
import { AuthProvider, useAuthContext } from "./context/AuthContext";
import { authorityScope } from "./utils/authAuthority";
import { NotificationProvider } from "./context/NotificationContext";
import { ThemeProvider } from "./context/ThemeContext";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 15_000, retry: 1, refetchOnWindowFocus: false },
  },
});

function AccountNotifications({ children }) {
  const { user } = useAuthContext();
  return <NotificationProvider key={authorityScope(user)}>{children}</NotificationProvider>;
}

/*******************************************************************************
 * Function: App
 *
 * Performs the App operation on the application for the App module.
 ******************************************************************************/
function App() {
  return (
    <ErrorBoundary name="application root">
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <AuthProvider>
            <AccountNotifications>
              <RouterProvider router={appRouter} />
            </AccountNotifications>
          </AuthProvider>
        </ThemeProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}

export default App;
