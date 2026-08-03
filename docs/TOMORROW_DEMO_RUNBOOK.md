# Tomorrow's Demo Runbook

Use this runbook for the live demonstration. The reliable core demo does not
depend on Gemini, Ollama, Python, or a real ERP. It uses the standalone mock ERP
through the same MCP HTTP interface used by a real integration.

Repository root:

```text
C:\Users\LKsnj\Desktop\RESEARCH_LAKSHAN\IMPLIMENTATION\low-code-workflow-engine
```

Application URLs:

| Service | URL |
|---|---|
| Frontend | `http://127.0.0.1:5173` |
| Backend health | `http://127.0.0.1:8080/healthz` |
| Mock ERP health | `http://127.0.0.1:9000/healthz` |

## What the system demonstrates

- Role-based administration: Platform Admin, System Admin, Workflow Builder,
  and Client.
- A typed tool and policy-rule registry, including bulk import and generated
  workflow context.
- Visual workflow construction and optional natural-language generation.
- Validation before execution and signed validation-token checks at dispatch.
- Execution through a real MCP HTTP boundary to a deterministic mock ERP.
- A policy violation stopping the tool call before it reaches the ERP.
- Execution history, detailed step status, audit logs, and analytics.
- Clear separation between the writable runtime registry and the frozen
  evaluation registry.

## 1. Prepare tonight

Open PowerShell and run:

```powershell
Set-Location 'C:\Users\LKsnj\Desktop\RESEARCH_LAKSHAN\IMPLIMENTATION\low-code-workflow-engine'

go version
node --version
npm.cmd --version
```

The project expects Go 1.22 or newer and Node.js 20 or newer.

Use `backend/.env.local`, which is the first environment file loaded by this
build. Create it only if it does not already exist. Do not overwrite an
existing `.env.local`:

```powershell
if (-not (Test-Path -LiteralPath '.\backend\.env.local')) {
    if (Test-Path -LiteralPath '.\backend\.env') {
        Copy-Item -LiteralPath '.\backend\.env' -Destination '.\backend\.env.local'
    } else {
        Copy-Item -LiteralPath '.\backend\.env.example' -Destination '.\backend\.env.local'
    }
}
notepad '.\backend\.env.local'
```

Ensure these entries are present. Replace the angle-bracket values with your
own local demo credentials and never show them on screen:

```dotenv
APP_ENV=development
APP_HOST=127.0.0.1
APP_PORT=8080
FRONTEND_URL=http://127.0.0.1:5173
JWT_SECRET=<a-long-random-local-secret>
JWT_EXPIRES_MINUTES=60
BOOTSTRAP_ADMIN_EMAIL=<your-demo-admin-email>
BOOTSTRAP_ADMIN_PASSWORD=<a-password-of-at-least-8-characters>
STORAGE_DRIVER=postgres
DATABASE_URL=postgres://workflow:<database-password>@127.0.0.1:5432/workflow?sslmode=disable
STORAGE_ENCRYPTION_KEY=<a-unique-32-byte-base64-or-hex-key>
MCP_MODE=remote
MCP_BASE_URL=http://127.0.0.1:9000
SEMANTIC_FALLBACK=lexical
EXPERIMENT_BASELINE=
```

Important:

- Keep `APP_ENV=development`; the mock ERP refuses production mode.
- Leave `EXPERIMENT_BASELINE` empty so the deterministic gate stays enabled.
- Do not point `TOOL_REGISTRY_PATH` or `RULE_REGISTRY_PATH` at
  `configs/registries`. The live application uses `configs/runtime`.
- PostgreSQL mode preserves users, workflows, executions, assignments,
  providers, and sessions across backend restarts. The encryption key must stay
  the same; changing or losing it makes the encrypted stored snapshot unreadable.
- If PostgreSQL cannot be configured before rehearsal, the fallback is
  `STORAGE_DRIVER=memory`. Memory mode is dependency-free but users, workflows,
  executions, and sessions disappear whenever the backend restarts.
- Do not use `JWT_EXPIRES_MINUTES=1` for the presentation. That value is only
  useful for expiry testing.

Install frontend dependencies tonight, not immediately before the demo:

```powershell
Set-Location '.\frontend'
npm.cmd install
npm.cmd test
npm.cmd run build
Set-Location '..\backend'
go test .\tests\integration -run TestGovernedDemoFlowThroughRealRoutes -count=1 -v
Set-Location '..'
```

### Configure the local PostgreSQL database once

This workstation has PostgreSQL 18 installed as the Windows service
`postgresql-x64-18`. Check it from PowerShell:

