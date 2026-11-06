# Auction room server

Run the frontend and room server together:

```powershell
cd socket
npm install
npm start
```

Open http://localhost:3000. Create a room with a tournament name, admin password,
and viewer password. In Team Config, add teams, their passwords and purses, then
save. Teams enter the room with their own password and submit players from Player
DB. Viewers enter with the viewer password and can watch bidding and rosters.
Use Copy room link in Team Config to share a room.

Without Firebase credentials, tournament data is saved in
`auction-data.local.json` (excluded from Git). With Firebase configured, the
existing Firestore persistence is used. New rooms start with an empty player pool.

The hosted frontend needs the updated server deployed to its configured
BACKEND_URL in index.html. Local files and IDE previews (such as Live Server on port 5500) also connect to
this backend on port 3000. The backend must be running. When the Node server
serves index.html directly, it uses its own origin, including a custom PORT.

Run `npm test` for the isolated browser and socket integration checks. Tests use
installed Google Chrome and a temporary server on port 3107, and verify room
creation, passwords, team database submissions, viewer access, live bidding,
room isolation, mobile layout, session restore, and restart persistence.


## Render backend status page

Keep the existing Docker service. Set Root Directory to empty, Dockerfile Path
 to `socket/Dockerfile`, and Docker Build Context Directory to `.`. Leave Docker
Command empty and use `/api/health` as the health check path.

On Render (`RENDER=true`), `/` shows the backend status page. `/status` and
`/status.html` also show it in every environment. `/index.html` continues to serve
the auction interface. The frontend can stay on Vercel and connect to this Render
service. The status page checks its own socket connection and HTTP health; it
does not verify the Vercel frontend connection or Firestore reachability.

The Docker image includes `socket/status.html`. Push it together with the updated
Dockerfile and server before deploying. Local file storage inside the container
is temporary unless backed by a persistent disk; keep Firebase configured for
persistent tournament data across redeploys.
