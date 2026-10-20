# Endlessync Backend - Render.com Deployment & Keep-Awake Guide

### Overview
Endlessync backend is designed to run 24/7 on Render's free tier with an automated self-ping mechanism to prevent the server from sleeping.

---

### Step 1: Push & Connect to Render
1. Create a **New Web Service** on [Render.com](https://render.com).
2. Connect your GitHub repository.
3. Configure the service settings:
   - **Environment**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
   - **Plan**: Free

---

### Step 2: Environment Variables (Render Dashboard)
Add the following under **Environment Variables** in Render:
- `PORT`: `3000` (Render will also set this automatically)
- `MONGO_URI`: `mongodb+srv://<username>:<password>@cluster.mongodb.net/endlessync?retryWrites=true&w=majority` (Optional database connection)
- `PING_URL`: `https://your-service-name.onrender.com/ping` (Optional; Render already provides `RENDER_EXTERNAL_URL`, but setting `PING_URL` explicitly guarantees the self-ping hits the right endpoint).

---

### Step 3: Keep It Awake 24/7
The server includes a built-in keep-awake timer (`setInterval` every 4 minutes) that sends a GET request to `/ping`. This prevents Render's free instances from entering the 15-minute inactivity sleep state.

---

### Step 4: Connecting the Endlessync Frontend (Vercel)
In your frontend Vercel project environment variables, add:
```env
NEXT_PUBLIC_BACKEND_URL=https://your-service-name.onrender.com
```
