# Multi-User 3D Sculpting Application

A real-time collaborative 3D sculpting application where multiple users can sculpt on the same piece of virtual clay simultaneously. Built with Node.js, Socket.IO, Three.js, and PostgreSQL.

## Features

- 🎨 Real-time 3D sculpting with Three.js
- 👥 Multi-user collaboration via WebSockets
- 💾 State persistence with PostgreSQL
- 🔄 Real-time synchronization of sculpting changes
- 🎯 Session-based collaboration rooms

## Local Development

### Prerequisites

- Node.js (v16 or higher)
- PostgreSQL database
- npm or yarn

### Installation

1. Clone the repository:
```bash
git clone <your-repo-url>
cd websockets
```

2. Install dependencies:
```bash
npm install
```

3. Set up your environment variables:
```bash
cp .env.example .env
```

Edit `.env` and add your PostgreSQL connection string:
```
DATABASE_URL=postgresql://user:password@localhost:5432/sculpting_db
```

4. Create a PostgreSQL database:
```bash
createdb sculpting_db
```

5. Start the server:
```bash
npm start
```

For development with auto-reload:
```bash
npm run dev
```

6. Open your browser and navigate to `http://localhost:3000`

## How to Use

1. Enter a session ID (or use the default)
2. Click "Join Session" to connect
3. **Left-click and drag** on the clay to sculpt (push)
4. **Shift + Left-click and drag** to pull the clay inward
5. **Right-click and drag** to rotate the camera view
6. **Mouse wheel** to zoom in/out
7. Multiple users can join the same session ID to collaborate in real-time
8. Click "Reset Clay" to restore the default sphere shape

## Deploying to Render.com (Free Tier)

You'll need to create **TWO services** on Render.com, both using the free tier:
1. A PostgreSQL database (free tier)
2. A Web Service (free tier)

---

### Step 1: Create the PostgreSQL Database (Free Tier)

1. Go to [Render.com](https://render.com) and sign in (or create a free account)
2. Click the **"New +"** button in the top right
3. Select **"PostgreSQL"** from the dropdown
4. Fill in the configuration:
   - **Name**: `multi-user-sculpting-db` (or any name you prefer)
   - **Database**: `sculpting_db` (or leave as default)
   - **User**: Leave as auto-generated
   - **Region**: Choose the region closest to you (e.g., "Oregon (US West)" or "Frankfurt (EU Central)")
   - **PostgreSQL Version**: Latest (or default)
   - **Plan**: **Free** (make sure you select the free tier)
5. Click **"Create Database"**
6. Wait for the database to be created (takes about 1-2 minutes)
7. Once created, go to the database dashboard
8. Look for **"Internal Database URL"** in the connection info section
9. **Copy this Internal Database URL** - you'll need it in the next step
   - It should look something like: `postgresql://user:password@dpg-xxxxx-a/sculpting_db`
   - ⚠️ **Important**: Use the "Internal Database URL", NOT the "External Database URL"

---

### Step 2: Create the Web Service (Free Tier)

1. Still in the Render dashboard, click **"New +"** again
2. Select **"Web Service"**
3. Connect your repository:
   - If using GitHub: Click "Connect account" and authorize Render
   - Select your repository from the list
   - Or use "Public Git repository" and paste your repo URL
4. Configure the service:
   - **Name**: `multi-user-sculpting` (or any name you prefer)
   - **Environment**: **Node**
   - **Region**: **Same region as your database** (very important for free tier!)
   - **Branch**: `main` (or `master`, depending on your repo)
   - **Root Directory**: (leave empty if your files are in the root)
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
   - **Plan**: **Free** (make sure you select the free tier)
5. **Before clicking "Create Web Service"**, scroll down to **"Environment Variables"** section
6. Click **"Add Environment Variable"** and add:
   - **Key**: `DATABASE_URL`
   - **Value**: Paste the **Internal Database URL** you copied from Step 1
   - Click **"Add"**
7. Add another environment variable:
   - **Key**: `NODE_ENV`
   - **Value**: `production`
   - Click **"Add"**
8. Click **"Create Web Service"** at the bottom
9. Wait for the deployment to complete (takes 2-5 minutes for the first build)

---

### Step 3: Access Your Application

1. Once deployment is complete, Render will show you a URL like:
   - `https://multi-user-sculpting.onrender.com`
2. Click on the URL or copy it to share with others
3. **Note**: On the free tier, the first request may take ~30 seconds (service wakes up from sleep)
4. Subsequent requests are much faster while the service is active

---

### Step 4: Important Notes for Render.com Free Tier

#### Database (Free Tier):
- ✅ 1 GB storage (plenty for multiple sessions)
- ✅ Automatic backups (limited retention)
- ✅ Connection pooling included
- ✅ **No credit card required**
- ✅ **Free forever** (as long as you use it)

#### Web Service (Free Tier):
- ⚠️ **Spins down after 15 minutes of inactivity** (sleeps)
- ⏱️ Takes ~30 seconds to wake up when first accessed after sleep
- ✅ 512 MB RAM (sufficient for this application)
- ✅ Free SSL certificate (HTTPS)
- ✅ **No credit card required**
- ✅ **Free forever**

#### Why Use Internal Database URL?
- ✅ **Free communication** between services (no connection limits)
- ✅ **More secure** (services communicate internally)
- ✅ **Faster** (no external network routing)
- ⚠️ **Must be in same region** as your web service
- Internal URLs look like: `postgresql://user:password@dpg-xxxxx-a/sculpting_db`

#### Tips for Free Tier:
- If your service sleeps, the first user to visit will wake it up (others wait ~30 seconds)
- Database never sleeps - it's always available
- Both services must be in the **same region** to use Internal Database URL
- You can upgrade to paid plans anytime if you need better performance

## Architecture

### Server (`server.js`)
- Express.js HTTP server
- Socket.IO for WebSocket connections
- PostgreSQL for state persistence
- Session management
- Real-time vertex update broadcasting

### Client (`public/client.js`)
- Three.js for 3D rendering
- Socket.IO client for real-time communication
- Raycasting for mouse interaction
- Vertex-based sculpting system

### Database Schema
```sql
CREATE TABLE clay_sessions (
  id SERIAL PRIMARY KEY,
  session_id VARCHAR(255) UNIQUE NOT NULL,
  clay_data JSONB NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

## Performance Considerations

- State is saved to database every 2 seconds (to avoid excessive writes)
- Real-time updates are broadcast immediately via WebSocket
- Vertex updates are batched for efficiency
- Consider increasing save frequency for more critical applications

## Troubleshooting

### Database Connection Issues
- Ensure `DATABASE_URL` is correctly set in Render.com environment variables
- Use the Internal Database URL (not external) for Render.com services
- Check that both services are in the same region

### WebSocket Connection Issues
- Verify Socket.IO CORS settings match your domain
- Check that Render.com service is not sleeping (first request wakes it up)

### Sculpting Not Working
- Ensure you're clicking directly on the clay mesh
- Check browser console for errors
- Verify WebSocket connection is established (should see "Connected to server")

## License

MIT

