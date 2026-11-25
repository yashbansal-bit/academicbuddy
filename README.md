# AcademicBuddy

AcademicBuddy is a small, server-rendered-static web app with a Node.js HTTP
server, SQLite user/session storage, bcrypt password hashing, and email-based
account verification and password reset.

## Requirements

- Node.js 22.13 or newer (the built-in `node:sqlite` module is used)
- npm
- An SMTP account for signup verification, welcome, and password-reset emails

## Run locally

```sh
npm install
cp .env.example .env
# Edit .env and complete the SMTP settings below before signing up.
# Add Google/X OAuth credentials to enable their sign-in buttons.
npm start
```

Open <http://localhost:3000> for the landing page. Registration is at
`/signup`, login at `/login`, and the protected student homepage at `/dashboard`.
Signup, verification, welcome emails, and password reset require configured
SMTP. The server never claims an email was sent when delivery is unavailable.
Set `BASE_URL` to the public HTTPS origin when deploying. Set
`NODE_ENV=production` to enable secure cookies; terminate TLS at the server or
trusted reverse proxy.

### Configure Gmail SMTP

The example `.env` uses Gmail's SMTP endpoint. To enable real verification
emails:

1. Enable 2-Step Verification on the Google account that will send AcademicBuddy
   email, then create an App Password in that account's Google security settings.
   Use the generated App Password, not your normal Google password.
2. In `.env`, set `SMTP_USER` to that Gmail address, `SMTP_PASS` to the App
   Password, and `EMAIL_FROM` to `AcademicBuddy <same-address@gmail.com>`.
   Keep `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=465`, and `SMTP_SECURE=true`.
3. Restart the server after saving `.env`. Signup will send a verification link
   to the address entered in the form; verify delivery by completing signup
   with an inbox you can access.

Never commit `.env` or share SMTP credentials in chat. If Gmail App Passwords
are unavailable for your account, use an SMTP provider enabled for that account
and replace the host, port, secure mode, username, and password with the
provider's values. SMTP credentials and `EMAIL_FROM` must be supplied before
the app reports email delivery as configured.

SQLite is created automatically at `DATABASE_PATH` (default:
`./data/academicbuddy.sqlite`). Keep the database and `.env` private and back
up the database using your normal deployment process.

## Host on Render

The included `render.yaml` configures one Node web service and a persistent
disk for SQLite. **Both the Starter service and persistent disk can incur
charges**; check Render's current pricing before creating anything. The
included disk configuration is single-instance and deploys can cause brief
downtime. Do not use a free service without a persistent disk for real accounts.

1. Put the project in a private Git repository and connect that repository to
   Render. Do not upload `.env`, `data/`, SQLite files, credentials, or
   `node_modules/`.
2. In Render, create a Blueprint from the repository and review the service,
   disk, and costs before confirming. Enter the service's public HTTPS origin
   as `BASE_URL` (for example, `https://your-service.onrender.com`, without a
   trailing slash). If the assigned URL is not known during Blueprint setup,
   set it in the service's Environment settings once Render provides it and
   redeploy. The app cannot start in production with a localhost `BASE_URL`.
3. Configure `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`,
   and `EMAIL_FROM` in Render's Environment settings, then redeploy. Account
   verification and password reset need real SMTP delivery. Render's free web
   services block outbound SMTP ports; the included Starter service is paid.
4. Visit the Render HTTPS URL on another device and test signup, delivery of the
   verification email, login, and logout. New deployments start with a separate
   empty database; local accounts are not automatically copied. Back up the
   persistent disk's database regularly.

Local Ollama on your computer is not accessible to the hosted service.
Chat Buddy is disabled until a hosted OpenAI-compatible provider is configured
with `AI_API_URL`, `AI_API_KEY`, and `AI_MODEL` on Render. That provider may
charge separately; GitHub Copilot's subscription is not an API credential.
Set `BASE_URL` to your custom HTTPS origin if you add a custom domain and
configure any OAuth callbacks accordingly.

## Social sign-in

Google and X sign-in use OAuth 2.0 authorization-code flows with state and
PKCE. In each provider console, register these exact callback URLs:

