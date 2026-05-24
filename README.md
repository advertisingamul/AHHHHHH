# AHHHHHH

Railway-ready deployment wrapper for the Amul Ads Intelligence Dashboard.

## What changed

- Serves `AmulAdsDashboard.html` through a small Node server
- Adds a backend calendar endpoint at `/api/calendar-events`
- Keeps `GOOGLE_CALENDAR_API_KEY` on the server instead of in the browser
- Exposes `/health` for Railway health checks

## Environment variables

- `PORT` — provided automatically by Railway
- `GOOGLE_CALENDAR_API_KEY` — required for festival calendar overlays

## Local run

```bash
npm start
```

Then open:

- `http://localhost:3000`

## Railway deploy

1. Create a new Railway project
2. Connect this repo
3. Add the environment variable:
   - `GOOGLE_CALENDAR_API_KEY`
4. Deploy

The dashboard frontend will call:

- `/api/calendar-events?calendarId=...&year=...`

and the server will proxy that request to Google Calendar securely.
