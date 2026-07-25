import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import ErrorBoundary from "./components/shared/ui/ErrorBoundary";
import "./styles/globals.css";
import "./styles/theme.css";
import "./styles/typography.css";
import "./styles/animations.css";
import "./styles/flow.css";
import "./styles/markdown.css";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <ErrorBoundary name="frontend root">
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
