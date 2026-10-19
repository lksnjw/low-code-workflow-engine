# Chat and canvas focus UI — 2026-10-17

## Delivered

- Distraction-free full-screen chat, hiding the application header, sidebar and assistant heading.
- Full-screen canvas that preserves canvas-only mode and keeps the floating chat available.
- Exit button and Escape recovery. Escape closes the tool panel before leaving full screen.
- A slim right-side rail and collapsible Workspace tools panel, with independent Chat tools and Canvas tools sections.
- Chat history, document controls, quick prompts and model selection moved out of the conversation's vertical space.
- Canvas heading, workflow selector, publication/review controls, edit history, node inspector, run/simulation forms and source preview moved into Canvas tools.
- The saved-workflow graph fills the available pane instead of using its previous 220–340 pixel height.
- Selecting a graph node opens its right-side inspector. Unsaved inspector fields remain mounted when the panel is hidden.
- Dashboard moved to the top of the left sidebar; the chat's extra Dashboard row was removed. Existing permission checks remain in place.

The frontend design skill guided the restrained layout: the working surface is primary, controls are secondary, and existing neutral/purple styling is retained. Display changes are immediate; subtle existing color transitions remain on controls without adding layout animations.

## Scope

UI only. No model response, workflow execution, approval, ERPBridge, pipeline or RAG behavior was changed for these requests. No ERP actions were dispatched during this UI verification. No backend deployment was performed.

Chat/canvas components and portal destinations remain mounted across presentation changes. Full-screen state is temporary; it does not overwrite the account-scoped saved split ratio or view preference. Covered application chrome is hidden and made inert while full screen is active, then restored on exit/unmount.

## Verification

- Full frontend suite: **143 suites, 1,274 tests passed, zero failures**.
- Includes regression coverage for draft/model identity, switching views, floating chat, keyboard resizing, full-screen exit, tool-panel state, unsaved node edits, no unintended execution, and Dashboard permission boundaries.
- Evidence: `tmp/chat-canvas-frontend-final-20261017.json`.
- Local Vite build: passed.
- Hosting build and artifact verification: passed, 86 public files.
- Public credential scan: passed, no known private values exposed.
- Scoped `git diff --check`: passed.
- Scoped lint passes with two existing React compiler/effect rules disabled. Unfiltered lint still reports the existing model-catalog effect in ChatWindow and manual memoization in WorkflowWorkspaceCanvas; no blanket lint-clean claim is made.
- Jest reported an asynchronous-open-handle warning after all tests completed. Its saved result reports success; this is not a claim that open handles have been diagnosed.

## Staging release

Frontend-only Firebase Hosting release completed successfully for `workflow-automation-44201`, using the configured account.

- URL: https://workflow-automation-44201.web.app/
- Public index HTTP 200 and byte-for-byte match with the built Hosting artifact.
- Index SHA-256: `a84af57030e5ab7c6b8bfddfe321260ec6e7e4e9437bb4e9d97b0b8bdd4a7cf7`.
- Existing hosted backend health endpoint returned HTTP 200.
- Firebase Functions, database content and permissions were not deployed or migrated.

## Live visual QA limitation

Initial local browser checks observed the new chat controls and the assistant heading hidden in focus mode. The final canvas-first build could not receive complete visual acceptance: after the desktop/browser update, the local tab became a connection-error page, and the hosted tab reload became a DNS-error page. The browser security policy prevents automation of those internal error documents. No alternate browser, injected DOM, screenshot fabrication or policy workaround was used.

The local stack was restarted from the existing emulator export after its previous processes stopped. HTTP login succeeds, but the old local QA chat `chat_69_271c8920` returns 404 for that session; restoration of that historical fixture is not qualified here. No export or backup files were deleted. The local startup helper was left with its pre-task import preference.

Final live browser acceptance remains pending; automated tests and deployment verification are not a substitute for it.

## How to use

1. Open or reload the deployed chat.
2. Use **Tools → Canvas only** for the graph-first workspace.
3. Use **Focus** on the right rail for full-screen canvas; **Exit** restores the previous view.
4. Select a node to open its settings on the right. Close Tools to give the graph the maximum area.
5. Use **Tools → Chat only**, then **Focus**, for full-screen conversation. Tools retains model, document and history controls.

Publishing, applying a draft change, running and approving ERP actions remain separate explicit actions.