```powershell
Get-Service 'postgresql-x64-18'
pg_isready -h 127.0.0.1 -p 5432
```

Expected: service status `Running` and `accepting connections`.

Open `psql` using the PostgreSQL administrator account. It will ask for the
administrator password chosen when PostgreSQL was installed:

```powershell
psql -h 127.0.0.1 -p 5432 -U postgres -d postgres
```

At the `postgres=#` prompt, create the project role and database. Replace the
password with a local alphanumeric password so it can be placed in a URL
without additional encoding:

```sql
CREATE ROLE workflow WITH LOGIN PASSWORD '<database-password>';
CREATE DATABASE workflow OWNER workflow;
\q
```

If PostgreSQL reports that `workflow` already exists, reconnect as the
administrator and run:

```sql
ALTER ROLE workflow WITH LOGIN PASSWORD '<database-password>';
```

If the database already exists, do not recreate it. Ensure it has the expected
owner:

```sql
ALTER DATABASE workflow OWNER TO workflow;
```

Generate the required encryption key once:

```powershell
[Convert]::ToBase64String(
    [Security.Cryptography.RandomNumberGenerator]::GetBytes(32)
)
```

Copy the result into `STORAGE_ENCRYPTION_KEY` in `backend/.env.local`. Keep it private
and keep a secure backup. Put the same database password in `DATABASE_URL`.

Check the project login without printing the password:

```powershell
$env:PGPASSWORD='<database-password>'
psql -h 127.0.0.1 -p 5432 -U workflow -d workflow -X `
    -c 'SELECT current_database(), current_user;'
Remove-Item Env:PGPASSWORD
```

Expected database and user: `workflow` and `workflow`.

## 2. Start everything

PostgreSQL is a fourth service and must already be running. The recommended
command then starts the three application processes—mock ERP, backend, and
frontend—in the correct order and writes their output to `.demo-logs`:

```powershell
Set-Location 'C:\Users\LKsnj\Desktop\RESEARCH_LAKSHAN\IMPLIMENTATION\low-code-workflow-engine'
powershell.exe -ExecutionPolicy Bypass -File '.\scripts\start-mock-demo.ps1'
```

The command prints three process IDs. Keep that PowerShell output so you can
stop the services later. Wait several seconds for Vite, then open:

```text
http://127.0.0.1:5173
```

### Verify all three services

In another PowerShell window:

```powershell
Invoke-RestMethod 'http://127.0.0.1:9000/healthz'
Invoke-RestMethod 'http://127.0.0.1:8080/healthz'
(Invoke-WebRequest 'http://127.0.0.1:5173').StatusCode
```

Expected: both health responses say `healthy`, and the frontend returns `200`.

Confirm the backend selected durable PostgreSQL storage:

```powershell
Select-String -Path '.\.demo-logs\backend.stdout.log' `
    -Pattern 'storage initialized'
```

Expected backend log fields:

```text
"driver": "postgres", "durable": true
```

After the backend starts once, confirm that its automatic migrations created
the storage tables:

```powershell
$env:PGPASSWORD='<database-password>'
psql -h 127.0.0.1 -p 5432 -U workflow -d workflow -X -c '\dt'
Remove-Item Env:PGPASSWORD
```

Expected tables: `runtime_state` and `schema_migrations`.

If startup fails, inspect:

```powershell
Get-Content '.\.demo-logs\mock-erp.stderr.log'
Get-Content '.\.demo-logs\backend.stderr.log'
Get-Content '.\.demo-logs\frontend.stderr.log'
```

### Manual three-terminal fallback

Use this only if the launcher fails. The complete execution demo has four
services, not three: PostgreSQL, mock ERP, backend, and frontend.

PostgreSQL service check:

```powershell
Get-Service 'postgresql-x64-18'
pg_isready -h 127.0.0.1 -p 5432
```

Terminal 1 — mock ERP:

```powershell
Set-Location 'C:\Users\LKsnj\Desktop\RESEARCH_LAKSHAN\IMPLIMENTATION\low-code-workflow-engine\backend'
$env:APP_ENV='development'
$env:MOCK_ERP_PORT='9000'
$env:MOCK_ERP_FAIL_TOOL=''
$env:MOCK_ERP_FAIL_MODE=''
go run -buildvcs=false .\cmd\mock-erp
```

Terminal 2 — backend:

