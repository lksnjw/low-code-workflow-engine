import { Component } from "react";
import Button from "./Button";

class ErrorBoundary extends Component {
  state = { hasError: false };

/*******************************************************************************
 * Function: getDerivedStateFromError
 *
 * Gets derived state from error for the ErrorBoundary module.
 ******************************************************************************/
  static getDerivedStateFromError() {
    return { hasError: true };
  }

/*******************************************************************************
 * Function: componentDidCatch
 *
 * Performs the component Did Catch operation on did catch for the ErrorBoundary module.
 ******************************************************************************/
  componentDidCatch(error, info) {
    console.error(`Render failure in ${this.props.name || "this view"}`, error, info);
  }

/*******************************************************************************
 * Function: render
 *
 * Renders the application for the ErrorBoundary module.
 ******************************************************************************/
  render() {
    if (this.state.hasError) {
      const name = this.props.name || "this view";
      return (
        <section
          role="alert"
          className="m-4 rounded-2xl border border-red-200 bg-red-50 p-6 text-red-900 dark:border-red-900/60 dark:bg-red-950/20 dark:text-red-100"
        >
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-red-600 dark:text-red-300">
            Recoverable render error
          </p>
          <h1 className="mt-2 text-xl font-bold">Could not render {name}</h1>
          <p className="mt-2 text-sm text-red-700 dark:text-red-200">
            Reload the application to restore this screen.
          </p>
          <Button className="mt-5" onClick={() => window.location.reload()}>
            Reload application
          </Button>
        </section>
      );
    }
    return this.props.children;
  }
}

export default ErrorBoundary;
