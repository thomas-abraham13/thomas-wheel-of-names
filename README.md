# Thomas Wheel of Names

A shareable wheel where anyone with the same wheel URL can rename the wheel, add names, remove names, and spin for a winner.

## Run Locally

```powershell
npm start
```

Open the printed localhost URL. A new wheel ID is created automatically in the `?wheel=` query string.

## Tests

```powershell
npm test
```

Uses Node's built-in test runner (Node 22+), with no dependencies to install. `test/wheel-core.test.mjs` covers input validation and the spin maths, including that every spin lands inside the chosen winner's slice. `test/server.test.js` starts the server against a temporary data folder and checks static-file access, every API route, saving to disk, and live updates. GitHub Actions runs the tests on every push to `main` and on pull requests.

## Host on GitHub Pages

Publish `index.html`, `styles.css`, `app.js`, `wheel-core.js`, and `assets/` from the repository root. The GitHub Pages deployment uses Firebase anonymous authentication and Firestore to save and live-sync wheels between browsers. If Firebase is unavailable, it falls back to browser local storage.

### Firestore security rules

`firestore.rules` is the source of truth for the live Firestore rules. Wheels can be opened by ID but not listed, edits are limited to the app's fields and sizes, and wheels cannot be deleted. After changing the file, publish it with the [Firebase CLI](https://firebase.google.com/docs/cli):

```powershell
npx firebase-tools login
npx firebase-tools deploy --only firestore:rules
```

You can also paste the file into the Firebase console (Firestore Database → Rules), but keep this file in sync with the console.

## Host with Live Sync

Run the Node server on any host that supports long-running Node apps, then share the wheel URL. The server stores wheel data in `data/wheels.json` by default.

Useful environment variables:

- `PORT`: server port.
- `DATA_DIR`: directory for persisted wheel data.
- `DATA_FILE`: exact JSON file path for persisted wheel data.

The wheel ID in the URL is the access key. Anyone with that URL can edit that wheel. Use an unguessable generated link for private-ish wheels, or add authentication in front of the app if you need stronger access control.

## Files

- `index.html` contains the app shell.
- `styles.css` contains the responsive interface.
- `app.js` contains wheel drawing, spinning, sounds, the winner popup, local fallback, and live API sync.
- `wheel-core.js` contains the pure logic shared by the app and the tests: input validation and spin maths.
- `server.js` serves the app, stores wheel data, and streams live updates.
- `test/` contains the automated tests.
- `firestore.rules`, `firebase.json`, and `.firebaserc` define and deploy the Firestore security rules.
