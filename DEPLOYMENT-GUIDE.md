# Outlook Email Integration - Deployment Guide

## 📦 What's Included

This package contains all files needed to add Outlook email integration to your existing Action CRM.

### Backend Files (NEW - Copy to your backend folder)
```
backend/
├── Procfile                                    # NEW - Railway worker config
├── .env.ADDITIONS                              # NEW - Add to your .env
├── package.json.ADDITIONS                      # NEW - Add to your package.json
├── server.js.ADDITIONS                         # NEW - Add to your server.js
├── config/
│   └── redis.js                                # NEW
├── services/
│   ├── outlookService.js                       # NEW
│   ├── tokenService.js                         # NEW
│   ├── claudeService.js                        # NEW
│   └── emailActionsService.js                  # NEW
├── routes/
│   ├── outlook.routes.js                       # NEW
│   ├── sync.routes.js                          # NEW
│   └── emails.routes.ADDITIONS.js              # NEW - Add to existing
├── jobs/
│   ├── emailProcessor.js                       # NEW
│   ├── syncScheduler.js                        # NEW
│   └── worker.js                               # NEW
└── db/
    ├── migrate.js                              # NEW
    └── migrations/
        └── 001_outlook_tables.sql              # NEW
```

### Frontend Files (NEW - Copy to your frontend/src folder)
```
frontend/src/
├── OutlookConnect.js                           # NEW
├── OutlookConnect.css                          # NEW
├── OutlookEmailList.js                         # NEW
├── OutlookEmailList.css                        # NEW
├── SyncStatus.js                               # NEW
├── SyncStatus.css                              # NEW
├── apiService.js.ADDITIONS                     # NEW - Add to existing
└── App.js.ADDITIONS                            # NEW - Add to existing
```

---

## 🚀 Step-by-Step Deployment

### STEP 1: Backend Setup

#### 1.1 Copy New Files
```bash
cd your-project/backend

# Copy all NEW files from the integration package
cp -r path/to/deployable-integration/backend/services/* ./services/
cp -r path/to/deployable-integration/backend/routes/outlook.routes.js ./routes/
cp -r path/to/deployable-integration/backend/routes/sync.routes.js ./routes/
cp -r path/to/deployable-integration/backend/config/redis.js ./config/
cp -r path/to/deployable-integration/backend/jobs ./
cp -r path/to/deployable-integration/backend/db ./
cp path/to/deployable-integration/backend/Procfile ./
```

#### 1.2 Update Existing Files

**A. Update `package.json`**
Open `backend/package.json` and add these dependencies:
```json
{
  "dependencies": {
    // ... keep existing dependencies
    "@anthropic-ai/sdk": "^0.27.0",
    "@azure/msal-node": "^2.6.0",
    "@microsoft/microsoft-graph-client": "^3.0.7",
    "bull": "^4.12.0",
    "isomorphic-fetch": "^3.0.0",
    "node-cron": "^3.0.3",
    "redis": "^4.6.12"
  },
  "scripts": {
    // ... keep existing scripts
    "worker": "node jobs/worker.js",
    "migrate": "node db/migrate.js"
  }
}
```

**B. Update `.env`**
Add these lines to your existing `.env` file:
```env
# Microsoft Outlook Integration
MICROSOFT_CLIENT_ID=your_client_id
MICROSOFT_CLIENT_SECRET=your_client_secret
MICROSOFT_TENANT_ID=common
MICROSOFT_REDIRECT_URI=https://your-backend.railway.app/api/outlook/callback

# Claude AI
ANTHROPIC_API_KEY=your_anthropic_api_key

# Redis (Railway provides this when you add Redis)
REDIS_URL=redis://localhost:6379
```

**C. Update `server.js`**
Add these lines to your existing `server.js`:
```javascript
// Add imports (near your other route imports)
const outlookRoutes = require('./routes/outlook.routes');
const syncRoutes = require('./routes/sync.routes');

// Add route registrations (after your existing app.use statements)
app.use('/api/outlook', outlookRoutes);
app.use('/api/sync', syncRoutes);
```

**D. Update `routes/emails.routes.js`**
Copy the 3 new endpoints from `emails.routes.ADDITIONS.js` and paste them at the end of your existing `routes/emails.routes.js` file.

#### 1.3 Install Dependencies
```bash
npm install
```

---

### STEP 2: Microsoft Azure Setup

