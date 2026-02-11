# Quick Start Checklist - Outlook Integration

## ⚡ 5-Minute Setup

### Backend (10 files to copy)
```bash
cd backend

# Copy new directories
cp -r integration-package/backend/services/*.js ./services/
cp -r integration-package/backend/jobs ./
cp -r integration-package/backend/db ./
cp integration-package/backend/config/redis.js ./config/

# Copy new routes
cp integration-package/backend/routes/outlook.routes.js ./routes/
cp integration-package/backend/routes/sync.routes.js ./routes/

# Copy Procfile
cp integration-package/backend/Procfile ./
```

### Update 4 Existing Files
1. **package.json** - Add 7 dependencies (see .ADDITIONS file)
2. **.env** - Add 5 variables (see .ADDITIONS file)
3. **server.js** - Add 2 lines (see .ADDITIONS file)
4. **routes/emails.routes.js** - Add 3 endpoints (see .ADDITIONS file)

### Frontend (6 files to copy)
```bash
cd frontend/src

# Copy new components
cp integration-package/frontend/src/Outlook*.* ./
cp integration-package/frontend/src/SyncStatus.* ./
```

### Update 2 Existing Files
1. **apiService.js** - Add 2 API objects (see .ADDITIONS file)
2. **App.js** - Add 3 imports + 1 view (see .ADDITIONS file)

## 🔑 External Setup

### 1. Microsoft Azure (5 min)
- Create App Registration
- Add redirect URI: `https://your-backend.railway.app/api/outlook/callback`
- Get Client ID & Secret
- Add permissions: Mail.Read, User.Read

### 2. Anthropic (1 min)
- Get API key from https://console.anthropic.com

### 3. Railway (2 min)
- Add Redis plugin
- Set 5 environment variables
- Run migration: `railway run npm run migrate`

## ✅ Done!

Total time: ~15 minutes
Total files: 16 new + 6 updated
Database changes: 2 new tables (safe, non-breaking)

Deploy and test!