- `${BASE_URL}/auth/oauth/google/callback`
- `${BASE_URL}/auth/oauth/x/callback`

Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` and/or `X_CLIENT_ID` and
`X_CLIENT_SECRET` in `.env`. Social sign-in is shown only when its credentials
and SMTP email delivery are configured. Google must return a verified email;
X does not provide an email, so students enter one during sign-in. New or
unlinked provider identities are connected only after the student confirms
the email AcademicBuddy sends. The confirmation link also signs the student
in. Previously confirmed, linked provider identities can sign in directly.
OAuth identities, short-lived state, and account records are stored in the
same SQLite database as other account data; provider secrets stay in `.env`.

AcademicBuddy includes separate landing, signup, login, and student-home
screens. Students can select one of nine original illustrated profile pictures
when creating an account; that choice is saved to their profile. Its protected
student workspace includes:

- Research search against Crossref scholarly-work metadata. Search results are
  starting points, not endorsements or proof that a work is peer reviewed.
  Search and Source Information offer “Search AcademicBuddy” for Crossref
  records on the site, or “Search Google” for a separate Google tab. Google
  Images also opens separately and sends the query to Google.
  Those records and Wikimedia Commons images are not Google results.
  When Crossref returns no records, the query is sent to Wikipedia to look for
  an optional spelling suggestion; selecting it runs a new search.
  Source Information includes the same formatted search and a Google Scholar
  link; clicking that link sends the query to Google Scholar, while its results
  remain external and are not imported into AcademicBuddy.
- Source details and a student-friendly checklist for evaluating sources.
  Opening a search result shows the search topic, record details, an
  illustrative topic photo when available, and guidance cards. The abstract is
  publisher-provided, not an AI-generated simplification.
  Search results include a high, medium, or low topic-compatibility estimate
  based on keyword overlap with the title, abstract, publication and publisher.
  It is not a measure of accuracy, reliability, or source quality. Cards and
  details show available author, publisher, journal/publication and year; the
  details include a reading-level estimate when the abstract is long enough
  and reminders to check the original work and evidence.
- A private-to-your-account month calendar with color-coded subjects, due
  dates, task editing, completion, and removal. Assessment tasks can specify
  any combination of criteria A, B, C, and D.
- Search results pair Crossref records with topic-related Wikimedia Commons
  images when available; example and “What's new” cards use varied general
  illustrations that may not relate to the records. Images are illustrative,
  not the works' original covers. A placeholder appears if a distinct image is
  unavailable. Each image links to its Commons
  source and license information. Search cards also link to related
  image and video searches. Recent records are not a recommendation or ranking.
- A private grade tracker that asks for each subject's scale (8, 100, or a
  custom whole-number maximum from 1–10,000). Assessment graphs group results
  by criteria A–D and use the selected subject's scale by default. Choose a
  different graph scale to convert mixed scores proportionally for display.
  Original scores remain visible, including older results without a criterion.
  Results can be linked to existing calendar tasks; new results create calendar
  tasks, using an optional date or appearing as unscheduled when omitted.
  Linked scores are visible on calendar entries. Enter a separate score for each
  criterion. Assessments added from Grades appear in the calendar; due-date
  labels show upcoming (green), due today (blue), or overdue (orange), using
  the device's local date. Deleting a task keeps its recorded results. Existing scores without
  a maximum migrate to a 100-point scale.
  Results are entered manually.
- Chat Buddy, a study-coaching assistant that gives concise explanations
  without adding source lists or citations. It can run with local Ollama
  without paid AI API usage, or use a configured OpenAI-compatible service.
  Chat messages are not saved by AcademicBuddy; avoid including personal or
  sensitive information. AI replies can be inaccurate.
- An Our Mission page describing the platform's learning-first approach.

Profile pictures, tasks, and assessment scores are stored in the account's
SQLite database. Source-search terms are sent to Crossref and Wikimedia Commons
for scholarly records and topic-related images. Chat messages are not searched
for sources; they are sent only to the configured AI provider. Review the
provider's data and privacy terms before enabling Chat Buddy for students.

### Run Chat Buddy locally for free

Install Ollama from [ollama.com/download](https://ollama.com/download), then
download the local model once:

```sh
ollama pull qwen2.5:3b
```

Set local mode in `.env`:

```dotenv
AI_PROVIDER=ollama
AI_OLLAMA_URL=http://127.0.0.1:11434/v1/chat/completions
AI_MODEL=qwen2.5:3b
```

Keep the Ollama app running and restart AcademicBuddy with `npm start`. In this
mode AI responses are generated on this computer; AcademicBuddy does not send
them to OpenAI and does not use `AI_API_KEY`. A substantive latest chat question
(up to 200 characters) is sent to Crossref and Wikimedia Commons for topic-matched
references and images; greetings are not searched. The
model runs locally using your computer's memory and processing power; answer
quality may be lower than a larger hosted model.

### Optional hosted AI provider

To use a hosted OpenAI-compatible service instead, set
`AI_PROVIDER=openai-compatible`, `AI_API_URL`, `AI_API_KEY`, and `AI_MODEL` in
`.env`. Hosted providers may charge for API usage. Never paste an API key into
chat, commit it, or expose it in browser code.

## Tests

```sh
npm test
```

The integration test uses a local, in-process SMTP test server and a temporary
SQLite database; it does not contact an external email provider.