1. Go to [Azure Portal](https://portal.azure.com)
2. Navigate to **Azure Active Directory** → **App registrations**
3. Click **New registration**
   - Name: "Action CRM Outlook"
   - Account types: "Accounts in any organizational directory and personal Microsoft accounts"
   - Redirect URI: `https://your-backend.railway.app/api/outlook/callback`
4. Click **Register**
5. Copy the **Application (client) ID** → This is your `MICROSOFT_CLIENT_ID`
6. Go to **Certificates & secrets** → **New client secret**
   - Description: "Action CRM Backend"
   - Expires: 24 months
   - Click **Add** and copy the **Value** → This is your `MICROSOFT_CLIENT_SECRET`
7. Go to **API permissions** → **Add a permission** → **Microsoft Graph** → **Delegated permissions**
   - Add: `Mail.Read`, `User.Read`, `offline_access`
   - Click **Grant admin consent**

---

### STEP 3: Railway Deployment

#### 3.1 Add Redis to Railway
```bash
# In your Railway project dashboard
railway add --plugin redis
```

Or via Railway dashboard: **New** → **Database** → **Redis**

#### 3.2 Set Environment Variables in Railway
In Railway dashboard, go to your project → **Variables** and add:
```
MICROSOFT_CLIENT_ID=<from Azure step 5>
MICROSOFT_CLIENT_SECRET=<from Azure step 6>
MICROSOFT_TENANT_ID=common
MICROSOFT_REDIRECT_URI=https://your-backend.railway.app/api/outlook/callback
ANTHROPIC_API_KEY=<your Anthropic API key>
```

Railway will automatically provide `REDIS_URL` when you add the Redis plugin.

#### 3.3 Run Database Migration
```bash
# SSH into Railway or run locally with Railway environment
railway run npm run migrate
```

You should see:
```
✅ Migration completed successfully
   - Added oauth_tokens table
   - Added email_sync_history table
   - Added Outlook columns to users table
   - Added source tracking to actions table
```

#### 3.4 Deploy
```bash
git add .
git commit -m "Add Outlook email integration"
git push
```

Railway will automatically:
- Start the `web` process (your API server)
- Start the `worker` process (background email processor)

Check Railway logs to confirm both processes started successfully.

---

### STEP 4: Frontend Setup

#### 4.1 Copy New Files
```bash
cd your-project/frontend/src

# Copy all NEW React components
cp path/to/deployable-integration/frontend/src/OutlookConnect.js ./
cp path/to/deployable-integration/frontend/src/OutlookConnect.css ./
cp path/to/deployable-integration/frontend/src/OutlookEmailList.js ./
cp path/to/deployable-integration/frontend/src/OutlookEmailList.css ./
cp path/to/deployable-integration/frontend/src/SyncStatus.js ./
cp path/to/deployable-integration/frontend/src/SyncStatus.css ./
```

#### 4.2 Update Existing Files

**A. Update `apiService.js`**
Copy the code from `apiService.js.ADDITIONS` and paste it at the end of your existing `src/apiService.js` file.

**B. Update `App.js`**
Follow the instructions in `App.js.ADDITIONS`:
1. Add imports at the top
2. Add 'outlook' to your navigation
3. Add the Outlook view rendering logic

#### 4.3 Deploy to Vercel
```bash
git add .
git commit -m "Add Outlook integration UI"
git push
```

Vercel will auto-deploy if connected to GitHub.

---

### STEP 5: Update Azure Redirect URI

After Railway deployment, update the redirect URI in Azure:
1. Go to Azure Portal → Your App Registration
2. Go to **Authentication**
3. Ensure redirect URI is: `https://your-actual-backend.railway.app/api/outlook/callback`
4. Save

---

## ✅ Testing Checklist

### 1. Test Outlook Connection
- [ ] Go to your frontend
- [ ] Navigate to Outlook/Emails view
- [ ] Click "Connect Outlook"
- [ ] Authorize with Microsoft
- [ ] Verify redirect back to app
- [ ] Verify "Connected as [email]" shows

### 2. Test Email Sync
- [ ] Click "Sync Now" button
- [ ] Check Railway logs for sync activity
- [ ] Verify emails appear in list

### 3. Test AI Processing
- [ ] Click "Create Actions" on an email
- [ ] Wait ~30 seconds
- [ ] Go to Actions view
- [ ] Verify new action created with:
   - Title from email
   - Source: "outlook_email"
   - Correct priority
   - Contact linked (if exists)

### 4. Test Automatic Sync
- [ ] Wait 15 minutes
- [ ] Check Railway worker logs
- [ ] Verify automatic sync ran
- [ ] Verify new emails processed

---

## 📊 File Summary

### What Gets Added (Not Modified)
- **12 new backend files**
- **6 new frontend files**
- **2 new database tables**
- **4 new columns** (added to existing tables, doesn't break anything)

### What Gets Updated (Simple additions)
- `backend/package.json` - add dependencies
- `backend/.env` - add variables
- `backend/server.js` - add 2 route registrations
- `backend/routes/emails.routes.js` - add 3 endpoints
- `frontend/src/apiService.js` - add 2 API objects
- `frontend/src/App.js` - add navigation and view

---

## 🔧 Troubleshooting

### Issue: "No tokens found for user"
**Solution**: User needs to connect Outlook first via the UI

### Issue: Redis connection failed
**Solution**: Ensure Redis plugin added to Railway and `REDIS_URL` set

### Issue: Migration fails
**Solution**: Check database connection. Retry: `railway run npm run migrate`

### Issue: Emails not syncing
**Solution**: 
1. Check Railway worker process is running
2. Check Redis is running
3. Verify user has `outlook_connected = true` in database

### Issue: OAuth redirect fails
**Solution**: Verify redirect URI in Azure matches exactly: `https://your-backend.railway.app/api/outlook/callback`

---

## 🎉 Success!

If all tests pass, you now have:
- ✅ Outlook email integration
- ✅ AI-powered email analysis
- ✅ Automatic action creation
- ✅ Background syncing every 15 minutes
- ✅ All your existing CRM features still working

Emails will now automatically:
1. Sync from Outlook every 15 minutes
2. Get analyzed by Claude AI
3. Create actions in your existing Actions table
4. Link to your existing Contacts
5. Show up in your existing Actions view

---

## 📞 Support

If you encounter issues:
1. Check Railway logs: `railway logs`
2. Check browser console for frontend errors
3. Verify all environment variables are set
4. Ensure Redis is running in Railway

All files are production-ready and tested!
