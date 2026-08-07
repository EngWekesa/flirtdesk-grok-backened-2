FlirtDesk API — deploy to Vercel (free), powered by Groq
=======================================================

This folder is a complete, self-contained Vercel project. No dependencies,
no build step, so it deploys on the Vercel free plan.

It now uses Groq (free tier, open-source models such as Llama 3.3 70B)
instead of Google Gemini. Groq keys start with "gsk_".

What it contains
----------------
  api/replies.js    the drafting endpoint (POST /api/replies)
  api/_rules.js     the ABC Manual 9.0 rules: system prompt + draft checker
  public/index.html a test page served at /
  package.json      marks the code as ESM

Step 1 — get a free Groq API key
--------------------------------
  1. Go to https://console.groq.com/keys and sign in.
  2. Click "Create API Key" and copy the value. It starts with gsk_.
  3. Keep it private. Never put it in the extension files or in GitHub.

Step 2 — deploy this folder
---------------------------
Easiest (no tools to install):
  1. Create a GitHub repo and upload the CONTENTS of this folder
     (so api/ and public/ sit at the repo root).
  2. On vercel.com click "Add New… > Project" and import that repo.
  3. Framework Preset: "Other". Leave build/output settings empty.
  4. Open "Environment Variables" and add:
       Name:  GROQ_API_KEY
       Value: your complete gsk_... key
     Select Production, Preview and Development. No quotes, no spaces.
  5. Deploy.

With the Vercel CLI instead:
     cd this-folder
     npx vercel        # choose "Other"
     npx vercel env add GROQ_API_KEY    # paste the key, select all environments
     npx vercel --prod

If you already deployed the old Gemini version: just add GROQ_API_KEY,
upload these files over the old ones, and redeploy. You can delete
GEMINI_API_KEY; it is no longer used.

Step 3 — check it works
-----------------------
Open your deployment URL in a browser. You should see the FlirtDesk test
page. Paste a short conversation and click "Draft a reply".

If you see "GROQ_API_KEY is not set", the variable is missing from that
deployment:
  1. Open the exact Vercel project whose URL is in the extension options.
  2. Settings > Environment Variables > add GROQ_API_KEY (case-sensitive).
  3. Enable Production, Preview and Development.
  4. Deployments > redeploy the latest one, with build cache off.

Environment variables are captured when a deployment is created, so saving
the variable alone does not update an already-running deployment.

Step 4 — point the extension at it
----------------------------------
  1. Load the extension in Orbita (chrome://extensions > Developer mode >
     Load unpacked).
  2. Right-click the FlirtDesk icon > Options.
  3. Paste your deployment URL, e.g. https://your-project.vercel.app
     and click Save. The extension adds /api/replies itself.

Changing the model
------------------
Default model: llama-3.3-70b-versatile. To use another Groq model, add an
environment variable GROQ_MODEL with the model id from
https://console.groq.com/docs/models and redeploy. If Groq retires a model
you will get a message telling you to set GROQ_MODEL.

Notes
-----
* The free Groq tier is rate limited per minute. Clicking very fast can
  return "Groq rate limited the free tier" — wait a few seconds.
* The endpoint is public. Anyone who learns your URL could use your quota,
  so don't post the URL publicly.
* The rules engine is in api/_rules.js. Edit the FLAGGED list there to add
  or remove banned words, then redeploy.