```powershell
Set-Location 'C:\Users\LKsnj\Desktop\RESEARCH_LAKSHAN\IMPLIMENTATION\low-code-workflow-engine\backend'
$env:APP_ENV='development'
$env:MCP_MODE='remote'
$env:MCP_BASE_URL='http://127.0.0.1:9000'
go run -buildvcs=false .\cmd\server
```

Terminal 3 — frontend:

```powershell
Set-Location 'C:\Users\LKsnj\Desktop\RESEARCH_LAKSHAN\IMPLIMENTATION\low-code-workflow-engine\frontend'
npm.cmd run dev -- --host 127.0.0.1
```

## 3. Live demo: reliable 10-minute story

### Minute 0–1: sign in and explain the architecture

1. Open `http://127.0.0.1:5173`.
2. Sign in with the bootstrap email and password from `backend/.env.local`.
3. Confirm the interface identifies the development/mock-ERP environment.
4. Say: “The frontend calls the workflow backend. The backend validates a
   typed workflow against typed tool and rule registries. Only a validated
   execution can cross the MCP boundary into the ERP.”

### Minute 1–3: show governance and administration

1. Open **Registry** > **Tools & Rules**.
2. On **Tools**, find **Demo Echo** (`TOOL-DEMO-001`).
3. Show its registered action `demo.echo`, required parameters `message` and
   `amount`, read-only behavior, and allowed roles.
4. On **Rules**, look for `DEMO-AMOUNT-001`.
5. If it is absent, add the rule using the JSON in
   `docs/DEMO.md`, section **6. Verify the demo tool and add the policy rule**.
6. Open **Users** > **Roles** briefly to show permissions are role-based.

Narration: “The LLM or builder proposes a workflow, but it does not decide
whether execution is safe. The deterministic validator and dispatch-time gate
make that decision from typed data.”

### Minute 3–5: create the two demo users

Open **Users** > **Directory** and create:

| User | Role | Purpose |
|---|---|---|
| Demo Builder | Workflow Builder | Creates and assigns the workflow |
| Demo Client | Client | Runs only an owned or assigned workflow |

Use passwords of at least eight characters. Keep the credentials on a private
note, not in the presentation or repository.

Narration: “The Builder can create workflows but does not gain platform
administration. The Client can run only workflows within their own scope.”

### Minute 5–7: build and assign a governed workflow

1. Sign out and sign in as **Demo Builder**.
2. Open **Workflows** > **Flow Builder**.
3. In the `demo` catalog group, drag **Demo Echo** onto the canvas.
4. Click **Deploy Workflow**.
5. Open **Workflows** > **All Workflows**.
6. Open the deployed workflow; its default name may be **Untitled workflow**.
7. Under **Assigned users**, select **Demo Client**.

The generated step parameters should use runtime input:

```yaml
parameters:
  message: "{{input.message}}"
  amount: "{{input.amount}}"
```

Narration: “The amount is not known at design time. The signed validation token
therefore records a deferred check, and the runner checks the resolved value
again immediately before dispatch.”

### Minute 7–8: run the safe case

1. Sign out and sign in as **Demo Client**.
2. Open **My Workflows** and select the assigned workflow.
3. Click **Run** and enter:

```json
{
  "message": "hello from the governed client workflow",
  "amount": 10
}
```

4. Click **Run workflow**.
5. Confirm the execution is `DONE`.
6. Open **My Executions** > **Run History** and show the completed step.

Narration: “Ten is within the allowed threshold, so the validated tool call
crossed MCP and the mock ERP returned a JSON result.”

### Minute 8–10: run the unsafe case

Run the same workflow with:

```json
{
  "message": "this call must never reach the ERP",
  "amount": 150
}
```

Expected result:

- The execution is `FAILED`.
- The detail identifies rule `DEMO-AMOUNT-001`.
- The interface explains that the tool was never called.
- There is no successful `demo.echo executed through tool registry` entry.

Narration: “This is the important result. The request was blocked after runtime
input resolution but before tool dispatch. The policy decision did not depend
on interpreting Markdown or LLM prose.”

Finish by opening **Audit Logs** or **Analytics** to show that the outcome is
observable after execution.

## 4. Optional AI-generation segment

Only include this if it works in a rehearsal on the same network and API key.
The core demo above does not need it.

1. As Platform Admin, open **Models** > **Provider Configs**.
2. Add or activate a Gemini provider using model `gemini-2.5-flash`.
3. Enter the API key only in the write-only credential field.
4. Click **Test connection** and require **Connection successful** before the
   audience arrives.
5. Open **Agent Chat** and ask for a small workflow using registered tools.
6. Review the generated workflow in the Builder before deploying it.

