# 🛠️ Setup Guide — Python Coach and Practice

Step-by-step instructions to run this app on your own PC. Follow **Section 1** to get
the app running offline (no account, no API key), then **Section 2** only if you want
the AI chat and concept explanations.

---

## 1. Run the app (works 100% offline)

### Step 1 — Install Node.js

Download and install **Node.js 18 or newer** (LTS version is fine):

- https://nodejs.org

To confirm it installed, open a terminal (Windows: press `Win + R`, type `cmd`, Enter)
and run:

```bash
node -v
```

You should see something like `v20.11.0`. Any version `18` or higher works.

### Step 2 — Download the project

**Option A — Git (if you have it installed):**

```bash
git clone https://github.com/adarsh9493/PyPrep-Coach.git
cd PyPrep-Coach
```

**Option B — No Git?** Click the green **Code** button on the GitHub page →
**Download ZIP**, unzip it, then open a terminal **inside** the unzipped folder.

### Step 3 — Install the two dependencies

In the project folder, run:

```bash
npm install
```

This downloads the only two packages the app needs (Express and dotenv). It runs once.

### Step 4 — Start the server

```bash
node server.js
```

You'll see: `✅ PyPrep Coach running at http://localhost:3000`

### Step 5 — Open it in your browser

Go to **http://localhost:3000**

That's it — you now have 16 practice questions, hints, solutions, a Python code runner,
an offline cheat sheet, and a mock interview, all with **no API key**.

> **Tip:** Keep the terminal window open while you use the app. Close it (or press
> `Ctrl + C`) to stop the server.

---

## 2. Turn on AI (optional)

The AI chat and per-question concept explanations need a **free** API key. The app
still runs fine without this — it just falls back to the built-in offline cheat sheet.

### Step 1 — Create your `.env` file

Copy the template in the repo root:

- Windows: copy `.env.example` and rename the copy to `.env`
- Mac/Linux: `cp .env.example .env`

### Step 2 — Get a free key (pick ONE provider)

| Provider | Free? | Get a key at |
| --- | --- | --- |
| **Gemini** (recommended) | Yes, no card needed | https://aistudio.google.com/apikey |
| **Groq** | Yes | https://console.groq.com/keys |
| **OpenRouter** | Yes, free models | https://openrouter.ai/keys |
| **Ollama** | Fully local, no key | https://ollama.com (install, then `ollama pull llama3.1`) |

### Step 3 — Fill in `.env`

For **Gemini** (the easiest):

```
LLM_PROVIDER=gemini
LLM_API_KEY=paste-your-key-here
LLM_MODEL=gemini-3-flash-preview
```

> Your key is read **only** by the backend and is never sent to the browser. The
> `.env` file is git-ignored, so it will **never** be pushed to GitHub.

### Step 4 — Restart the server

Stop the server (`Ctrl + C`) and start it again:

```bash
node server.js
```

The **AI OFFLINE** badge in the top bar should now read **AI ONLINE**.

---

## 3. Double-click launcher (Windows only)

If you're on Windows and don't want to use the terminal, just double-click:

```
Start PyPrep Coach.bat
```

It automatically checks for Node, installs dependencies if needed, starts the server,
and opens your browser. It also reuses a server that's already running.

> Mac/Linux users: use `node server.js` from the terminal (steps 1.4 above).

---

## 4. Change the port (optional)

The app uses port **3000** by default. To change it, add a `PORT` line to `.env`:

```
PORT=8080
```

Then restart. Your app will be at `http://localhost:8080`.

---

## 5. Troubleshooting

| Problem | Fix |
| --- | --- |
| `'node' is not recognized` | Node.js isn't installed, or you opened a new terminal before installing. Reinstall from https://nodejs.org and open a **new** terminal. |
| `EADDRINUSE: address already in use` | Something is already on that port. Stop it with `Ctrl + C`, or set a different `PORT` in `.env`. |
| `npm` is not recognized | Reinstall Node.js — `npm` comes bundled with it. |
| Port 3000 opens but shows an old version | Hard-refresh with `Ctrl + F5`. |
| AI stays "OFFLINE" | Your key or model name is wrong, or the free tier is rate-limited. The offline cheat sheet still works. Double-check `.env` and restart. |
| `Cannot find module` errors | Run `npm install` again inside the project folder. |
| Page looks unstyled | Make sure you started the server from the project root (the folder with `server.js`), so the `public/` files are served. |

---

## 6. What each file does

| File | Purpose |
| --- | --- |
| `server.js` | The backend. Serves the app, runs your code safely, and calls the AI. |
| `public/index.html` | The page layout. |
| `public/styles.css` | All the colors and layout rules. |
| `public/app.js` | The frontend logic — chat, hints, solutions, interview mode. |
| `public/questions.json` | The 16 built-in practice questions. |
| `progress.json` | Saves your history and settings locally (created on first run). |
| `.env` | Your secret API key — **never** commit this. |
| `.env.example` | A safe template to copy into `.env`. |
| `Start PyPrep Coach.bat` | Windows double-click launcher. |

---

## 7. Need help?

Open an issue on GitHub and include:

1. Your operating system (Windows/Mac/Linux)
2. Your Node version (`node -v`)
3. The exact error message, if any

Happy coding! 🐍
