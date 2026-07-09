# Thomas Wheel of Names

A shareable wheel where anyone with the same wheel URL can rename the wheel, add names, remove names, and spin for a winner.

## Run Locally

```powershell
npm start
```

Open the printed localhost URL. A new wheel ID is created automatically in the `?wheel=` query string.

## Host Online

Run the Node server on any host that supports long-running Node apps, then share the wheel URL. The server stores wheel data in `data/wheels.json` by default.

Useful environment variables:

- `PORT`: server port.
- `DATA_DIR`: directory for persisted wheel data.
- `DATA_FILE`: exact JSON file path for persisted wheel data.

The wheel ID in the URL is the access key. Anyone with that URL can edit that wheel. Use an unguessable generated link for private-ish wheels, or add authentication in front of the app if you need stronger access control.

## Files

- `index.html` contains the app shell.
- `styles.css` contains the responsive interface.
- `app.js` contains wheel drawing, spinning, the winner popup, local fallback, and live API sync.
- `server.js` serves the app, stores wheel data, and streams live updates.