If generation times out or returns invalid output, stop this segment and use
the already-rehearsed Demo Echo workflow. Do not spend the live demo debugging
an external model or network connection.

## 5. Optional transient ERP failure

This demonstrates that an ERP/service failure is different from a governance
block. Stop the current demo processes, then restart with an injected failure:

```powershell
powershell.exe -ExecutionPolicy Bypass -File '.\scripts\start-mock-demo.ps1' `
    -FailTool 'demo.echo' `
    -FailMode 'transient'
```

Run the safe input again. The failure should be classified as transient rather
than displayed as a policy violation. Because the memory backend loses state
after restart, use this only if you have rehearsed the setup cost or are using
an already-configured durable store.

Return to normal behavior by restarting without `-FailTool` and `-FailMode`.

## 6. Reset and shutdown

Reset only the mock ERP fixtures and its request log:

```powershell
Invoke-RestMethod -Method Post 'http://127.0.0.1:9000/reset'
```

To stop launcher-started services, use the three process IDs printed when the
launcher ran:

```powershell
Stop-Process -Id <mock-erp-pid>,<backend-pid>,<frontend-pid>
```

For manually started services, press `Ctrl+C` once in each terminal.

Do not delete `configs/runtime` or modify `configs/registries` as a reset
mechanism.

## 7. Troubleshooting

### Backend says bootstrap administrator variables are missing

Set non-empty `BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD` in
`backend/.env.local`. The password must contain at least eight characters. Restart
the backend.

### Data disappears after a backend restart

Check the backend startup log. It must contain `driver=postgres` and
`durable=true`. If it says `driver=memory`, correct `STORAGE_DRIVER`,
`DATABASE_URL`, and `STORAGE_ENCRYPTION_KEY` in `backend/.env.local`, then restart the
backend.

### The banner says the server is unreachable

Check `http://127.0.0.1:8080/healthz` and
`.demo-logs/backend.stderr.log`. Once the backend is healthy, press **Retry** in
the banner. A network failure should not itself clear browser tokens.

### Frontend is unavailable

Check `.demo-logs/frontend.stderr.log`. If dependencies are missing:

```powershell
Set-Location '.\frontend'
npm.cmd install
npm.cmd run dev -- --host 127.0.0.1
```

### Mock ERP is unavailable

Check `http://127.0.0.1:9000/healthz` and
`.demo-logs/mock-erp.stderr.log`. Confirm `APP_ENV=development`,
`MCP_MODE=remote`, and `MCP_BASE_URL=http://127.0.0.1:9000`.

### A port is already in use

Identify the owning process before stopping anything:

```powershell
Get-NetTCPConnection -LocalPort 5173,8080,9000 -ErrorAction SilentlyContinue |
    Select-Object LocalPort, State, OwningProcess
```

If the listed process is an old copy of this demo, stop that exact PID and
start again. Do not terminate an unfamiliar process.

### The rule already exists

Do not create a duplicate. Open `DEMO-AMOUNT-001`, verify it is enabled, and
continue.

### Chat generation fails

The deterministic Builder and execution demo remain valid. Skip Chat and use
the Demo Echo workflow.

## 8. Five-minute pre-demo checklist

- Laptop connected to power; sleep disabled temporarily.
- Browser zoom and screen sharing checked.
- Notifications and sensitive applications closed.
- `.env` contains bootstrap credentials, but the file is not displayed.
- Mock ERP, backend, and frontend health checks pass.
- PostgreSQL reports `accepting connections` on port `5432`.
- Backend startup reports PostgreSQL storage with `durable: true`.
- Platform Admin login works.
- `Demo Echo` exists in the runtime tool registry.
- `DEMO-AMOUNT-001` exists and is enabled.
- Safe input `amount: 10` finishes `DONE`.
- Unsafe input `amount: 150` finishes `FAILED` and says the tool was not called.
- External Gemini generation is used only if its connection test passes.
- `.demo-logs` are available as a fallback if something fails.

## 9. Emergency 90-second version

If presentation time is cut short:

1. Show **Registry** > **Tools & Rules** and open `Demo Echo` plus
   `DEMO-AMOUNT-001`.
2. Open the prepared workflow and run `amount: 10`; show `DONE`.
3. Run `amount: 150`; show `FAILED`, the rule ID, and “tool never called.”
4. Open the two executions side by side in **Run History**.
5. Conclude: “Workflow generation is flexible; validation and dispatch are
   deterministic and governed by typed registries.”

For the longer technical explanation and the exact policy-rule JSON, see
`docs/DEMO.md`.
