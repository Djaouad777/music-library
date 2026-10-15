# Music Library

Upload songs, send the link to your client, he approves/rejects each one, you download what you need later.

- **Client (no login, just the link)** -> can listen, approve / reject, comment. Cannot upload, edit, delete or use the download button.
- **Admin (secret link `/admin/YOUR_ADMIN_PASSWORD`, open it once per browser)** -> everything: upload (drag & drop), edit title/artist/tags, delete, download, see client comments.

The client opens the normal URL. You open `/admin/<ADMIN_PASSWORD>` once and your browser stays admin.

## Run on your PC
```
npm install
copy .env.example .env     (then edit the passwords)
npm start                  -> http://localhost:3000
```
Files are saved in `./data` when Supabase isn't configured.

## Put it online for free (Supabase storage + Render hosting)
1. **Supabase** (supabase.com, free, no card): create a project. Settings -> API: copy the *Project URL* and the *service_role* key.
   The private bucket `music` is created automatically on first start.
2. Push this folder to a GitHub repo (`.env` and `data` are git-ignored).
3. **Render** (render.com): New -> Web Service -> your repo. Build `npm install`, Start `npm start`, free plan.
   `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `SUPABASE_BUCKET=music`.
4. Send the plain Render URL to your client.

Notes: Render's free plan sleeps after ~15 min idle (first load takes ~30s). Supabase free storage = 1 GB and 50 MB per file
(about 200 MP3s). Songs and approvals live in Supabase, so redeploys don't lose anything.
