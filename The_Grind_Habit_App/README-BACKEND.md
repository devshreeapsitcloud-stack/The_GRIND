# The Grind backend

The app now has an optional Node.js backend with SQLite storage. In backend mode, users can create accounts, sign in from another device, and keep their habits and completion history in the server database. The coach uses a local progress-aware reply by default; configure an OpenAI API key to enable generated coaching replies.

## Run it on this computer

1. Install Node.js 22.13 or newer.
2. Open a terminal in the project folder (the folder containing `server.js`).
3. Run `npm start`.
4. Open `http://localhost:3000` in Chrome. Do not open `outputs/index.html` directly when you want the backend.

There are no npm packages to install. The database is created at `data/the-grind.sqlite` the first time the server starts.

## AI coach (optional)

Set `OPENAI_API_KEY` in the server host's environment settings. Optionally set `OPENAI_MODEL`; the default is `gpt-4.1-mini`. Keep the key on the server and do not put it in any HTML or JavaScript file. Without a key, the coach still answers using the user's progress with built-in guidance.

## Hosting

This backend needs a Node.js host, so a static-only Netlify Drop upload will not run the API. A Render Blueprint is included in `render.yaml`: it deploys the app with `npm start`, checks `/api/health`, and mounts a 1 GB persistent disk at `/var/data` for SQLite. Connect the project repository to Render and deploy the Blueprint. Render's current small always-on web service starts at $7/month, and the disk is $0.25 per GB/month; bandwidth beyond the included allowance may add cost. Free Render services cannot attach persistent disks, so they are not appropriate for this SQLite database. See [Render pricing](https://render.com/pricing) and [persistent disk documentation](https://render.com/docs/disks).

Set `OPENAI_API_KEY` in Render's private environment settings only if you want AI-generated coach replies. Keep the key on the server and do not put it in any HTML or JavaScript file.

The app uses SQLite's built-in Node module and requires Node.js 22.13 or newer. The local `file://` pages remain available as a browser-only demo; those pages do not sync accounts or data to the backend.
